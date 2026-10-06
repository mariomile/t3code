import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit, type ThreadToolError } from "./tools.ts";

const projectId = ProjectId.make("project-1");
const callerId = ThreadId.make("caller");

const shell = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: "claude", model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/x",
    worktreePath: "/tmp/worktree",
    latestTurn: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const shells = [
  shell("caller", { title: "Coordinator" }),
  shell("sibling", { hasPendingApprovals: true }),
  shell("done", { settledAt: "2026-10-06T00:00:00.000Z" }),
  shell("archived", { archivedAt: "2026-10-06T00:00:00.000Z" }),
  shell("foreign", { projectId: ProjectId.make("project-2") }),
];

const makeHarness = () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as OrchestrationEngineService["Service"];
  const query = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(shells.find((entry) => entry.id === threadId))),
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence: 1, projects: [], threads: shells, updatedAt: "" }),
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some({
          id: threadId,
          messages: [
            {
              id: "m1",
              role: "assistant",
              text: "Done: PR opened.",
              turnId: null,
              streaming: false,
              createdAt: "2026-10-06T00:00:00.000Z",
              updatedAt: "2026-10-06T00:00:00.000Z",
            },
          ],
        }),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const layer = ThreadsToolkitHandlersLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provide(NodeServices.layer),
  );
  return { dispatched, layer };
};

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: callerId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"]),
  issuedAt: 0,
};

type Harness = ReturnType<typeof makeHarness>;

const call = <Name extends keyof typeof ThreadsToolkit.tools>(
  harness: Harness,
  name: Name,
  params: Parameters<Effect.Success<typeof ThreadsToolkit>["handle"]>[1] & {},
) =>
  ThreadsToolkit.pipe(
    Effect.flatMap((toolkit) =>
      toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    ),
    // Failures become values so tests can assert on the tagged tool error.
    Effect.match({
      onFailure: (error: unknown) => ({ failure: error as ThreadToolError }),
      onSuccess: (output) => output.result as any,
    }),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provide(harness.layer),
  );

it.effect("thread_spawn creates a sibling thread and starts it with the brief", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const { dispatched } = harness;
    const output = yield* call(harness, "thread_spawn", {
      title: "Fix flaky test",
      prompt: "Make the login test deterministic.",
    });
    expect(output.title).toBe("Fix flaky test");
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    const [create, start] = dispatched as [
      Extract<OrchestrationCommand, { type: "thread.create" }>,
      Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ];
    expect(create.projectId).toBe(projectId);
    expect(create.worktreePath).toBe("/tmp/worktree");
    expect(start.threadId).toBe(create.threadId);
    expect(start.message.text).toContain('Spawned by thread "Coordinator" (caller)');
    expect(start.message.text).toContain("Make the login test deterministic.");
  }),
);

it.effect("thread_list scopes to the caller's project and hides archived and settled threads", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const output = yield* call(harness, "thread_list", {});
    const ids = output.threads.map((entry: { threadId: string }) => entry.threadId);
    expect(ids).toEqual(["caller", "sibling"]);
    expect(output.threads[1].status).toBe("needs_user");
    const withSettled = yield* call(harness, "thread_list", { includeSettled: true });
    expect(withSettled.threads).toHaveLength(3);
  }),
);

it.effect("thread_read returns the sibling's latest messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const output = yield* call(harness, "thread_read", { threadId: "sibling" });
    expect(output.messages.map((entry: { text: string }) => entry.text)).toEqual([
      "Done: PR opened.",
    ]);
  }),
);

it.effect("thread_send refuses the caller itself and threads in other projects", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const { dispatched } = harness;
    const self = yield* call(harness, "thread_send", { threadId: "caller", text: "hi" });
    expect(self.failure).toMatchObject({ _tag: "ThreadToolError", reason: "self_target" });
    const foreign = yield* call(harness, "thread_send", { threadId: "foreign", text: "hi" });
    expect(foreign.failure).toMatchObject({ _tag: "ThreadToolError", reason: "other_project" });
    expect(dispatched).toEqual([]);
    const ok = yield* call(harness, "thread_send", { threadId: "sibling", text: "status?" });
    expect(ok).toEqual({ threadId: "sibling" });
    expect(dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
  }),
);
