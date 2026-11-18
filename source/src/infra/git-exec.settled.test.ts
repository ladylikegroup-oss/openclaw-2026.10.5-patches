import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "../agents/worktrees/git.js";
import { removeManagedCheckout } from "../agents/worktrees/removal-git.js";
import * as commandExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";

let cleanupRemoval: (() => Promise<void>) | undefined;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Vitest can start hooks while a timed-out body is still unwinding.
    await cleanupRemoval?.();
    cleanupRemoval = undefined;
    cleanup();
  }),
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("joins admitted recovery despite caller cancellation and the checkout removal deadline", async ({
  signal,
}) => {
  const directory = dirs.make("openclaw-settled-git-");
  const receipts = await openFixtureReceiptChannel();
  const ready = createDeferredCore();
  const controller = new AbortController();
  const run = commandExec.runCommandWithTimeout;
  vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (_argv, options) =>
    run(
      [
        process.execPath,
        "--input-type=module",
        "-e",
        `
        ${fixtureReceiptClientSource(receipts.endpoint)}
        const source = process.argv[1];
        const released = awaitRelease(source, 'settle');
        process.stdout.write('ready\\n');
        await released;
      `,
        directory,
      ],
      {
        ...(typeof options === "number" ? { timeoutMs: options } : options),
        onOutputChunk: () => {
          ready.resolve();
        },
      },
    ),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const removal = withWorktreeGitConfig(directory, false, {}, (git) =>
    removeManagedCheckout(
      {
        id: "fixture",
        name: "fixture",
        repoRoot: directory,
        repoFingerprint: "fixture",
        path: path.join(directory, "fixture"),
        branch: "openclaw/fixture",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      },
      git,
      true,
      "recovery",
      undefined,
      controller.signal,
    ),
  );
  let settled = false;
  void removal
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      vi.useRealTimers();
      try {
        receipts.release(directory, "settle");
        await removal;
      } finally {
        await receipts.close();
      }
    })());
  cleanupRemoval = cleanup;
  const stages: string[] = ["started"];
  try {
    await withinTest(
      Promise.race([
        ready.promise,
        removal.then(() => {
          throw new Error("child exited before admission");
        }),
      ]),
      signal,
    );
    stages.push("ready");
    console.info("git-settled stage: ready");
    controller.abort();
    await withinTest(vi.advanceTimersByTimeAsync(WORKTREE_CHECKOUT_TIMEOUT_MS + 1_000), signal);
    stages.push("clock-advanced");
    console.info("git-settled stage: clock-advanced");
    expect(settled).toBe(false);
    // The deadline proof is complete. Native process/stream settlement must not
    // inherit a stopped fake clock after the fixture receives its release.
    vi.useRealTimers();
    receipts.release(directory, "settle");
    stages.push("release-sent");
    console.info("git-settled stage: release-sent");
    await expect(withinTest(removal, signal)).resolves.toBeUndefined();
    stages.push("removal-settled");
  } finally {
    console.info("git-settled stages:", stages.join(" -> "));
    await cleanup();
  }
});
