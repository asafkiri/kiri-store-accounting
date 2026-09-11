export const cancellationFor = (pending) => ({
  mutationId: pending.body.mutationId,
  entity: pending.path.split("/").slice(0, 2).join("/"),
});

export async function cancelAttempt(ctx, attempt) {
  const result = await ctx.api.request(
    "mutations/" + attempt.mutationId + "/cancel",
    {
      method: "POST",
      body: { entity: attempt.entity },
    },
  );
  if (
    !["cancelled", "committed"].includes(result?.status) ||
    (result.status === "committed" &&
      (!result.record || result.path !== attempt.entity))
  )
    throw Error(
      "לא התקבל אישור ברור על השמירה הקודמת. אפשר לערוך את הטיוטה ולנסות שוב.",
    );
  return result;
}

export function mergeAttemptResult(ctx, result) {
  if (result.status !== "committed") return;
  for (const related of result.relatedRecords || [])
    ctx.mergeRecord(related.record, related.path);
  ctx.mergeRecord(result.record, result.path);
}

// Discarding an editable draft keeps only its unresolved cancellation ID/path,
// never its deleted fields. Reconcile on refresh, without background polling.
export async function settleDiscardedAttempts(ctx, onlyKey = null) {
  const api = ctx.api;
  const keys = onlyKey
    ? [onlyKey]
    : (await ctx.drafts.names()).filter((key) => key.startsWith("cancelled-"));
  const completed = [];
  for (const key of keys) {
    try {
      const attempt = await ctx.drafts.load(key);
      if (!attempt) continue;
      const result = await cancelAttempt(ctx, attempt);
      if (ctx.api !== api) break;
      mergeAttemptResult(ctx, result);
      await ctx.drafts.remove(key);
      completed.push(result.status);
    } catch (error) {
      if (onlyKey) throw error;
      break; // A disconnected server must not trigger a series of retries.
    }
  }
  return completed;
}
