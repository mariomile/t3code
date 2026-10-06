import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Coarse lifecycle an agent coordinating other threads needs to act on:
 * - `running`: a turn (or background work) is in flight; check back later.
 * - `needs_user`: blocked on an approval or a user-input request.
 * - `error`: the last turn or the provider session failed.
 * - `settled`: the thread was marked done.
 * - `idle`: the last turn finished and the thread waits for a new message.
 */
export type ThreadToolStatus = "running" | "needs_user" | "error" | "settled" | "idle";

type StatusShell = Pick<
  OrchestrationThreadShell,
  | "session"
  | "latestTurn"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "settledAt"
  | "settledOverride"
  | "backgroundLiveness"
>;

export function summarizeThreadStatus(shell: StatusShell): ThreadToolStatus {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needs_user";
  if (
    shell.latestTurn?.state === "running" ||
    shell.session?.status === "starting" ||
    shell.session?.status === "running" ||
    shell.backgroundLiveness === "working"
  ) {
    return "running";
  }
  if (shell.latestTurn?.state === "error" || shell.session?.status === "error") return "error";
  if (
    shell.settledOverride === "settled" ||
    (shell.settledAt && shell.settledOverride !== "active")
  ) {
    return "settled";
  }
  return "idle";
}

export interface ThreadToolSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status: ThreadToolStatus;
  readonly currentStep: string | null;
  readonly branch: string | null;
  readonly updatedAt: string;
  readonly isCaller: boolean;
}

export function toThreadToolSummary(
  shell: OrchestrationThreadShell,
  callerThreadId: ThreadId,
): ThreadToolSummary {
  return {
    threadId: shell.id,
    title: shell.title,
    status: summarizeThreadStatus(shell),
    currentStep: shell.planProgress?.step ?? null,
    branch: shell.branch,
    updatedAt: shell.updatedAt,
    isCaller: shell.id === callerThreadId,
  };
}

/** Keeps tool results small: agents only need the tail of a long reply. */
export const MAX_MESSAGE_CHARS = 4_000;

export function recentMessages(
  thread: Pick<OrchestrationThread, "messages">,
  limit: number,
): ReadonlyArray<{ role: OrchestrationMessage["role"]; text: string; createdAt: string }> {
  return thread.messages
    .filter((message) => message.role !== "system" && !message.streaming)
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      text:
        message.text.length > MAX_MESSAGE_CHARS
          ? `…${message.text.slice(-MAX_MESSAGE_CHARS)}`
          : message.text,
      createdAt: message.createdAt,
    }));
}

/**
 * Brief delivered as the spawned thread's first user message. The header
 * tells the child who spawned it so it can report back with `thread_send`.
 */
export function formatSpawnBrief(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly prompt: string;
}): string {
  return [
    `[Spawned by thread "${input.parentTitle}" (${input.parentThreadId}) via thread_spawn.]`,
    "",
    input.prompt,
  ].join("\n");
}
