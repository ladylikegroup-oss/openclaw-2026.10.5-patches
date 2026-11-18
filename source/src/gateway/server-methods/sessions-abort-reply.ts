import {
  isReplyOperationForSession,
  replyRunRegistry,
  resolveReplyOperationsForSession,
} from "../../auto-reply/reply/reply-run-registry.js";

/** Capture startup before queued cancellation can replace or move its reply owner. */
export function captureSessionReplyAbort(
  target: Parameters<typeof resolveReplyOperationsForSession>[0],
  assertCurrent: () => void,
): () => boolean {
  const captured = resolveReplyOperationsForSession(target).map((operation) => ({
    operation,
    key: operation.key,
    sessionId: operation.sessionId,
    agentId: operation.agentId,
  }));
  return () => {
    let cancelled = false;
    for (const owner of captured) {
      assertCurrent();
      const { operation, key, sessionId, agentId } = owner;
      if (
        replyRunRegistry.get(key) === operation &&
        operation.key === key &&
        operation.sessionId === sessionId &&
        operation.agentId === agentId &&
        isReplyOperationForSession(target, operation)
      ) {
        cancelled = operation.abortByUser() || cancelled;
      }
    }
    return cancelled;
  };
}
