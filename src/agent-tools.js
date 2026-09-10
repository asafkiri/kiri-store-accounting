// Optional browser agent support. The visible UI and server remain the sole source of state/authorization.
export function registerAccountingTools(
  ctx,
  registry = globalThis.document?.modelContext,
) {
  if (!registry?.registerTool) return () => {};
  const lifecycle = new AbortController();
  try {
    Promise.resolve(
      registry.registerTool(
        {
          name: "read_unpaid_invoice_summary",
          title: "סיכום החשבוניות הפתוחות",
          description:
            "Read the currently loaded unpaid invoice count and total, after server authorization. Does not pay, edit or scan invoices.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          async execute(input) {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).length
            )
              throw Error("No arguments are accepted");
            if (!ctx.api) throw Error("Sign-in required");
            await ctx.api.request("me");
            const items = ctx.data.invoices.filter(
              (i) => !i.deletedAt && i.status === "unpaid",
            );
            return {
              count: items.length,
              finalAgorot: items.reduce((sum, i) => sum + i.finalAgorot, 0),
              currency: "ILS",
              loadedAt: ctx.lastRefresh || null,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
  } catch {}
  return () => lifecycle.abort();
}
