// One request/response channel to the same-origin image worker. Shared by the
// review screen and the live camera view so a captured frame is processed by
// the worker that already detected it.
export function imageWorker() {
  // The build supplies a content-hashed same-origin asset; source tests use the module.
  const url = new URL(typeof SCAN_WORKER_URL === "undefined" ? "./scan-worker.js" : SCAN_WORKER_URL, import.meta.url);
  const worker = new Worker(url, { type: "module" }), pending = new Map();
  let next = 0, stopped = false;
  const stop = () => {
    stopped = true;
    worker.terminate();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error("Image worker stopped")); }
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    clearTimeout(task.timer); pending.delete(data.id);
    if (data.error) task.reject(Error("Image processing failed"));
    else task.resolve(data.result);
  };
  worker.onerror = worker.onmessageerror = stop;
  return {
    stop,
    get stopped() { return stopped; },
    request(type, data = {}, timeout = 15000) {
      return new Promise((resolve, reject) => {
        if (stopped) { reject(Error("Image worker stopped")); return; }
        const id = ++next;
        const timer = setTimeout(stop, timeout);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ id, type, ...data }, data.image ? [data.image.data.buffer] : []); }
        catch { stop(); }
      });
    },
  };
}
