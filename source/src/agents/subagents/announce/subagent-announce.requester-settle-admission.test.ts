// Preserve the provider fixture before modules that consume model preparation.
// oxfmt-ignore
import { cleanupPreparedModelRuntimeHarness, getPreparedModelRuntimeMocks, resetPreparedModelRuntimeHarness } from "../../prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../config/config.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../gateway/agent-runtime-approval-authority.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  loadGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalog,
} from "../../../gateway/server-model-catalog.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { resolvePreparedRunAdmission } from "../../admitted-run-context.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../prepared-model-runtime.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import * as settleIdentity from "../registry/subagent-requester-settle-identity.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  makeSettledChild,
  transitionBatch,
  completeBatch,
  completeBatchSpy,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<typeof import("../../embedded-agent.js").runEmbeddedAgent>(),
);
// mock-isolation: Only provider execution is substituted; Gateway, preparation and token admission are real.
vi.mock("../../embedded-agent.js", async () => {
  const lifecycle = await import("../../embedded-agent-runner/runs.js");
  const { resolveEmbeddedSessionLane } = await import("../../embedded-agent-runner/lanes.js");
  const { resolveActiveEmbeddedRunSessionId } =
    await import("../../embedded-agent-runner/active-run-projections.js");
  return {
    ...lifecycle,
    resolveActiveEmbeddedRunSessionId,
    resolveEmbeddedSessionLane,
    runEmbeddedAgent,
  } satisfies typeof import("../../embedded-agent.runtime.js");
});

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "settle-admission" });
  await resetPreparedModelRuntimeHarness(state);
  await resetSubagentRegistryForTests({ persist: false });
  runEmbeddedAgent.mockReset();
  completeBatchSpy.mockClear();
});
afterEach(async ({ task }) => {
  await settleSubagentRegistryPersistenceWork();
  const { closeSkillsWatchers } = await import("../../../skills/runtime/refresh.js");
  await closeSkillsWatchers(true);
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

it.each([
  { count: 4, audit: true, legacyReplay: false },
  { count: 5, audit: true, legacyReplay: false },
  { count: 5, audit: false, legacyReplay: false },
  { count: 5, audit: false, legacyReplay: true },
])(
  "admits one real requester wake for $count completed UUID children (audit=$audit, legacy=$legacyReplay)",
  async ({ count, audit, legacyReplay }) => {
    const requesterSessionKey = "agent:main:discord:channel:1000000000000000000";
    const cfg = {
      logging: { audit: { enabled: audit, executionIdentity: audit } },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: state.stateDir,
          systemAgent: { agentId: "main" },
          model: { primary: "custom/test-model" },
        },
        entries: { main: { workspace: state.stateDir } },
      },
      models: {
        mode: "replace",
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            models: [
              {
                id: "test-model",
                name: "Test model",
                input: ["text"],
                maxTokens: 1024,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const prepared = getPreparedModelRuntimeMocks();
    prepared.modelRegistry.fork.mockImplementation((authStorage) =>
      ModelRegistry.inMemory(authStorage),
    );
    const model = {
      api: "openai-completions" as const,
      baseUrl: "https://example.invalid/v1",
      contextWindow: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      id: "test-model",
      input: ["text" as const],
      maxTokens: 1024,
      name: "Test model",
      provider: "custom",
      reasoning: false,
    };
    prepared.configuredAgentIds = ["main"];
    prepared.configuredAgentDirs.set("main", state.agentDir("main"));
    prepared.configuredWorkspaces.set("main", state.stateDir);
    prepared.buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [model],
      routeVariants: [model],
    });
    prepared.loadAgentRuntimePluginRegistryHandle.mockImplementation(
      () => getActivePluginRegistry() ?? createTestRegistry([]),
    );
    const storePath = await writeSubagentSessionEntry({
      stateDir: state.stateDir,
      agentId: "main",
      sessionKey: requesterSessionKey,
      defaultSessionId: "requester-session",
    });
    await refreshPreparedModelRuntimeSnapshots(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: state.stateDir,
    });
    const execution = new AsyncWorkScope();
    const context = createChatAbortContext({
      trackExecution: <T>(run: () => T | Promise<T>) => execution.track(run),
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: vi.fn(),
    }) as unknown as GatewayRequestContext;
    context.resolveGatewayContext = () => context;
    context.addChatRun = context.chatRunState.registry.add;
    context.removeChatRun = context.chatRunState.registry.remove;
    context.loadGatewayModelCatalogSnapshot = (request) =>
      loadGatewayModelCatalogSnapshot({ ...request, getConfig: () => cfg });
    context.loadGatewayModelCatalog = async (request) =>
      (await context.loadGatewayModelCatalogSnapshot(request)).entries;
    context.readPreparedGatewayModelCatalog = (request) =>
      readPreparedGatewayModelCatalog({ ...request, getConfig: () => cfg });
    context.validateAgentRuntimeApprovalAuthority = createAgentRuntimeApprovalAuthorityValidator();
    const methods = createRequestGatewayMethodRegistry();
    let runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => methods,
      isDispatchAvailable: () => true,
    });
    context.createAgentTurnFacade = runtime.createAgentTurnFacade;
    context.recoveryRuntime = runtime.recovery;
    context.getGatewayMethodRegistry = () => methods;
    const admittedRunIds: string[] = [];
    const admissionFailures: string[] = [];
    runEmbeddedAgent.mockImplementation(async (params) => {
      const admitted = await resolvePreparedRunAdmission({
        runId: params.runId,
        runtimeKind: "embedded",
        admittedRunContext: params.admittedRunContext,
        preparedRunAdmission: params.preparedRunAdmission,
      }).catch((error: unknown) => {
        admissionFailures.push(error instanceof Error ? error.message : String(error));
        throw error;
      });
      expect(Boolean(admitted.executionIdentityToken)).toBe(audit);
      admittedRunIds.push(params.runId);
      await params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Consolidated synthetic result." }],
        meta: { durationMs: 1, finalAssistantVisibleText: "Consolidated synthetic result." },
      };
    });
    const batchRunIds = Array.from(
      { length: count },
      (_, i) => "00000000-0000-4000-8000-" + String(i + 1).padStart(12, "0"),
    );
    let children = batchRunIds.map((runId) =>
      makeSettledChild({
        runId,
        requesterSessionKey,
        requesterAgentId: "main",
        requesterStorePath: storePath,
        requesterOrigin: { channel: "webchat" },
        completionRequesterSessionId: "requester-session",
        outcome: { status: "ok" },
        delivery: { status: "delivered", disposition: "delivered" },
        completion: { required: true, resultText: "Synthetic child result", capturedAt: 3000 },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds,
          rearmGeneration: 1,
          requesterYieldBatch: true,
        },
      }),
    );
    for (const entry of children) {
      subagentRuns.set(entry.runId, entry);
      bindGatewayContextResolver(entry, () => context);
    }
    persistRegistryFixture(subagentRuns);
    let publishCompletion = !legacyReplay;
    let emulateLegacy = legacyReplay;
    const publishTransition: typeof transitionBatch = (batch, next, onPublished) => {
      if (emulateLegacy) {
        // The shipped writer did not persist a producer marker.
        delete next.identityVersion;
      }
      transitionBatch(batch, next, onPublished);
      persistRegistryFixture(subagentRuns);
    };
    const canonicalIdentity = settleIdentity.buildRequesterSettleWakeIdentity;
    // Model only the shipped first-attempt producer, not admission or delivery decisions.
    using legacyProducer = legacyReplay
      ? vi
          .spyOn(settleIdentity, "buildRequesterSettleWakeIdentity")
          .mockImplementation((params) => {
            const identity = canonicalIdentity(params);
            return { ...identity, runId: "announce:" + identity.batchKey };
          })
      : undefined;
    const commitCompletion: typeof completeBatch = (...args) => {
      if (publishCompletion) {
        completeBatch(...args);
      }
    };
    try {
      const wake = () =>
        withPluginRuntimeGatewayRequestScope(
          { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
          () =>
            maybeWakeRequesterAfterAllChildrenSettled({
              requesterSessionKey,
              settledEntry: children[0]!,
              isSourceCurrent: () => true,
              transitionBatch: publishTransition,
              completeBatch: commitCompletion,
            }),
        );
      const delivered = await wake();
      expect(admissionFailures).toEqual([]);
      expect(
        delivered,
        JSON.stringify({
          completed: completeBatchSpy.mock.calls,
          states: children.map((entry) => entry.requesterSettleWake),
        }),
      ).toBe(true);
      expect({
        delivered,
        errors: children.map((entry) => entry.requesterSettleWake?.lastError),
      }).toEqual({ delivered: true, errors: Array(count).fill(undefined) });
      expect(admittedRunIds).toHaveLength(1);
      if (legacyReplay) {
        expect(admittedRunIds[0]!.length).toBeGreaterThan(256);
        expect(completeBatchSpy).not.toHaveBeenCalled();
        legacyProducer?.mockRestore();
        emulateLegacy = false;
        publishCompletion = true;
        runtime.close();
        context.dedupe.clear();
        runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => methods,
          isDispatchAvailable: () => true,
        });
        context.createAgentTurnFacade = runtime.createAgentTurnFacade;
        context.recoveryRuntime = runtime.recovery;
        const restored = loadSubagentRegistryFromSqlite();
        children = batchRunIds.map((id) => {
          const entry = restored.get(id);
          if (!entry) {
            throw new Error("Expected the durable legacy cohort");
          }
          expect(entry.requesterSettleWake?.identityVersion).toBeUndefined();
          subagentRuns.set(id, entry);
          bindGatewayContextResolver(entry, () => context);
          return entry;
        });
        // Missing durable final-delivery evidence is still not permission to run again.
        await expect(wake()).resolves.toBe(false);
        expect(admittedRunIds).toHaveLength(1);
      }
      expect(completeBatchSpy).toHaveBeenCalledOnce();
      expect(children.every((entry) => entry.requesterSettleWake === undefined)).toBe(true);
      await expect(wake()).resolves.toBe(false);
      expect(admittedRunIds).toHaveLength(1);
    } finally {
      execution.beginClose();
      await execution.drain();
      runtime.close();
    }
  },
);
