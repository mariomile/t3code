import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ThreadToolError extends Schema.TaggedErrorClass<ThreadToolError>()("ThreadToolError", {
  reason: Schema.Literals(["not_found", "other_project", "self_target", "dispatch_failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const dependencies = [McpInvocationContext.McpInvocationContext];

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const TargetThreadId = described(
  Schema.String,
  "Id of another thread in this project, as returned by thread_list or thread_spawn.",
);

const ThreadStatus = Schema.Literals(["running", "needs_user", "error", "settled", "idle"]);

const ThreadSummary = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  status: ThreadStatus,
  currentStep: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  isCaller: Schema.Boolean,
});

const ThreadMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: Schema.String,
});

export const ThreadSpawnTool = Tool.make("thread_spawn", {
  description:
    "Start a new thread in this project that works on a task in parallel, like delegating to a teammate. The new thread uses this thread's model, runtime mode, branch and worktree, and its first message is your brief. Write the brief as the whole ask: the goal, the context it needs, and what to report back. Returns the new thread's id; check on it with thread_list or thread_read.",
  parameters: Schema.Struct({
    title: described(
      Schema.String,
      "Short name for the thread as it appears in the sidebar, a few words naming what it is about.",
    ),
    prompt: described(
      Schema.String,
      "The brief the new thread receives as its first user message.",
    ),
  }),
  success: Schema.Struct({ threadId: Schema.String, title: Schema.String }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn thread")
  .annotate(Tool.Destructive, false);

export const ThreadListTool = Tool.make("thread_list", {
  description:
    "List the active (non-archived) threads in this project with their status: running, needs_user (waiting on an approval or input), error, settled (done) or idle (finished its turn, waiting for a message). Use it to see what delegated work is still in flight.",
  parameters: Schema.Struct({
    includeSettled: Schema.optional(
      described(Schema.Boolean, "Include threads marked settled (done). Defaults to false."),
    ).annotate({ description: "Include threads marked settled (done). Defaults to false." }),
  }),
  success: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReadTool = Tool.make("thread_read", {
  description:
    "Read the status and the most recent messages of another thread in this project, to collect its result or see where it is stuck. Long messages are truncated to their last 4000 characters.",
  parameters: Schema.Struct({
    threadId: TargetThreadId,
    limit: Schema.optional(
      described(Schema.Number, "How many recent messages to return. Defaults to 4, maximum 20."),
    ).annotate({ description: "How many recent messages to return. Defaults to 4, maximum 20." }),
  }),
  success: Schema.Struct({
    thread: ThreadSummary,
    messages: Schema.Array(ThreadMessage),
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Send a follow-up message to another thread in this project, starting a new turn there. Use it to steer delegated work or, from a spawned thread, to report a result back to the thread that spawned it.",
  parameters: Schema.Struct({
    threadId: TargetThreadId,
    text: described(Schema.String, "The message the target thread receives as a user message."),
  }),
  success: Schema.Struct({ threadId: Schema.String }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message thread")
  .annotate(Tool.Destructive, false);

export const ThreadsToolkit = Toolkit.make(
  ThreadSpawnTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadSendTool,
);
