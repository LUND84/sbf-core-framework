import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, formatUnits, parseUnits } from './policies.js';

export const DEFAULT_TIERS = Object.freeze([
  ['20', 30], ['50', 120], ['100', 300], ['200', 900], ['500', 3600],
  ['1000', 7200], ['10000', 86400],
].map(([price, durationSeconds], i) => Object.freeze({ id: `tier-${i + 1}`, price, durationSeconds })));

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export function priceUnits(value) {
  const units = parseUnits(value, 2);
  if (units < 1n || units > 10000000n) fail('INVALID_PRICING_PRICE');
  return units;
}
export function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length !== 7) fail('INVALID_PRICING_TIERS');
  let previous = 0n;
  return tiers.map((tier, i) => {
    if (!exactKeys(tier, ['id', 'price', 'durationSeconds']) || tier.id !== `tier-${i + 1}`) {
      fail('INVALID_PRICING_TIER');
    }
    const units = priceUnits(tier.price);
    if (units <= previous) fail('PRICING_PRICES_MUST_INCREASE');
    previous = units;
    if (!Number.isSafeInteger(tier.durationSeconds) || tier.durationSeconds < 1 || tier.durationSeconds > 31536000) {
      fail('INVALID_PRICING_DURATION');
    }
    return { id: tier.id, price: formatUnits(units, 2), durationSeconds: tier.durationSeconds };
  });
}
function revision(value) { return Number.isSafeInteger(value) && value >= 1; }

// A separate single writer and fsync/rename keep pricing revisions durable across restarts.
// Reason: changing prices must never partially rewrite the order ledger or lose a successful CAS.
export class PricingStore {
  constructor(path = '') {
    this.path = path; this.fd = null; this.closed = false; this.failed = false;
    this.data = { revision: 1, tiers: structuredClone(DEFAULT_TIERS) };
    if (!path) return;
    this.lockPath = path + '.lock';
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      this.lock();
      if (existsSync(path)) this.data = this.load();
      else this.commit(this.data);
    } catch (error) {
      this.close();
      if (error.message.startsWith('MODULE_C_PRICING_')) throw error;
      throw Object.assign(new Error('MODULE_C_PRICING_INVALID', { cause: error }), { statusCode: 500 });
    }
  }
  lock() {
    try { this.fd = openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let guard;
      try { guard = openSync(this.lockPath + '.recovery', 'wx', 0o600); }
      catch { fail('MODULE_C_PRICING_LOCKED', 503); }
      try {
        if (existsSync(this.lockPath)) {
          let owner;
          try { owner = JSON.parse(readFileSync(this.lockPath, 'utf8')); }
          catch { fail('MODULE_C_PRICING_LOCKED', 503); }
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('MODULE_C_PRICING_LOCKED', 503);
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
          if (!dead) fail('MODULE_C_PRICING_LOCKED', 503);
          unlinkSync(this.lockPath);
        }
        this.fd = openSync(this.lockPath, 'wx', 0o600);
      } finally { closeSync(guard); unlinkSync(this.lockPath + '.recovery'); }
    }
    writeFileSync(this.fd, JSON.stringify({ pid: process.pid })); fsyncSync(this.fd);
  }
  load() {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.size > 16384) fail('MODULE_C_PRICING_INVALID', 500);
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!exactKeys(value, ['version', 'revision', 'tiers']) || value.version !== 1 || !revision(value.revision)) {
      fail('MODULE_C_PRICING_INVALID', 500);
    }
    return { revision: value.revision, tiers: validateTiers(value.tiers) };
  }
  get() {
    if (this.closed) fail('MODULE_C_PRICING_CLOSED', 503);
    if (this.failed) fail('MODULE_C_PRICING_UNAVAILABLE', 503);
    return structuredClone(this.data);
  }
  update(body) {
    this.get();
    if (!this.path || this.fd === null) fail('MODULE_C_PRICING_STORAGE_REQUIRED', 503);
    if (!exactKeys(body, ['expectedRevision', 'tiers']) || !revision(body.expectedRevision)) fail('INVALID_PRICING_UPDATE');
    if (body.expectedRevision !== this.data.revision) fail('PRICING_REVISION_CONFLICT', 409);
    const tiers = validateTiers(body.tiers);
    if (this.data.revision === Number.MAX_SAFE_INTEGER) fail('PRICING_REVISION_EXHAUSTED', 503);
    const next = { revision: this.data.revision + 1, tiers };
    this.commit(next); return this.get();
  }
  commit(next) {
    const temporary = this.path + '.' + randomBytes(12).toString('hex') + '.tmp';
    let fd, renamed = false;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, ...next })); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path); renamed = true;
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.data = structuredClone(next);
    } catch (error) {
      // After rename, an uncertain directory sync must block checkout until restart and disk validation.
      // Reason: serving the old in-memory revision could sell prices different from the durable file.
      if (renamed) this.failed = true;
      throw Object.assign(new Error('MODULE_C_PRICING_WRITE_FAILED', { cause: error }), { statusCode: 503 });
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (!renamed && existsSync(temporary)) unlinkSync(temporary);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; unlinkSync(this.lockPath); }
  }
}
