import { describe, expect, it } from "vitest";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  registryRuntimeMock,
  sessionStore,
  findTranscriptEventMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  deliverSpy,
  makeSettledChild,
  deliveredCallArg,
  requesterSettleKey,
  transitionBatchSpy,
  completeBatchSpy,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled results", () => {
  it("includes the whole connected drained wave for a staggered fan-out", async () => {
    // A overlaps B and B overlaps C, but A never overlaps C. When C settles
    // last, A's results must still ride the wake and the idempotency key must
    // cover the full component (any last-settler computes the same batch).
    const resultPrefix = "<result>".repeat(700);
    const childA = makeSettledChild({
      runId: "run-a",
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { status: "ok" },
    });
    const childB = makeSettledChild({
      runId: "run-b",
      createdAt: 1_500,
      startedAt: 2_100,
      endedAt: 3_000,
      outcome: { status: "ok" },
    });
    const childC = makeSettledChild({
      runId: "run-c",
      createdAt: 2_500,
      startedAt: 2_500,
      endedAt: 4_000,
      outcome: { status: "ok" },
    });
    const children = [childA, childB, childC];
    const transcripts = new Map<string, unknown[]>();
    const findings = ["alpha findings", "bravo findings", "charlie findings"];
    for (const [index, child] of children.entries()) {
      const text = `${resultPrefix}${findings[index]}`;
      const terminalReply = buildAgentRunTerminalReplySnapshot({ visibleText: text });
      expect(terminalReply.disposition).toBe("visible");
      if (terminalReply.disposition !== "visible") {
        throw new Error("expected visible terminal evidence");
      }
      child.completion = { required: true, terminalReply, resultText: terminalReply.text };
      expect(terminalReply.text).toHaveLength(4_096);
      const sessionId = `session-${child.runId}`;
      sessionStore[child.childSessionKey] = { sessionId };
      const assistant = (runId: string, messageText: string, stopReason = "stop") => ({
        type: "message",
        message: {
          role: "assistant",
          stopReason,
          content: [{ type: "text", text: messageText }],
          __openclaw: { runId },
        },
      });
      transcripts.set(sessionId, [
        assistant("previous-run", "stale previous result"),
        assistant(child.runId, "earlier commentary"),
        assistant(child.runId, text),
        assistant("replacement-run", "unrelated later result"),
        assistant(child.runId, "unfinished follow-up", "toolUse"),
      ]);
    }
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      const event = transcripts
        .get(sessionId)
        ?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: childC }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b,run-c"));
    expect(transitionBatchSpy).toHaveBeenNthCalledWith(1, ["run-a", "run-b", "run-c"], {
      status: "dispatching",
      identityVersion: 1,
      attemptCount: 1,
      deferralCount: 0,
      batchRunIds: ["run-a", "run-b", "run-c"],
    });
    expect(transitionBatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deliverSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    const message = String(call.triggerMessage);
    for (const result of findings) {
      expect(message).toContain(`${"&lt;result&gt;".repeat(700)}${result}`);
    }
    expect(message).not.toContain("stale previous result");
    expect(message).not.toContain("earlier commentary");
    expect(message).not.toContain("unrelated later result");
    expect(message).not.toContain("unfinished follow-up");
    expect(message.indexOf("alpha findings")).toBeLessThan(message.indexOf("bravo findings"));
    expect(message.indexOf("bravo findings")).toBeLessThan(message.indexOf("charlie findings"));
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(
      ["run-a", "run-b", "run-c"],
      undefined,
      { delivered: true, path: "direct" },
    );
  });

  it("includes all six child outcomes when a successful completion has no output", async () => {
    const children = (["ok", "timeout", "timeout", "ok", "timeout", "timeout"] as const).map(
      (status, index) =>
        makeSettledChild({
          runId: `run-${index}`,
          label: `child ${index}`,
          outcome: { status },
          completion:
            index === 3
              ? { required: true, resultText: "blocked fetch" }
              : {
                  required: true,
                  terminalReply: { disposition: "empty" },
                  resultText: null,
                  fallbackResultText: "stale output",
                },
        }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[5] })),
    ).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const message = String(deliveredCallArg().triggerMessage);
    const results = Array.from(
      message.matchAll(
        /Child task[^\n]*\n<prompt-data>\n([^\n]+)\n<\/prompt-data>\nstatus: ([^\n]+)\nChild result[^\n]*\n<prompt-data>\n([^\n]+)\n<\/prompt-data>/g,
      ),
      (match) => match.slice(1),
    );
    expect(results).toEqual([
      ["child 0", "ok", "(no output)"],
      ["child 1", "timeout", "(no output)"],
      ["child 2", "timeout", "(no output)"],
      ["child 3", "ok", "blocked fetch"],
      ["child 4", "timeout", "(no output)"],
      ["child 5", "timeout", "(no output)"],
    ]);
    expect(message).not.toContain("stale output");
  });
});
