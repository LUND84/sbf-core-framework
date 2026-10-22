import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { PreparedClip } from './prepared-clip.js';
import { mediaError } from './local-fmp4.js';
import { trustPreparedStreamBlock } from './stream-playout.js';

const MAX_BYTES = 8 * 1024 * 1024, ID = /^[A-Za-z0-9_-]{1,80}$/;
const codeOf = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'STREAM_VALIDATOR_FAILED';
function need(value, code) { if (!value) throw mediaError(code); }

class PreparedStreamBlock {
  #clip; #relative;
  constructor(value) {
    this.#clip = new PreparedClip(value.descriptor);
    need(this.#clip.fragmentCount === 1 && Number.isInteger(value.index) && value.index >= 0
      && value.index < 225 && Array.isArray(value.relativeStartTicks), 'STREAM_VALIDATOR_DESCRIPTOR');
    this.#relative = new Map(value.relativeStartTicks);
    this.index = value.index; this.durationSeconds = this.#clip.durationSeconds;
    this.mime = this.#clip.mime; this.tracks = this.#clip.tracks;
    this.compatibilitySignature = this.#clip.compatibilitySignature;
    this.byteLength = value.descriptor.parts[0].data.byteLength;
    need(value.receipt?.video_samples === 16 && value.receipt?.audio_samples === 25
      && value.receipt.video_sample_sha256?.length === 16 && value.receipt.audio_sample_sha256?.length === 25,
    'STREAM_VALIDATOR_RECEIPT');
    this.receipt = Object.freeze({ ...value.receipt,
      video_sample_sha256: Object.freeze([...value.receipt.video_sample_sha256]),
      audio_sample_sha256: Object.freeze([...value.receipt.audio_sample_sha256]) });
    // Brand only this owned-thread hydration lane. Reason: main-thread metadata hydration must neither reparse samples nor trust a network duck type.
    trustPreparedStreamBlock(this);
  }
  get init() { return this.#clip.init; }
  get relativeStartTicks() { return new Map(this.#relative); }
  rewrite(sequence, utteranceBases) {
    const starts = new Map(this.tracks.map(track => {
      const base = utteranceBases?.get(track.id), relative = this.#relative.get(track.id);
      need(typeof base === 'bigint' && base >= 0n && typeof relative === 'bigint', 'STREAM_TRACK_BASE');
      return [track.id, base + relative];
    }));
    return this.#clip.rewrite(0, sequence, starts);
  }
}

export class StreamValidator {
  #worker = null; #factory; #ready = false; #closed = false; #retry = null;
  #initialResolve; #initialReject; #initialSettled = false;
  #contexts = new Map(); #active = null; #pending = []; #bytes = 0; #serial = 0; #clock;
  constructor({ createWorker = () => new Worker(new URL('./stream-validator-worker.js', import.meta.url)),
    clock = () => performance.now() } = {}) {
    this.#factory = createWorker; this.#clock = clock;
    this.ready = new Promise((resolve, reject) => { this.#initialResolve = resolve; this.#initialReject = reject; });
    void this.ready.catch(() => {}); this.#spawn();
  }
  #stamp() {
    try { const value = this.#clock(); return Number.isFinite(value) && value >= 0 ? value : null; }
    catch { return null; }
  }
  #timing(job, receivedAt, workerExecuteMs) {
    const elapsed = (start, end) => start !== null && end !== null && end >= start ? end - start : null;
    const hydratedAt = this.#stamp();
    // Worker execution alone omits queueing, transfer and main-thread hydration.
    // Reason: separating these same-process durations avoids attributing every ACK delay to media validation.
    return { transferCopyMs: elapsed(job.copyStartedAt, job.queuedAt), queueMs: elapsed(job.queuedAt, job.dispatchedAt),
      workerRoundTripMs: elapsed(job.dispatchedAt, receivedAt), workerExecuteMs,
      hydrationMs: elapsed(receivedAt, hydratedAt), totalMs: elapsed(job.copyStartedAt, hydratedAt) };
  }
  #spawn() {
    if (this.#closed) return;
    let worker;
    try { worker = this.#factory(); } catch { this.#scheduleRetry(); return; }
    this.#worker = worker; this.#ready = false;
    worker.on('message', message => {
      if (this.#worker !== worker || this.#closed) return;
      if (message?.type === 'ready') {
        this.#ready = true;
        if (!this.#initialSettled) { this.#initialSettled = true; this.#initialResolve(); }
        this.#drive(); return;
      }
      this.#receive(worker, message);
    });
    worker.once('error', () => this.#lost(worker, 'STREAM_VALIDATOR_EXIT'));
    worker.once('exit', () => this.#lost(worker, 'STREAM_VALIDATOR_EXIT'));
  }
  #scheduleRetry() {
    // One owned backoff, never a busy recovery loop. Reason: an import/runtime fault must not consume the independent playout thread.
    if (!this.#closed && this.#retry === null) {
      this.#retry = setTimeout(() => { this.#retry = null; this.#spawn(); }, 250); this.#retry.unref();
    }
  }
  #settle(job, error, value) {
    if (job.settled) return;
    job.settled = true; if (error) job.reject(error); else job.resolve(value);
  }
  #lost(worker, code) {
    if (this.#worker !== worker) return;
    this.#worker = null; this.#ready = false;
    for (const job of [this.#active, ...this.#pending]) if (job) this.#settle(job, mediaError(code));
    this.#active = null; this.#pending = []; this.#bytes = 0;
    for (const context of this.#contexts.values()) context.cancelReject?.(mediaError(code));
    this.#contexts.clear(); worker.removeAllListeners(); worker.on('error', () => {});
    void worker.terminate().catch(() => {}); this.#scheduleRetry();
  }
  #queuedError() {
    if (this.#closed) return 'STREAM_VALIDATOR_CLOSED';
    if (!this.#worker || !this.#ready) return 'STREAM_VALIDATOR_NOT_READY';
    if (this.#active && this.#pending.length >= 4) return 'STREAM_VALIDATOR_BUSY';
    return null;
  }
  #admit(bytes) {
    const error = this.#queuedError(); if (error) throw mediaError(error);
    need(this.#bytes + bytes <= MAX_BYTES, 'STREAM_VALIDATOR_BYTES');
  }
  #enqueue(op, id, data = null, meta = null, seq = null) {
    const bytes = data?.byteLength ?? 0;
    this.#admit(bytes);
    // Copy once into a fresh transfer buffer, never detach caller/pool storage.
    // Reason: a WS Buffer slice may share its ArrayBuffer with another complete media message.
    const copyStartedAt = this.#stamp(), owned = data === null ? null : Uint8Array.from(data), queuedAt = this.#stamp();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const job = { op, id, seq, data: owned, meta, bytes, serial: ++this.#serial, resolve, reject, settled: false,
      copyStartedAt, queuedAt, dispatchedAt: null };
    this.#bytes += bytes; this.#pending.push(job); this.#drive(); return promise;
  }
  #drive() {
    if (this.#closed || !this.#ready || !this.#worker || this.#active) return;
    const retire = [...this.#contexts].find(([, value]) => value.cancelRequested && !value.cancelSent);
    let job;
    if (retire) {
      const [id, context] = retire; context.cancelSent = true;
      // Cancellation is a bounded per-context intent, not another media queue.
      // Reason: cleanup must take priority after the active operation without displacing unrelated requests or growing beyond two contexts.
      job = { op: 'cancel', id, serial: ++this.#serial, bytes: 0, data: null,
        resolve() {}, reject() {}, settled: false };
    } else job = this.#pending.shift();
    if (!job) { this.#worker.unref(); return; }
    this.#active = job; this.#worker.ref();
    job.dispatchedAt = this.#stamp();
    const data = job.data; job.data = null;
    try { this.#worker.postMessage({ op: job.op, id: job.id, seq: job.seq, meta: job.meta,
      serial: job.serial, data }, data ? [data.buffer] : []); }
    catch { this.#lost(this.#worker, 'STREAM_VALIDATOR_TRANSFER'); }
  }
  #drop(id, code) {
    const context = this.#contexts.get(id); this.#contexts.delete(id);
    this.#pending = this.#pending.filter(job => {
      if (job.id !== id) return true;
      this.#bytes -= job.bytes; this.#settle(job, mediaError(code)); return false;
    });
    context?.cancelResolve?.(true);
  }
  #receive(worker, message) {
    const receivedAt = this.#stamp();
    const job = this.#active;
    if (!job || message?.type !== 'result' || message.serial !== job.serial || message.id !== job.id || message.op !== job.op) {
      this.#lost(worker, 'STREAM_VALIDATOR_PROTOCOL'); return;
    }
    this.#active = null; this.#bytes -= job.bytes;
    const context = this.#contexts.get(job.id);
    if (message.error) {
      const code = codeOf({ code: message.error }); this.#settle(job, mediaError(code)); this.#drop(job.id, code);
    } else if (job.op === 'cancel') {
      this.#contexts.delete(job.id); context?.cancelResolve?.(true);
    } else if (context?.cancelRequested) {
      this.#settle(job, mediaError('STREAM_VALIDATOR_CANCELED'));
    } else {
      try {
        need(context && Number.isFinite(message.validationMs) && message.validationMs >= 0, 'STREAM_VALIDATOR_PROTOCOL');
        if (job.op === 'push') {
          need(Array.isArray(message.blocks) && message.blocks.length <= 4, 'STREAM_VALIDATOR_DESCRIPTOR');
          const blocks = message.blocks.map(value => new PreparedStreamBlock(value));
          this.#settle(job, null, { blocks, validationMs: message.validationMs,
            timing: this.#timing(job, receivedAt, message.validationMs) });
        } else if (job.op === 'end') {
          need(message.receipt?.sample_bytes_unchanged === true && Number.isInteger(message.receipt.blocks)
            && message.receipt.blocks > 0 && message.receipt.blocks <= 225, 'STREAM_VALIDATOR_RECEIPT');
          this.#contexts.delete(job.id); this.#settle(job, null, message.receipt);
        } else this.#settle(job, null, { ready: true, timing: this.#timing(job, receivedAt, message.validationMs) });
      } catch { this.#settle(job, mediaError('STREAM_VALIDATOR_DESCRIPTOR')); this.#lost(worker, 'STREAM_VALIDATOR_DESCRIPTOR'); return; }
    }
    this.#drive();
  }
  begin(id, value) {
    try {
      need(ID.test(id) && typeof id === 'string' && value && Buffer.isBuffer(value.init)
        && value.init.length > 16 && value.init.length <= 1024 * 1024 && typeof value.mime === 'string'
        && value.mime.length < 128 && (value.compatibilitySignature === undefined || value.compatibilitySignature === null
          || /^[a-f0-9]{64}$/.test(value.compatibilitySignature)), 'STREAM_VALIDATOR_BEGIN');
      need(!this.#contexts.has(id) && this.#contexts.size < 2, 'STREAM_VALIDATOR_CONTEXTS');
      this.#admit(value.init.length);
      this.#contexts.set(id, { nextSeq: 0, ending: false, cancelRequested: false, cancelSent: false });
      return this.#enqueue('begin', id, value.init, { mime: value.mime,
        compatibilitySignature: value.compatibilitySignature ?? null });
    } catch (error) { return Promise.reject(mediaError(codeOf(error))); }
  }
  push(id, seq, data) {
    try {
      const context = this.#contexts.get(id);
      need(context && !context.ending && !context.cancelRequested, 'STREAM_VALIDATOR_REQUEST');
      if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 225 || seq !== context.nextSeq) {
        void this.cancel(id); throw mediaError('STREAM_VALIDATOR_SEQUENCE');
      }
      need(Buffer.isBuffer(data) && data.length > 16 && data.length <= MAX_BYTES, 'STREAM_VALIDATOR_PART');
      this.#admit(data.length); context.nextSeq++;
      return this.#enqueue('push', id, data, null, seq);
    } catch (error) { return Promise.reject(mediaError(codeOf(error))); }
  }
  end(id) {
    try {
      const context = this.#contexts.get(id);
      need(context && !context.ending && !context.cancelRequested, 'STREAM_VALIDATOR_REQUEST');
      this.#admit(0); context.ending = true; return this.#enqueue('end', id);
    } catch (error) { return Promise.reject(mediaError(codeOf(error))); }
  }
  cancel(id) {
    const context = this.#contexts.get(id); if (!context) return Promise.resolve(false);
    if (context.cancelPromise) return context.cancelPromise;
    context.cancelRequested = true;
    context.cancelPromise = new Promise((resolve, reject) => { context.cancelResolve = resolve; context.cancelReject = reject; });
    void context.cancelPromise.catch(() => {});
    if (this.#active?.id === id) this.#settle(this.#active, mediaError('STREAM_VALIDATOR_CANCELED'));
    this.#pending = this.#pending.filter(job => {
      if (job.id !== id) return true;
      this.#bytes -= job.bytes; this.#settle(job, mediaError('STREAM_VALIDATOR_CANCELED')); return false;
    });
    this.#drive(); return context.cancelPromise;
  }
  snapshot() { return { ready: this.#ready, active: Boolean(this.#active), pending: this.#pending.length,
    queuedBytes: this.#bytes, contexts: this.#contexts.size,
    retiring: [...this.#contexts.values()].filter(value => value.cancelRequested).length, closed: this.#closed }; }
  close() {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#retry); this.#retry = null;
    if (!this.#initialSettled) { this.#initialSettled = true; this.#initialReject(mediaError('STREAM_VALIDATOR_CLOSED')); }
    if (this.#worker) this.#lost(this.#worker, 'STREAM_VALIDATOR_CLOSED');
    this.#ready = false;
  }
}
