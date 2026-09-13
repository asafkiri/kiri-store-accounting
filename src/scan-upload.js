// Cloud Run ends the request itself at 60 seconds, so the browser waits past
// that deadline instead of stopping ahead of it: an upload that is still on
// its way is not a connection problem.
export const UPLOAD_TIMEOUT = 70_000;

// The pages of a photographed invoice go up while its details are typed, so
// the waiting happens during work the person has to do anyway. Every caller
// joins the same run: the background start when the questions open, the draft
// that wants the pages for its photograph button, and the save, which is the
// one step that cannot proceed without them. The API accepts a single upload
// at a time, and pages that are already stored are never sent twice.
let queue = Promise.resolve([]);
export function uploadScanPages(ctx, draft = null) {
  const run = async () => {
    const api = ctx.api;
    const scan = draft || (await ctx.drafts.load("scan"));
    if (!scan?.files?.length || scan.attachmentIds?.length)
      return scan?.attachmentIds || [];
    const result = await api.request("documents", {
      method: "POST",
      body: {
        files: scan.files.map(({ name, mime, data }) => ({ name, mime, data })),
      },
      timeout: UPLOAD_TIMEOUT,
    });
    // Signing out mid-upload must not write a stored page into another
    // session's drafts. The pages themselves stay where they are.
    if (ctx.api !== api) return [];
    scan.attachmentIds = result.documents.map((document) => document.id);
    await ctx.drafts.save("scan", scan);
    return scan.attachmentIds;
  };
  queue = queue.then(run, run);
  return queue;
}
