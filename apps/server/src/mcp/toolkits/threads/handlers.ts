import { CommandId, MessageId, type OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { formatSpawnBrief, recentMessages, toThreadToolSummary } from "./status.ts";
import { ThreadsToolkit, ThreadToolError } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const DEFAULT_READ_LIMIT = 4;
const MAX_READ_LIMIT = 20;

export const clampReadLimit = (limit: number | undefined): number =>
  Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_READ_LIMIT)));

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;

    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const commandId = (tag: string) =>
      uuid.pipe(Effect.map((id) => CommandId.make(`mcp:${tag}:${id}`)));

    const fail = (reason: ThreadToolError["reason"], detail: string) =>
      new ThreadToolError({ reason, detail });

    const projectionFailure = (cause: { readonly message: string }) =>
      new ThreadToolError({ reason: "dispatch_failed", detail: cause.message });

    const callerShell = Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const shell = yield* query
        .getThreadShellById(invocation.threadId)
        .pipe(Effect.mapError(projectionFailure));
      if (Option.isNone(shell)) {
        return yield* fail("not_found", "The calling thread no longer exists.");
      }
      return shell.value;
    });

    // Every target must be a different, live thread of the caller's project:
    // the MCP credential is thread-scoped, so cross-project reach would widen it.
    const siblingShell = (rawThreadId: string) =>
      Effect.gen(function* () {
        const caller = yield* callerShell;
        const threadId = ThreadId.make(rawThreadId);
        if (threadId === caller.id) {
          return yield* fail("self_target", "Target a different thread than the caller.");
        }
        const shell = yield* query
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(projectionFailure));
        if (Option.isNone(shell)) {
          return yield* fail("not_found", `No active thread with id ${rawThreadId}.`);
        }
        if (shell.value.projectId !== caller.projectId) {
          return yield* fail(
            "other_project",
            "Threads can only reach threads in their own project.",
          );
        }
        return { caller, target: shell.value };
      });

    // Modes come from a shell the caller already holds: a just-created thread
    // may not be in the projection yet, so the turn must not re-read it.
    const startTurn = (
      target: Pick<OrchestrationThreadShell, "id" | "runtimeMode" | "interactionMode">,
      text: string,
      createdAt: string,
    ) =>
      Effect.gen(function* () {
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: yield* commandId("thread-turn-start"),
            threadId: target.id,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt,
          })
          .pipe(Effect.mapError(projectionFailure));
      });

    return ThreadsToolkit.of({
      thread_spawn: ({ title, prompt }) =>
        Effect.gen(function* () {
          const caller = yield* callerShell;
          const threadId = ThreadId.make(yield* uuid);
          const createdAt = yield* nowIso;
          yield* engine
            .dispatch({
              type: "thread.create",
              commandId: yield* commandId("thread-spawn"),
              threadId,
              projectId: caller.projectId,
              title: title.trim() || "Spawned thread",
              modelSelection: caller.modelSelection,
              runtimeMode: caller.runtimeMode,
              interactionMode: caller.interactionMode,
              branch: caller.branch,
              worktreePath: caller.worktreePath,
              createdAt,
            })
            .pipe(Effect.mapError(projectionFailure));
          yield* startTurn(
            {
              id: threadId,
              runtimeMode: caller.runtimeMode,
              interactionMode: caller.interactionMode,
            },
            formatSpawnBrief({ parentThreadId: caller.id, parentTitle: caller.title, prompt }),
            createdAt,
          );
          return { threadId, title };
        }),

      thread_list: ({ includeSettled }) =>
        Effect.gen(function* () {
          const caller = yield* callerShell;
          const snapshot = yield* query.getShellSnapshot().pipe(Effect.mapError(projectionFailure));
          const threads = snapshot.threads
            .filter((shell) => shell.projectId === caller.projectId && shell.archivedAt === null)
            .map((shell) => toThreadToolSummary(shell, caller.id))
            .filter((summary) => includeSettled === true || summary.status !== "settled");
          return { threads };
        }),

      thread_read: ({ threadId, limit }) =>
        Effect.gen(function* () {
          const { caller, target } = yield* siblingShell(threadId);
          const detail = yield* query
            .getThreadDetailById(target.id)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(detail)) {
            return yield* fail("not_found", `No active thread with id ${threadId}.`);
          }
          return {
            thread: toThreadToolSummary(target, caller.id),
            messages: recentMessages(detail.value, clampReadLimit(limit)),
          };
        }),

      thread_send: ({ threadId, text }) =>
        Effect.gen(function* () {
          const { target } = yield* siblingShell(threadId);
          yield* startTurn(target, text, yield* nowIso);
          return { threadId: target.id };
        }),
    });
  }),
);
