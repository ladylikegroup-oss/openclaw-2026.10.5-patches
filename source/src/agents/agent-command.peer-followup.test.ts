import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { REPLY_WORK_ADMISSION_OWNER } from "../auto-reply/reply/reply-turn-admission-owner.js";
import * as abortSignal from "../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import * as sessionAdmission from "../sessions/session-lifecycle-admission.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

registerAgentCommandCompactionTestHooks();

it.each([
  { phase: "pre-fence", outcome: "completed" },
  { phase: "pre-fence", outcome: "replaced" },
  { phase: "fenced", outcome: "completed" },
  { phase: "fenced", outcome: "replaced" },
  { phase: "pre-fence", outcome: "cancelled" },
  { phase: "fenced", outcome: "cancelled" },
  { phase: "subagent-pre-fence", outcome: "completed" },
  { phase: "internal", outcome: "independent" },
  { phase: "admitted-recovery", outcome: "independent" },
] as const)(
  "preserves reply-owner ordering and exemptions: $phase/$outcome",
  async ({ phase, outcome }) => {
    const sessionKey =
      phase === "subagent-pre-fence"
        ? "agent:main:subagent:peer-receiver"
        : "agent:main:discord:channel:peer-receiver";
    const sessionId = "peer-receiver-session";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
    await compactionTestRuntime.replaceSessionEntry(target, {
      sessionId,
      updatedAt: Date.now(),
      abortedLastRun: false,
      ...(phase === "fenced"
        ? {
            restartRecoveryRuns: [{ runId: "channel-predecessor", lifecycleGeneration }],
            mainRestartRecovery: { cycleId: "reply-cycle", revision: 1, chargedAttempts: 0 },
          }
        : {}),
    });
    const predecessor = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [sessionKey],
      owner: REPLY_WORK_ADMISSION_OWNER,
      assertAllowed() {},
    });
    const waitEntered = createDeferred();
    const replyReleases = new Set<Promise<unknown>>();
    const getOwnerRelease = sessionAdmission.getSessionWorkAdmissionOwnerRelease;
    using ownerObservation = vi
      .spyOn(sessionAdmission, "getSessionWorkAdmissionOwnerRelease")
      .mockImplementation((params) => {
        const pending = getOwnerRelease(params);
        if (pending && params.owner === REPLY_WORK_ADMISSION_OWNER) {
          replyReleases.add(pending);
        }
        return pending;
      });
    const race = abortSignal.racePromiseWithAbortSignal;
    const observeWait: typeof race = (operation, signal, createError) => {
      if (typeof operation !== "function" && replyReleases.has(operation)) {
        waitEntered.resolve();
      }
      return race(operation, signal, createError);
    };
    using waitObservation = vi
      .spyOn(abortSignal, "racePromiseWithAbortSignal")
      .mockImplementation(observeWait);
    state.runAgentAttemptMock.mockResolvedValue(
      makeCompactionResult({ sessionId, text: "peer result processed", runner: "embedded" }),
    );
    const controller = new AbortController();
    const followup = agentCommandFromGatewayIngress(
      {
        sessionKey,
        sessionId,
        runId: "peer-followup",
        abortSignal: controller.signal,
        message: "The synthetic read-only check finished.",
        allowModelOverride: false,
        ...(phase === "internal" ? { sessionEffects: "internal" as const } : {}),
        ...(phase === "admitted-recovery" ? { mainRestartRecoveryAdmitted: true } : {}),
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:channel:peer-source",
          sourceTool: "sessions_send",
        },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    void followup.catch(() => {});
    try {
      if (outcome === "independent") {
        await awaitGateBeforeSettlement(
          followup,
          waitEntered.promise,
          "independent ingress unexpectedly waited for the reply owner",
        );
        expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
        expect(
          getOwnerRelease({
            scope: target.storePath,
            identities: [sessionKey],
            owner: REPLY_WORK_ADMISSION_OWNER,
          }),
        ).toBeDefined();
        return;
      }
      await awaitGateBeforeSettlement(
        waitEntered.promise,
        followup,
        "peer bypassed active reply owner",
      );
      expect(ownerObservation).toHaveBeenCalled();
      expect(waitObservation).toHaveBeenCalled();
      expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
      if (outcome === "cancelled") {
        const before = compactionTestRuntime.loadSessionEntry(target);
        controller.abort();
        await expect(followup).rejects.toMatchObject({ name: "AbortError" });
        expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
        expect(compactionTestRuntime.loadSessionEntry(target)).toEqual(before);
        expect(
          getOwnerRelease({
            ...target,
            identities: [sessionKey],
            scope: target.storePath,
            owner: REPLY_WORK_ADMISSION_OWNER,
          }),
        ).toBeDefined();
        return;
      }
      await compactionTestRuntime.replaceSessionEntry(target, {
        sessionId: outcome === "completed" ? sessionId : "replacement-session",
        updatedAt: Date.now(),
        status: "done",
        abortedLastRun: false,
        restartRecoveryTerminalRunIds: ["channel-predecessor"],
      });
      predecessor.release();
      if (outcome === "replaced") {
        await expect(followup).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
        expect(compactionTestRuntime.loadSessionEntry(target)?.sessionId).toBe(
          "replacement-session",
        );
      } else {
        await followup;
        expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
        expect(compactionTestRuntime.loadSessionEntry(target)?.sessionId).toBe(sessionId);
      }
    } finally {
      predecessor.release();
      await followup.catch(() => {});
    }
  },
);
