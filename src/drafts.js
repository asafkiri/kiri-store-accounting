const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || Error("שמירת הטיוטה נכשלה."));
});
const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
export class Drafts {
  constructor(uid) {
    this.uid = uid;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.db = null;
    this.opening = null;
  }
  async open() {
    if (this.db && this.key) return;
    if (this.opening) return this.opening;
    this.opening = this.connect().finally(() => { this.opening = null; });
    return this.opening;
  }
  async connect() {
    const r = indexedDB.open("kiri-accounting-drafts", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("keys");
      r.result.createObjectStore("drafts");
    };
    const db = await request(r);
    this.db = db;
    const invalidate = () => {
      if (this.db === db) { this.db = null; this.key = null; }
    };
    db.onclose = invalidate;
    db.onversionchange = () => { db.close(); invalidate(); };
    try {
      let key = await request(db.transaction("keys").objectStore("keys").get(this.uid));
      if (!key) {
        const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const tx = db.transaction("keys", "readwrite");
        const finished = done(tx);
        const store = tx.objectStore("keys");
        try {
          key = await request(store.get(this.uid));
          if (!key) { key = candidate; store.put(key, this.uid); }
        } catch (error) { await finished.catch(() => {}); throw error; }
        await finished;
      }
      if (this.db !== db) throw new DOMException("Connection closed", "InvalidStateError");
      this.key = key;
    } catch (error) { db.close(); invalidate(); throw error; }
  }
  async withConnection(work) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.open();
        if (!this.db) throw new DOMException("Connection closed", "InvalidStateError");
        return await work();
      }
      catch (error) {
        if (attempt === 1 || !(error?.name === "InvalidStateError" || (error?.name === "AbortError" && !this.db))) throw error;
        // Explicit db.close() does not dispatch close. Retry that case as well.
        this.db?.close(); this.db = null; this.key = null;
      }
    }
  }
  enqueue(work) {
    this.pending++;
    this.queue = this.queue.catch(() => {}).then(() => this.withConnection(work))
      .finally(() => { this.pending--; });
    return this.queue;
  }
  save(name, value) {
    const snapshot = structuredClone(value);
    return this.enqueue(async () => {
      const db = this.db, key = this.key;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
        new TextEncoder().encode(JSON.stringify(snapshot)));
      const tx = db.transaction("drafts", "readwrite"), finished = done(tx);
      tx.objectStore("drafts").put({ iv, encrypted }, this.uid + ":" + name);
      await finished;
    });
  }
  load(name) {
    return this.enqueue(async () => {
      const key = this.key;
      const value = await request(this.db.transaction("drafts").objectStore("drafts").get(this.uid + ":" + name));
      if (!value) return null;
      try {
        return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: value.iv }, key, value.encrypted)));
      } catch { throw Error("לא ניתן לפתוח את הטיוטה השמורה במכשיר הזה."); }
    });
  }
  remove(name) {
    return this.enqueue(async () => {
      const tx = this.db.transaction("drafts", "readwrite"), finished = done(tx);
      tx.objectStore("drafts").delete(this.uid + ":" + name);
      await finished;
    });
  }
  names() {
    return this.enqueue(async () => {
      const keys = await request(this.db.transaction("drafts").objectStore("drafts").getAllKeys());
      return keys.filter(k => k.startsWith(this.uid + ":")).map(k => k.slice(this.uid.length + 1));
    });
  }
  clear() {
    return this.enqueue(async () => {
      const tx = this.db.transaction(["drafts", "keys"], "readwrite"), finished = done(tx);
      try {
        const drafts = tx.objectStore("drafts"), keys = await request(drafts.getAllKeys());
        for (const key of keys) if (key.startsWith(this.uid + ":")) drafts.delete(key);
        tx.objectStore("keys").delete(this.uid);
      } catch (error) { await finished.catch(() => {}); throw error; }
      await finished;
      this.db.close(); this.db = null; this.key = null;
    });
  }
}
