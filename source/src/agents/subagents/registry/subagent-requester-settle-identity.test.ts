import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import {
  readSharedBatchState,
  retainedYieldIdentity,
  startRequesterSettleWakeAttempt,
} from "../announce/subagent-announce.requester-settle-state.js";
import {
  makeSettledChild,
  REQUESTER,
} from "../announce/subagent-announce.requester-settle-wake.test-support.js";
import { resetRequesterSettleWakeRetry } from "./subagent-delivery-state.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  buildRequesterSettleWakeIdentity,
  captureRequesterSettleWakeProgress,
  isRequesterSettleWakeForRun,
  resolveCurrentRequesterSettleWakeBatch,
} from "./subagent-requester-settle-identity.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

describe("requester settle wake identity", () => {
  // The control scope must recognize exactly the key dispatch used, or a retried
  // settle turn loses authority over its own children.
  it.each([
    { name: "private batch", yieldedFinalDeliverable: undefined, suffix: false, pause: false },
    {
      name: "deliverable yielded batch",
      yieldedFinalDeliverable: true as const,
      suffix: true,
      pause: false,
    },
    { name: "paused private batch", yieldedFinalDeliverable: undefined, suffix: true, pause: true },
  ])("matches the dispatched retry key: $name", ({ yieldedFinalDeliverable, suffix, pause }) => {
    const entry = makeSettledChild({
      runId: "run-b",
      requesterAgentId: "main",
      completionTarget: "parent",
      ...(pause ? { pauseReason: "sessions_yield" as const } : {}),
      requesterSettleWake: {
        status: "dispatching",
        batchRunIds: ["run-b"],
        rearmGeneration: 1,
        attemptCount: 2,
        ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
        ...(yieldedFinalDeliverable ? { yieldedFinalDeliverable } : {}),
      },
    });
    const dispatched = buildRequesterSettleWakeIdentity({
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      batchRunIds: ["run-b"],
      rearmGeneration: 1,
      attemptIndex: 1,
      sharedAttemptKey: yieldedFinalDeliverable !== true,
      pause,
    }).runId;
    expect(dispatched.endsWith(":retry-1")).toBe(suffix);
    expect(
      isRequesterSettleWakeForRun({
        entry,
        runId: dispatched,
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        runsById: new Map([["run-b", entry]]),
      }),
    ).toBe(true);
  });
});

describe("bounded requester wake IDs", () => {
  it.each([256, 257])("preserves the original %i-character identity or bounds it", (length) => {
    const prefix = "announce:requester-settle:main:" + REQUESTER + ":";
    const child = "x".repeat(length - prefix.length);
    const original = prefix + child;
    const identity = buildRequesterSettleWakeIdentity({
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      batchRunIds: [child],
      identityVersion: 1,
    });
    expect(identity.batchKey).toBe(original.slice("announce:".length));
    expect(identity.runId).toBe(
      length === 256
        ? original
        : "announce:requester-settle:sha256:" + createHash("sha256").update(original).digest("hex"),
    );
    expect(createExecutionIdentityAdmissionToken(identity.runId).runId).toBe(identity.runId);
    if (length === 257) {
      expect(() => createExecutionIdentityAdmissionToken(original)).toThrow("bounded contract");
    }
  });

  it.each(
    [
      { sharedAttemptKey: false, pause: false },
      { sharedAttemptKey: true, pause: false },
      { sharedAttemptKey: true, pause: true },
    ].flatMap((testCase) => [
      { ...testCase, identityVersion: undefined },
      { ...testCase, identityVersion: 1 as const },
    ]),
  )(
    "keeps the persisted long cohort identity: %j",
    ({ sharedAttemptKey, pause, identityVersion }) => {
      const batchRunIds = pause ? ["a".repeat(220)] : ["a".repeat(120), "b".repeat(120)];
      const options = {
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        batchRunIds,
        rearmGeneration: 1,
        attemptIndex: 1,
        sharedAttemptKey,
        pause,
        identityVersion,
      };
      const current = buildRequesterSettleWakeIdentity(options);
      const legacy =
        "announce:" + current.batchKey + (sharedAttemptKey && !pause ? "" : ":retry-1");
      expect(legacy.length).toBeGreaterThan(256);
      const entries = batchRunIds.map((runId) =>
        makeSettledChild({
          runId,
          requesterAgentId: "main",
          ...(sharedAttemptKey ? { completionTarget: "parent" as const } : {}),
          ...(pause ? { pauseReason: "sessions_yield" as const } : {}),
          requesterSettleWake: {
            status: "dispatching",
            attemptCount: 2,
            identityVersion,
            batchRunIds,
            rearmGeneration: 1,
            ...(pause ? { pauseNotice: { acknowledgment: "Waiting." } } : {}),
          },
        }),
      );
      const match = (runId: string) =>
        isRequesterSettleWakeForRun({
          entry: entries[0]!,
          runId,
          requesterSessionKey: REQUESTER,
          requesterAgentId: "main",
          runsById: new Map(entries.map((entry) => [entry.runId, entry])),
        });
      expect(match(current.runId)).toBe(true);
      expect(match(legacy)).toBe(identityVersion === undefined);
      expect(
        buildRequesterSettleWakeIdentity({ ...options, batchRunIds: batchRunIds.toReversed() }),
      ).toEqual(current);
      expect(
        match(buildRequesterSettleWakeIdentity({ ...options, rearmGeneration: 2 }).runId),
      ).toBe(false);
      expect(
        match(
          buildRequesterSettleWakeIdentity({ ...options, batchRunIds: ["c".repeat(220)] }).runId,
        ),
      ).toBe(false);
      const previous = buildRequesterSettleWakeIdentity({ ...options, attemptIndex: 0 });
      expect(match(previous.runId)).toBe(sharedAttemptKey && !pause);
    },
  );
});

describe("requester identity version custody", () => {
  it("admits the marker only for fresh cohorts and retains it through deferral and pause reset", () => {
    const fresh = startRequesterSettleWakeAttempt(
      { status: "pending", attemptCount: 0 },
      ["a"],
      {},
    );
    expect(fresh.identityVersion).toBe(1);
    const row = makeSettledChild({ runId: "a", requesterSettleWake: fresh });
    expect(readSharedBatchState([row]).identityVersion).toBe(1);
    expect(retainedYieldIdentity(fresh).identityVersion).toBe(1);
    expect(resetRequesterSettleWakeRetry(fresh).identityVersion).toBe(1);
    const paused = {
      status: "pending" as const,
      attemptCount: 0,
      pauseNotice: { acknowledgment: "Waiting." },
    };
    expect(startRequesterSettleWakeAttempt(paused, ["a", "b"], {}).identityVersion).toBeUndefined();
    expect(
      startRequesterSettleWakeAttempt({ ...paused, identityVersion: 1 }, ["a", "b"], {})
        .identityVersion,
    ).toBe(1);
    const legacy = startRequesterSettleWakeAttempt(
      { status: "pending", attemptCount: 1 },
      ["a"],
      {},
    );
    expect(legacy.identityVersion).toBeUndefined();
  });

  it("preserves an unknown serialized version and refuses it instead of reminting legacy input", () => {
    const row = makeSettledChild({ runId: "a", completion: { required: true } });
    Object.defineProperty(row.requesterSettleWake!, "identityVersion", {
      value: 9,
      enumerable: true,
    });
    const restored = rowToSubagentRunRecord(bindSubagentRunRecord(row));
    if (!restored) {
      throw new Error("Expected an inspectable canonical row");
    }
    expect(Reflect.get(restored.requesterSettleWake!, "identityVersion")).toBe(9);
    expect(() => readSharedBatchState([restored])).toThrow("Unsupported or mixed");
  });

  it("rejects mixed versions and revokes preparation when the version changes", () => {
    const row = makeSettledChild({
      runId: "a",
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["a"],
        rearmGeneration: 1,
      },
    });
    const clone = copySubagentRunRuntimeOwner(row, structuredClone(row));
    const compare = () =>
      resolveCurrentRequesterSettleWakeBatch({
        observed: [row],
        currentRuns: [clone],
        rearmGeneration: 1,
        pause: false,
        requireUnchangedProgress: true,
      });
    expect(compare()).toBeDefined();
    clone.requesterSettleWake!.identityVersion = 1;
    expect(captureRequesterSettleWakeProgress(clone)).not.toEqual(
      captureRequesterSettleWakeProgress(row),
    );
    expect(compare()).toBeUndefined();
    expect(() => readSharedBatchState([row, clone])).toThrow("Unsupported or mixed");
  });
});
