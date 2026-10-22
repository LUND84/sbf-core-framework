import { Worker } from 'node:worker_threads';
import { PreparedClip } from './prepared-clip.js';
import { mediaError } from './local-fmp4.js';

export class ReplyValidator {
  #worker; #active = null; #pending = null; #serial = 0; #closed = false; #ready = false; #resolveReady; #retry = null;
  constructor() { this.ready = new Promise((resolve) => { this.#resolveReady = resolve; }); this.#spawn(); }
  #spawn() {
    if (this.#closed) return;
    this.#ready = false; this.#worker = new Worker(new URL('./reply-validator-worker.js', import.meta.url));
    this.#worker.on('message', (result) => {
      if (result.type === 'ready') { this.#ready = true; this.#resolveReady(); if (!this.#active) this.#worker.unref(); return; }
      const job = this.#active; if (!job || job.serial !== result.serial) return;
      this.#active = null;
      try {
        if (result.error) throw mediaError(result.error);
        job.resolve({ clip: new PreparedClip(result.descriptor), validationMs: result.validationMs });
      } catch (error) { job.reject(error); }
      this.#next();
    });
    const failed = () => {
      const failedWorker = this.#worker;
      this.#active?.reject(mediaError('REPLY_VALIDATOR_EXIT')); this.#active = null;
      this.#pending?.reject(mediaError('REPLY_VALIDATOR_EXIT')); this.#pending = null;
      failedWorker.removeAllListeners(); void failedWorker.terminate();
      this.#worker = null; this.#ready = false;
      // A broken import/runtime cannot spin worker creation. Reason: validator recovery must remain bounded and leave the independent media loop responsive.
      if (!this.#closed) { this.#retry = setTimeout(() => { this.#retry = null; this.#spawn(); }, 250); this.#retry.unref(); }
    };
    this.#worker.once('error', failed); this.#worker.once('exit', failed);
  }
  #next() {
    if (this.#pending) { this.#active = this.#pending; this.#pending = null; this.#send(this.#active); }
    else this.#worker.unref();
  }
  #send(job) {
    this.#worker.ref();
    // Never detach shared/pool-backed Buffers. Reason: WS frame storage can share an ArrayBuffer with another message; ownership must be exclusive before transfer.
    try {
      const chunks = job.chunks.map((data) => data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? new Uint8Array(data.buffer) : Uint8Array.from(data));
      job.chunks = null;
      this.#worker.postMessage({ serial: job.serial, chunks, meta: job.meta }, [...new Set(chunks.map((v) => v.buffer))]);
    }
    catch (error) { this.#active = null; job.reject(mediaError('REPLY_VALIDATOR_TRANSFER')); this.#next(); }
  }
  normalize(chunks, meta) {
    // One hot worker plus one pending cancelled-generation replacement. Reason: cancellation cannot create an unbounded CPU/media backlog while the existing validator finishes.
    if (this.#closed || !this.#worker || this.#pending || !Array.isArray(chunks) || chunks.length === 0 || chunks.length > 512
      || !chunks.every((value) => value instanceof Uint8Array)
      || chunks.reduce((total, value) => total + value.byteLength, 0) > 64 * 1024 * 1024) return Promise.reject(mediaError('REPLY_VALIDATOR_BUSY'));
    return new Promise((resolve, reject) => {
      const job = { serial: ++this.#serial, chunks, meta, resolve, reject };
      if (this.#active) this.#pending = job; else { this.#active = job; this.#send(job); }
    });
  }
  snapshot() { return { ready: this.#ready, active: Boolean(this.#active), pending: Boolean(this.#pending) }; }
  close() {
    this.#closed = true;
    for (const job of [this.#active, this.#pending]) job?.reject(mediaError('REPLY_VALIDATOR_CLOSED'));
    this.#active = null; this.#pending = null;
    clearTimeout(this.#retry); this.#retry = null;
    this.#worker?.removeAllListeners(); void this.#worker?.terminate();
  }
}
