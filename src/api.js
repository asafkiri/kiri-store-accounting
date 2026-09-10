export class ApiError extends Error {
  constructor(message, code, status, requestId) {
    super(message);
    Object.assign(this, { code, status, requestId });
  }
}
export class Api {
  constructor(user, fetchImpl = fetch) {
    this.user = user;
    // Native Window.fetch requires its browser receiver. Calling an unbound
    // reference as this.fetch() supplies the Api instance and fails before I/O.
    this.fetch = fetchImpl.bind(globalThis);
  }
  async request(
    path,
    { method = "GET", body, blob = false, timeout = 25_000 } = {},
  ) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeout);
    try {
      const token = await this.user.getIdToken();
      const r = await this.fetch("/api/v1/" + path, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!r.ok) {
        let e;
        try {
          e = (await r.json()).error;
        } catch {}
        throw new ApiError(
          e?.message || "הפעולה לא הושלמה. אפשר לנסות שוב.",
          e?.code || "REQUEST_FAILED",
          r.status,
          e?.requestId,
        );
      }
      return blob ? r.blob() : r.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(
        method === "GET"
          ? "לא התקבלה תשובה מהשרת. בדוק את החיבור ונסה שוב."
          : "אין כרגע אישור מהשרת. הטיוטה נשמרת במכשיר; בדוק חיבור ונסה שוב.",
        "NETWORK",
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  save(pending) {
    return this.request(pending.path, {
      method: pending.method,
      body: pending.body,
    });
  }
}
export function pendingMutation(
  path,
  data,
  expectedVersion = 0,
  method = "PUT",
  extra = {},
) {
  return {
    path,
    method,
    body: {
      expectedVersion,
      mutationId: crypto.randomUUID(),
      ...(data ? { data } : {}),
      ...extra,
    },
  };
}
