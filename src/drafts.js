const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error("שמירת הטיוטה נכשלה."));
  });
const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export class Drafts {
  constructor(uid) {
    this.uid = uid;
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  async open() {
    const r = indexedDB.open("kiri-accounting-drafts", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("keys");
      r.result.createObjectStore("drafts");
    };
    this.db = await request(r);
    const read = this.db.transaction("keys");
    let key = await request(read.objectStore("keys").get(this.uid));
    if (!key) {
      const candidate = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const tx = this.db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      key = await request(store.get(this.uid));
      if (!key) {
        key = candidate;
        store.put(key, this.uid);
      }
      await done(tx);
    }
    this.key = key;
  }
  save(name, value) {
    const snapshot = structuredClone(value);
    this.pending++;
    const work = async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        this.key,
        new TextEncoder().encode(JSON.stringify(snapshot)),
      );
      const tx = this.db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({ iv, encrypted }, this.uid + ":" + name);
      await done(tx);
    };
    this.queue = this.queue
      .catch(() => {})
      .then(work)
      .finally(() => {
        this.pending--;
      });
    return this.queue;
  }
  async load(name) {
    await this.queue.catch(() => {});
    const value = await request(
      this.db
        .transaction("drafts")
        .objectStore("drafts")
        .get(this.uid + ":" + name),
    );
    if (!value) return null;
    try {
      return JSON.parse(
        new TextDecoder().decode(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: value.iv },
            this.key,
            value.encrypted,
          ),
        ),
      );
    } catch {
      throw Error("לא ניתן לפתוח את הטיוטה השמורה במכשיר הזה.");
    }
  }
  async remove(name) {
    await this.queue.catch(() => {});
    const tx = this.db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").delete(this.uid + ":" + name);
    await done(tx);
  }
  async names() {
    const keys = await request(
      this.db.transaction("drafts").objectStore("drafts").getAllKeys(),
    );
    return keys
      .filter((k) => k.startsWith(this.uid + ":"))
      .map((k) => k.slice(this.uid.length + 1));
  }
  async clear() {
    await this.queue.catch(() => {});
    const names = await this.names();
    const tx = this.db.transaction(["drafts", "keys"], "readwrite");
    for (const name of names)
      tx.objectStore("drafts").delete(this.uid + ":" + name);
    tx.objectStore("keys").delete(this.uid);
    await done(tx);
  }
}
