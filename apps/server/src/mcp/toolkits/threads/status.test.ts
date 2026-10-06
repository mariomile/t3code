import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clampReadLimit } from "./handlers.ts";
import {
  formatSpawnBrief,
  MAX_MESSAGE_CHARS,
  recentMessages,
  summarizeThreadStatus,
} from "./status.ts";

const idle = {
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  settledAt: null,
  settledOverride: null,
  backgroundLiveness: null,
} satisfies Parameters<typeof summarizeThreadStatus>[0];

const turn = (state: "running" | "completed" | "error" | "interrupted") => ({
  turnId: "turn-1" as never,
  state,
  requestedAt: "2026-10-06T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

describe("summarizeThreadStatus", () => {
  it("reports idle for a thread with nothing in flight", () => {
    expect(summarizeThreadStatus(idle)).toBe("idle");
  });

  it("prioritizes a pending approval or input over a running turn", () => {
    expect(
      summarizeThreadStatus({ ...idle, latestTurn: turn("running"), hasPendingApprovals: true }),
    ).toBe("needs_user");
    expect(summarizeThreadStatus({ ...idle, hasPendingUserInput: true })).toBe("needs_user");
  });

  it("treats a running turn or live background work as running", () => {
    expect(summarizeThreadStatus({ ...idle, latestTurn: turn("running") })).toBe("running");
    expect(summarizeThreadStatus({ ...idle, backgroundLiveness: "working" })).toBe("running");
  });

  it("surfaces a failed turn as error", () => {
    expect(summarizeThreadStatus({ ...idle, latestTurn: turn("error") })).toBe("error");
  });

  it("honors the settled lifecycle and its active override", () => {
    const settledAt = "2026-10-06T00:00:00.000Z";
    expect(summarizeThreadStatus({ ...idle, settledAt })).toBe("settled");
    expect(summarizeThreadStatus({ ...idle, settledAt, settledOverride: "active" })).toBe("idle");
    expect(summarizeThreadStatus({ ...idle, settledOverride: "settled" })).toBe("settled");
  });
});

describe("recentMessages", () => {
  const message = (role: "user" | "assistant" | "system", text: string, streaming = false) => ({
    id: "m" as never,
    role,
    text,
    turnId: null,
    streaming,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  });

  it("returns the tail, skipping system and still-streaming messages", () => {
    const messages = [
      message("user", "a"),
      message("system", "s"),
      message("assistant", "b"),
      message("assistant", "partial", true),
    ];
    expect(recentMessages({ messages }, 1).map((entry) => entry.text)).toEqual(["b"]);
    expect(recentMessages({ messages }, 5).map((entry) => entry.text)).toEqual(["a", "b"]);
  });

  it("keeps only the end of a long message", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS) + "END";
    const [entry] = recentMessages({ messages: [message("assistant", long)] }, 1);
    expect(entry?.text.endsWith("END")).toBe(true);
    expect(entry?.text.length).toBe(MAX_MESSAGE_CHARS + 1);
  });
});

describe("clampReadLimit", () => {
  it("defaults to 4 and stays within 1..20", () => {
    expect(clampReadLimit(undefined)).toBe(4);
    expect(clampReadLimit(0)).toBe(1);
    expect(clampReadLimit(500)).toBe(20);
  });
});

describe("formatSpawnBrief", () => {
  it("tells the child which thread spawned it", () => {
    const brief = formatSpawnBrief({
      parentThreadId: ThreadId.make("parent-1"),
      parentTitle: "Coordinator",
      prompt: "Fix the flaky test.",
    });
    expect(brief).toContain('"Coordinator" (parent-1)');
    expect(brief.endsWith("Fix the flaky test.")).toBe(true);
  });
});
