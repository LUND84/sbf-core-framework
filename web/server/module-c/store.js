import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function fsyncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = openSync(path, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// One owner and atomic replacements protect both transaction deduplication and payment intents.
// Reason: a second web process or a partial write must never spend the same payment twice.
export class PaymentStore {
  constructor(path, { fsyncDirectory: syncDirectory = fsyncDirectory } = {}) {
    this.path = path; this.lockPath = path + '.lock'; this.fd = null;
    this.unavailable = false; this.fsyncDirectory = syncDirectory;
    mkdirSync(dirname(path), { recursive: true });
    try { this.fd = openSync(this.lockPath, 'wx', 0o600); }
    catch { this.recoverDeadOwner(); }
    writeFileSync(this.fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); fsyncSync(this.fd);
    try {
      this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, orders: [] };
      if (this.data.version !== 1 || !Array.isArray(this.data.orders)
        || this.data.orders.some(o => !o || typeof o.id !== 'string' || !/^[a-f0-9]{64}$/.test(o.id))
        || new Set(this.data.orders.map(o => o.id)).size !== this.data.orders.length) throw new Error('Invalid store');
      if (!existsSync(path)) this.commit(this.data.orders);
    } catch (error) { this.close(); throw new Error('MODULE_C_STORE_INVALID', { cause: error }); }
  }
  recoverDeadOwner() {
    const guardPath = this.lockPath + '.recovery'; let guard;
    try { guard = openSync(guardPath, 'wx', 0o600); }
    catch { throw new Error('MODULE_C_STORE_LOCKED'); }
    try {
      if (existsSync(this.lockPath)) {
        const owner = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('MODULE_C_STORE_LOCKED');
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
        if (!dead) throw new Error('MODULE_C_STORE_LOCKED');
        unlinkSync(this.lockPath);
      }
      this.fd = openSync(this.lockPath, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(guardPath); }
  }
  requireAvailable() {
    if (this.unavailable) throw Object.assign(new Error('MODULE_C_STORE_UNAVAILABLE'), { statusCode: 503 });
  }
  all() { this.requireAvailable(); return this.data.orders.map(o => structuredClone(o)); }
  get(id) { this.requireAvailable(); const o = this.data.orders.find(o => o.id === id); return o ? structuredClone(o) : null; }
  put(order) {
    this.requireAvailable();
    if (this.fd === null) throw new Error('MODULE_C_STORE_CLOSED');
    const orders = this.all(), at = orders.findIndex(o => o.id === order.id);
    if (at < 0) orders.push(structuredClone(order)); else orders[at] = structuredClone(order);
    this.commit(orders); return order;
  }
  commit(orders) {
    this.requireAvailable();
    if (this.fd === null) throw new Error('MODULE_C_STORE_CLOSED');
    const next = { version: 1, orders }, temporary = this.path + '.tmp';
    let renamed = false;
    try {
      const fd = openSync(temporary, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path); renamed = true;
      this.fsyncDirectory(dirname(this.path));
      this.data = next;
    } catch (error) {
      // Rename may already have committed a paid order even if directory durability is uncertain.
      // Reason: stale memory must not overwrite that disk fact or publish an unconfirmed alert.
      if (renamed) {
        this.unavailable = true;
        throw Object.assign(new Error('MODULE_C_STORE_UNAVAILABLE', { cause: error }), { statusCode: 503 });
      }
      throw error;
    }
  }
  close() {
    if (this.fd === null) return;
    closeSync(this.fd); this.fd = null; unlinkSync(this.lockPath);
  }
}
