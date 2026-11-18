import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AuditWriterRequest } from "../audit/audit-event-writer.types.js";
import { prepareExecutionIdentityContextAtAdmission } from "../audit/execution-identity.test-support.js";
import { insertOperatorApproval } from "../gateway/operator-approval-store.js";
import { listAgentProvenance } from "../state/agent-provenance.js";
import { prepareOpenClawStateDirectReader } from "../state/openclaw-state-db-read-connection.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateReadOnlyDatabase } from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { listProfiles } from "../state/user-profile-reads.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import {
  snapshotFromExecApprovalsDatabase,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const token = {
  tokenVersion: 1 as const,
  createdAt: Date.now(),
  runId: "integrity-run",
  contextId: "integrity-context",
  executionId: "integrity-execution",
};

function fixture() {
  const root = tempDirs.make("openclaw-exec-schema-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const source = openOpenClawStateDatabase({ env });
  writeExecApprovalsConfigRow({
    db: source.db,
    file: { version: 1, defaults: { security: "allowlist", ask: "on-miss" } },
  });
  return { root, env, databasePath: path.join(root, "state", "openclaw.sqlite") };
}

function prepareExec() {
  return commitExecAuthorizationLocked({
    agentId: "main",
    matches: [],
    command: "printf synthetic",
    authorization: {
      source: "current-policy",
      security: "allowlist",
      ask: "on-miss",
      allowlistSatisfied: true,
    },
  });
}

async function audit(env: NodeJS.ProcessEnv, input: AuditWriterRequest) {
  const result = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
    type: "audit.writer.process",
    input,
  });
  expect(result).toEqual({ status: "settled" });
}

type Surface = "roster" | "profiles" | "approval binding" | "message progress" | "message binding";
async function useFeature(surface: Surface, env: NodeJS.ProcessEnv, id: string) {
  if (surface === "roster") {
    expect(await listAgentProvenance({ env })).toEqual([]);
  } else if (surface === "profiles") {
    expect(await listProfiles({ env })).toEqual([]);
  } else if (surface === "approval binding") {
    expect(
      await insertOperatorApproval({
        databaseOptions: { env },
        approval: {
          id,
          kind: "exec",
          presentation: {
            kind: "exec",
            commandText: "printf synthetic",
            commandPreview: "printf synthetic",
            warningText: null,
            host: "gateway",
            nodeId: null,
            agentId: "main",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
          source: { runId: token.runId },
          runtimeEpoch: "integrity-runtime",
          createdAtMs: 1_000,
          expiresAtMs: 10_000,
          executionIdentityToken: token,
        },
      }),
    ).toMatchObject({ outcome: "inserted" });
  } else {
    const common = {
      sourceId: id,
      sourceSequence: 1,
      occurredAt: token.createdAt + 1,
      kind: "message" as const,
      actorType: "agent" as const,
      actorId: "main",
      runId: token.runId,
      direction: "outbound" as const,
      channel: "qa-channel",
      conversationKind: "direct" as const,
    };
    await audit(env, {
      type: "record-event",
      input:
        surface === "message progress"
          ? {
              ...common,
              action: "message.outbound.queued",
              status: "started",
              outcome: "queued",
              resultCount: 0,
            }
          : {
              ...common,
              action: "message.outbound.finished",
              status: "succeeded",
              outcome: "sent",
              resultCount: 1,
              executionIdentityToken: token,
            },
    });
  }
}

it.each<Surface>(["roster", "profiles", "approval binding", "message progress", "message binding"])(
  "keeps prepared exec authority through the first %s operation after reopen",
  async (surface) => {
    const { env } = fixture();
    if (surface === "message binding") {
      prepareExecutionIdentityContextAtAdmission(
        {
          runId: token.runId,
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        {
          env,
          contextId: token.contextId,
          executionId: token.executionId,
          runtimeInstanceId: "integrity-runtime",
          now: token.createdAt,
        },
      );
    }
    await useFeature(surface, env, "prime");
    await closeOpenClawStateDatabaseAsync();
    const source = openOpenClawStateDatabase({ env });
    const before = source.db.prepare("PRAGMA schema_version").get();
    const assertCurrent = await prepareExec();
    expect(assertCurrent).not.toThrow();
    await useFeature(surface, env, "after-authorization");
    expect(source.db.prepare("PRAGMA schema_version").get()).toEqual(before);
    expect(assertCurrent).not.toThrow();
  },
);

it("revokes prepared exec authority when a worker actually creates missing schema", async () => {
  const { env } = fixture();
  const source = openOpenClawStateDatabase({ env });
  source.db.exec("DROP TABLE IF EXISTS agent_provenance");
  const before = source.db.prepare("PRAGMA schema_version").get();
  const assertCurrent = await prepareExec();
  expect(assertCurrent).not.toThrow();
  await listAgentProvenance({ env });
  expect(source.db.prepare("PRAGMA schema_version").get()).not.toEqual(before);
  expect(assertCurrent).toThrow("Direct shared-state reader requires current integrity admission");
});

it.each(["revision mismatch", "missing integrity context", "proof unavailable"] as const)(
  "diagnoses direct-reader integrity refusal: %s without extra atomic loads",
  (reason) => {
    const { env, databasePath } = fixture();
    const context = captureOpenClawStateWorkerContext({ env });
    const integrity = context.stateIntegrity;
    if (!integrity) {
      throw new Error("Fixture did not capture integrity admission");
    }
    const reader = prepareOpenClawStateDirectReader(context);
    const operation = vi.fn(
      ({ db }: OpenClawStateReadOnlyDatabase) =>
        snapshotFromExecApprovalsDatabase(db).file.defaults?.security,
    );
    expect(reader.read(operation)).toBe("allowlist");
    expect(operation).toHaveBeenCalledOnce();
    operation.mockClear();
    context.existingSchemaPath = databasePath;
    Atomics.store(new BigInt64Array(integrity.proof), 0, -1n);
    const observedRevision = integrity.epoch + 1n;
    if (reason === "revision mismatch") {
      Atomics.store(new BigInt64Array(integrity.revision), 0, observedRevision);
    } else if (reason === "missing integrity context") {
      context.stateIntegrity = undefined;
    }
    const loads = vi.spyOn(Atomics, "load");
    try {
      const detail =
        reason === "revision mismatch"
          ? `revision mismatch (capturedEpoch=${integrity.epoch}, observedRevision=${observedRevision})`
          : reason;
      expect(() => reader.read(operation)).toThrowError(
        new Error(`Direct shared-state reader requires current integrity admission: ${detail}`),
      );
      expect(operation).not.toHaveBeenCalled();
      expect(
        loads.mock.calls
          .filter(([view]) => view.buffer === integrity.revision || view.buffer === integrity.proof)
          .map(([view, index]) => [
            view.buffer === integrity.revision ? "revision" : "proof",
            index,
          ]),
      ).toEqual(
        reason === "missing integrity context"
          ? []
          : reason === "revision mismatch"
            ? [["revision", 0]]
            : [
                ["revision", 0],
                ["proof", 0],
              ],
      );
    } finally {
      loads.mockRestore();
    }
  },
);
