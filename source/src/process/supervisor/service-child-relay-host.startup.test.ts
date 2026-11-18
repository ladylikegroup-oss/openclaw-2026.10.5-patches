import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import { encodeServiceChildMessage } from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createWritableRelayChild } from "./service-child-relay-host.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

afterEach(() => {
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

it("joins failed POSIX startup cleanup before returning the original executable error", async () => {
  mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  const groupProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
  });
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: "/synthetic-missing-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  let settled = false;
  const result = ready.catch((error: unknown) => {
    settled = true;
    return error;
  });
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected the admitted service generation");
  }
  const generation = start.generation;
  try {
    stub.control.push(
      encodeServiceChildMessage({
        type: "startup-error",
        generation,
        sequence: 1,
        anchorPid: 1235,
        error: "spawn /synthetic-missing-command ENOENT",
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(stub.killMock).not.toHaveBeenCalled();

    stub.control.push(
      encodeServiceChildMessage({
        type: "closing",
        reason: "lineage-lost",
        generation,
        sequence: 2,
      }),
    );
    stub.control.push(null);
    stub.stdout.end();
    stub.stderr.end();
    stub.lineage.end();
    stub.disconnectMock();
    stub.emitExit(0);

    expect(await result).toMatchObject({
      message: "spawn /synthetic-missing-command ENOENT",
    });
    await expect(adapter.waitForExtinction()).resolves.toBeUndefined();
    expect(groupProbe).toHaveBeenCalledWith(-1235, 0);
  } finally {
    stub.control.destroy();
    stub.lineage.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
    await result;
    await adapter.waitForExtinction().catch(() => undefined);
    adapter.dispose();
  }
});

it.each([
  "before-launch",
  "undefined-refusal",
  "after-launch",
  "transport-failure",
  "cancel-failure",
] as const)("preserves the cleanup outcome for deferred launch failure: %s", async (failure) => {
  mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
  });
  const refusal =
    failure === "undefined-refusal" ? undefined : new Error("synthetic launch policy refused");
  const cancelSent = createDeferred();
  const startupAcknowledged = createDeferred();
  const closingAcknowledged = createDeferred();
  const frames: string[] = [];
  vi.spyOn(stub.control, "_write").mockImplementation((chunk, _encoding, callback) => {
    const message: unknown = JSON.parse(String(chunk));
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new Error("Expected a control frame");
    }
    frames.push(message.type);
    if (message.type === "cancel") {
      cancelSent.resolve();
      if (failure === "cancel-failure") {
        callback(new Error("synthetic cancel transport failure"));
        return;
      }
    }
    if (message.type === "startup-error-ack") {
      startupAcknowledged.resolve();
    }
    if (message.type === "closing-ack") {
      closingAcknowledged.resolve();
    }
    if (message.type === "launch" && failure === "transport-failure") {
      callback(new Error("synthetic launch transport failure"));
      return;
    }
    callback();
  });
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: "/synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
    initiateSpawn: (launch) => {
      if (failure === "transport-failure") {
        return launch();
      }
      if (failure === "after-launch") {
        launch();
      }
      // oxlint-disable-next-line typescript/only-throw-error -- Exercise an undefined refusal at the real launch boundary.
      throw refusal;
    },
  });
  const result = ready.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  let readinessSettled = false;
  void result.then(() => {
    readinessSettled = true;
  });
  const cleanup = adapter.waitForExtinction();
  void cleanup.catch(() => undefined);
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected the admitted service generation");
  }
  const generation = start.generation;
  let cleanupSettled = false;
  void cleanup.then(
    () => {
      cleanupSettled = true;
    },
    () => {
      cleanupSettled = true;
    },
  );
  try {
    stub.control.push(encodeServiceChildMessage({ type: "prepared", generation, sequence: 1 }));
    if (failure === "before-launch" || failure === "undefined-refusal") {
      await awaitGateBeforeSettlement(cancelSent.promise, result, "refusal lost cleanup custody");
      expect(frames).toEqual(["cancel"]);
      expect(cleanupSettled).toBe(false);
      expect(readinessSettled).toBe(false);
      stub.control.push(encodeServiceChildMessage({ type: "prepared", generation, sequence: 2 }));
      stub.control.push(
        encodeServiceChildMessage({
          type: "startup-error",
          generation,
          sequence: 3,
          anchorPid: 1235,
          error: "command startup cancelled before spawn",
        }),
      );
      await awaitGateBeforeSettlement(
        startupAcknowledged.promise,
        result,
        "cleanup skipped receipt",
      );
      expect(cleanupSettled).toBe(false);
      stub.control.push(
        encodeServiceChildMessage({
          type: "closing",
          reason: "cancel",
          generation,
          sequence: 4,
        }),
      );
      await awaitGateBeforeSettlement(
        closingAcknowledged.promise,
        result,
        "cleanup skipped extinction",
      );
      expect(cleanupSettled).toBe(false);
      expect(readinessSettled).toBe(false);
      stub.control.push(null);
      stub.stdout.end();
      stub.stderr.end();
      stub.lineage.end();
      stub.disconnectMock();
      stub.emitExit(0);
      const outcome = await result;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Refused launch reported startup success");
      }
      if (failure === "undefined-refusal") {
        expect(outcome.error).toMatchObject({ message: "service child launch admission refused" });
      } else {
        expect(outcome.error).toBe(refusal);
      }
      await expect(cleanup).resolves.toBeUndefined();
      expect(frames).toEqual(["cancel", "startup-error-ack", "closing-ack"]);
    } else {
      expect(await result).toMatchObject({ status: "rejected", error: expect.any(Error) });
      await expect(cleanup).rejects.toThrow("service child cleanup identity lost");
      expect(frames).toEqual([failure === "cancel-failure" ? "cancel" : "launch"]);
    }
  } finally {
    stub.control.destroy();
    stub.lineage.destroy();
    stub.stdout.end();
    stub.stderr.end();
    stub.disconnectMock();
    stub.emitExit(0);
    await result;
    await cleanup.catch(() => undefined);
    adapter.dispose();
  }
});
