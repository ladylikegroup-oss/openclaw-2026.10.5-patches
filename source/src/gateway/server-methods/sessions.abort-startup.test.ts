/** Scoped Stop must reach channel startup before an embedded handle exists. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();
const sessionKey = "agent:main:direct:startup-stop";
const sessionId = "startup-stop-session";

async function setup() {
  const client = roleClient("view", "startup-stop-owner");
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  await sessions.upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      createdActor: {
        type: "human",
        source: "profile",
        id: client.authenticatedUserProfile!.profileId,
      },
    },
  );
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const stop = async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "startup-stop",
        method: "sessions.abort",
        params: { key: sessionKey, clearQueued: false },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
    });
    return respond;
  };
  return { client, context, stop };
}

it.each(["matched", "old-incarnation", "foreign-key", "foreign-agent", "finalizing"] as const)(
  "scoped Stop cancels only its admitted reply-only startup (%s)",
  async (target) => {
    const { stop } = await setup();
    const operation = createReplyOperation({
      sessionKey: target === "foreign-key" ? "agent:main:direct:other" : sessionKey,
      sessionId: target === "old-incarnation" ? "old-startup-session" : sessionId,
      agentId: target === "foreign-agent" ? "other" : "main",
      resetTriggered: false,
    });
    const peer = createReplyOperation({
      sessionKey: "agent:main:direct:healthy-peer",
      sessionId: "healthy-peer-session",
      agentId: "main",
      resetTriggered: false,
    });
    if (target === "finalizing") {
      operation.freezeAbort();
    }
    try {
      const respond = await stop();
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        {
          ok: true,
          abortedRunId: null,
          status: target === "matched" ? "aborted" : "no-active-run",
        },
      ]);
      expect(operation.abortSignal.aborted).toBe(target === "matched");
      expect(peer.abortSignal.aborted).toBe(false);
    } finally {
      operation.complete();
      peer.complete();
    }
  },
);

it.each(["replacement", "rebound"])(
  "scoped Stop does not cancel a %s reply after queued cancellation",
  async (change) => {
    const { client, context, stop } = await setup();
    const original = createReplyOperation({
      sessionKey,
      sessionId,
      agentId: "main",
      resetTriggered: false,
    });
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const queued = createActiveRun(sessionKey, {
      sessionId,
      agentId: "main",
      owner: { connId: client.connId },
    });
    context.chatQueuedTurns.set("original-queued", queued);
    queued.controller.signal.addEventListener(
      "abort",
      () => {
        if (change === "rebound") {
          original.updateSessionId("new-startup-session");
          return;
        }
        original.complete();
        replacement = createReplyOperation({
          sessionKey,
          sessionId,
          agentId: "main",
          resetTriggered: false,
        });
      },
      { once: true },
    );
    try {
      await stop();
      expect(queued.controller.signal.aborted).toBe(true);
      if (change === "replacement") {
        expect(replacement).toBeDefined();
        expect(replacement!.abortSignal.aborted).toBe(false);
      } else {
        expect(original.sessionId).toBe("new-startup-session");
        expect(original.abortSignal.aborted).toBe(false);
      }
    } finally {
      original.complete();
      replacement?.complete();
    }
  },
);
