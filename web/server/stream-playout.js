import { createHash, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mediaError } from './local-fmp4.js';
import { StreamBlock } from './stream-fragments.js';

const STEP = 16 / 30, trusted = new WeakSet();
const sha = data => createHash('sha256').update(data).digest('hex');
function need(value, code) { if (!value) throw mediaError(code); }
function metadata(value) {
  need(value && Number.isInteger(value.index) && value.index >= 0 && value.index < 225
    && value.durationSeconds === STEP && typeof value.rewrite === 'function'
    && /^[a-f0-9]{64}$/.test(value.compatibilitySignature) && Number.isSafeInteger(value.byteLength)
    && value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024, 'STREAM_BLOCK_PROTOCOL');
  need(Array.isArray(value.tracks) && value.tracks.length === 2 && new Set(value.tracks.map(track => track.id)).size === 2
    && value.tracks.every(track => Number.isSafeInteger(track.id) && track.id > 0
      && ((track.handler === 'vide' && track.timescale === 90000) || (track.handler === 'soun' && track.timescale === 48000)))
    && value.tracks.some(track => track.handler === 'vide') && value.tracks.some(track => track.handler === 'soun'), 'STREAM_BLOCK_PROTOCOL');
  const relative = value.relativeStartTicks;
  need(relative instanceof Map && relative.size === 2 && value.tracks.every(track =>
    relative.get(track.id) === BigInt(value.index) * (track.handler === 'vide' ? 48000n : 25600n)), 'STREAM_BLOCK_PROTOCOL');
  return value;
}
export function trustPreparedStreamBlock(value) {
  // Call only from the owned worker-descriptor hydrator, never on network JSON.
  // Reason: this brand transfers already strict sample validation; the media hot loop must not reparse H.264/AAC or accept a duck-typed remote object.
  metadata(value); trusted.add(value); return Object.freeze(value);
}
export const isPlayableStreamBlock = value => value instanceof StreamBlock || (typeof value === 'object' && value !== null && trusted.has(value));

export class StreamPlayout {
  #init; #idleClips; #tracks; #sink; #now; #schedule; #cancel; #random; #onStart; #onEnd; #onSourceFault; #onFault;
  #jobs = new Map(); #activeSpeech = null; #idle = null; #lastIdle = -1; #run = null; #notices = []; #tag = 0;
  #prepared = null; #globalBlock = 0; #sequence = 1; #initSent = false; #startedAt = null; #timer = null; #running = false;
  #stopped = false;
  #queuedBlocks = 0; #queuedBytes = 0; #blockedAt = null; #sourceWaitAt = null; #lastEnd = 0;
  #stats = { fragments: 0, bytes: 0, idle_clips: 0, idle_runs: 0, idle_preemptions: 0, idle_resumptions: 0,
    speech_starts: 0, speech_completed: 0, speech_failed: 0, speech_starvations: 0, cancellations: 0,
    source_wait_ticks: 0, max_source_wait_ms: 0, max_queue_wait_ms: 0, backpressure_blocks: 0,
    pending_high_water_bytes: 0, max_lateness_ms: 0, callback_errors: 0, faults: 0, last_source_fault_code: null };
  constructor({ init, idleClips, sink, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
    random = length => randomInt(length), onTagStart = null, onTagEnd = null, onSourceFault = null, onFault = null,
    aheadSeconds = 0.6, minSpeechReserveSeconds = 0.15, minStartBlocks = 1, tickMs = 20, maxBurst = 2,
    maxQueuedBlocks = 32, maxPendingBytes = 64 * 1024 * 1024, maxPoolBytes = 256 * 1024 * 1024,
    maxSinkPendingBytes = 4 * 1024 * 1024, maxBlockedMs = 5000, maxLatenessMs = 1500, maxStartWaitMs = 5000 } = {}) {
    need(Buffer.isBuffer(init) && init.length > 16 && init.length <= 1024 * 1024, 'PLAYOUT_INIT');
    need(Array.isArray(idleClips) && idleClips.length === 3 && idleClips.every(clip => Array.isArray(clip) && clip.length === 15), 'IDLE_THREE_SHORT_CLIPS');
    const first = idleClips[0][0]; need(isPlayableStreamBlock(first), 'IDLE_BLOCK_INVALID'); metadata(first);
    const initHash = sha(init); let poolBytes = 0;
    for (const clip of idleClips) for (let index = 0; index < clip.length; index++) {
      const block = clip[index]; need(isPlayableStreamBlock(block), 'IDLE_BLOCK_INVALID'); metadata(block);
      need(block.index === index && block.compatibilitySignature === first.compatibilitySignature
        && Buffer.isBuffer(block.init) && sha(block.init) === initHash, 'IDLE_INCOMPATIBLE'); poolBytes += block.byteLength;
    }
    need(Number.isSafeInteger(maxPoolBytes) && maxPoolBytes > 0 && poolBytes <= maxPoolBytes, 'IDLE_POOL_LIMIT');
    need([sink, now, schedule, cancel, random].every(value => typeof value === 'function')
      && [onTagStart, onTagEnd, onSourceFault, onFault].every(value => value === null || typeof value === 'function'), 'PLAYOUT_OPTIONS');
    need(Number.isFinite(aheadSeconds) && aheadSeconds >= 0 && aheadSeconds <= 2
      && Number.isFinite(minSpeechReserveSeconds) && minSpeechReserveSeconds >= 0 && minSpeechReserveSeconds <= aheadSeconds
      && Number.isInteger(tickMs) && tickMs >= 5 && tickMs <= 100 && Number.isInteger(maxBurst) && maxBurst >= 1 && maxBurst <= 4
      && Number.isInteger(maxQueuedBlocks) && maxQueuedBlocks >= 1 && maxQueuedBlocks <= 64
      && Number.isInteger(minStartBlocks) && minStartBlocks >= 1 && minStartBlocks <= Math.min(4, maxQueuedBlocks), 'PLAYOUT_OPTIONS');
    for (const value of [maxPendingBytes, maxSinkPendingBytes, maxBlockedMs, maxLatenessMs, maxStartWaitMs]) need(Number.isSafeInteger(value) && value > 0, 'PLAYOUT_OPTIONS');
    this.#init = Buffer.from(init); this.#idleClips = idleClips.map(clip => [...clip]); this.#tracks = first.tracks;
    this.#sink = sink; this.#now = now; this.#schedule = schedule; this.#cancel = cancel; this.#random = random;
    this.#onStart = onTagStart; this.#onEnd = onTagEnd; this.#onSourceFault = onSourceFault; this.#onFault = onFault;
    this.compatibilitySignature = first.compatibilitySignature;
    Object.assign(this, { aheadSeconds, minSpeechReserveSeconds, minStartBlocks, tickMs, maxBurst, maxQueuedBlocks, maxPendingBytes,
      maxSinkPendingBytes, maxBlockedMs, maxLatenessMs, maxStartWaitMs }); Object.freeze(this);
  }
  #notify(callback, value) { try { callback?.({ ...value }); } catch { this.#stats.callback_errors++; } }
  #elapsed() { const time = this.#now(); need(Number.isFinite(time), 'PLAYOUT_CLOCK'); return this.#startedAt === null ? 0 : Math.max(0, time - this.#startedAt) / 1000; }
  beginSpeech(slot) {
    need(!this.#stopped, 'PLAYOUT_STOPPED');
    need(typeof slot === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(slot), 'SPEECH_SLOT_INVALID');
    need(!this.#jobs.has(slot) && this.#jobs.size < 2, 'SPEECH_SLOT_LIMIT');
    this.#jobs.set(slot, { slot, queue: [], expected: 0, ended: false, phase: 'queued', notice: null, createdAt: this.#now() });
  }
  appendSpeech(slot, block) {
    need(!this.#stopped, 'PLAYOUT_STOPPED');
    const job = this.#jobs.get(slot); need(job && !job.ended && ['queued', 'active'].includes(job.phase), 'SPEECH_SLOT_CLOSED');
    need(isPlayableStreamBlock(block), 'SPEECH_INCOMPATIBLE'); metadata(block);
    need(block.compatibilitySignature === this.compatibilitySignature, 'SPEECH_INCOMPATIBLE');
    need(block.index === job.expected, 'SPEECH_BLOCK_ORDER');
    // Refusal means no ownership/order advancement. Reason: the upstream controller needs bounded credits rather than dropping an encoded speech block.
    if (this.#queuedBlocks >= this.maxQueuedBlocks || this.#queuedBytes + block.byteLength > this.maxPendingBytes)
      return { accepted: false, pendingBytes: this.#queuedBytes };
    job.queue.push(block); job.expected++; this.#queuedBlocks++; this.#queuedBytes += block.byteLength;
    if (this.#prepared?.selection.kind === 'idle') this.#prepared = null;
    return { accepted: true, pendingBytes: this.#queuedBytes };
  }
  endSpeech(slot) {
    need(!this.#stopped, 'PLAYOUT_STOPPED');
    const job = this.#jobs.get(slot); need(job && ['queued', 'active'].includes(job.phase) && !job.ended && job.expected > 0, 'SPEECH_SLOT_CLOSED');
    job.ended = true;
    if (!job.queue.length && job.notice) this.#finishSpeech(job, 'completed');
  }
  #dropQueue(job) {
    this.#queuedBlocks -= job.queue.length; this.#queuedBytes -= job.queue.reduce((sum, block) => sum + block.byteLength, 0); job.queue = [];
    if (this.#prepared?.selection.job === job) this.#prepared = null;
  }
  #finishSpeech(job, status, code = null) {
    // A scheduled success is provisional until its wall-clock end.
    // Reason: cancel/disconnect cannot withdraw delivered bytes but must still suppress a ghost completion/commit during the ahead window.
    if (job.phase === 'draining' && (status === 'completed' || job.notice?.status !== 'completed')) return;
    this.#dropQueue(job); job.phase = 'draining';
    if (this.#activeSpeech === job) this.#activeSpeech = null;
    if (job.notice) { job.notice.final = true; job.notice.status = status; job.notice.code = code; }
    else this.#jobs.delete(job.slot);
    if (status === 'failed') {
      this.#stats.speech_failed++; this.#stats.last_source_fault_code = code;
      if (code === 'SPEECH_STARVED' || code === 'SPEECH_START_STARVED') this.#stats.speech_starvations++;
      this.#notify(this.#onSourceFault, { slot: job.slot, code, committed: Boolean(job.notice), lastCommittedEndSeconds: job.notice?.endSeconds ?? null });
    }
  }
  cancelSpeech(slot) {
    const job = this.#jobs.get(slot); if (!job) return false;
    this.#stats.cancellations++; this.#finishSpeech(job, 'cancelled'); return true;
  }
  sourceLost(slot = null) {
    // Committed media cannot be withdrawn; only unsent queues are discarded.
    // Reason: source failure must drain whole AAC/video blocks then return to autonomous idle, without an epoch reset or a successful speech ACK.
    for (const job of [...this.#jobs.values()]) if (slot === null || job.slot === slot) this.#finishSpeech(job, 'failed', 'SPEECH_SOURCE_LOST');
  }
  start() { need(!this.#running && this.#startedAt === null, 'PLAYOUT_ALREADY_STARTED'); this.#startedAt = this.#now(); need(Number.isFinite(this.#startedAt), 'PLAYOUT_CLOCK'); this.#running = true; this.#arm(0); }
  stop() {
    this.#running = false; this.#stopped = true; if (this.#timer !== null) this.#cancel(this.#timer);
    // Retire owned queues before an asynchronous validator can return.
    // Reason: a stopped player cannot acknowledge/store new speech or retain an abandoned upload backlog.
    this.#timer = null; this.#notices = []; this.#jobs.clear(); this.#queuedBlocks = this.#queuedBytes = 0;
    this.#prepared = null; this.#activeSpeech = null; this.#run = null;
  }
  #arm(delay) { this.#timer = this.#schedule(() => { this.#timer = null; this.#pump(); }, delay); }
  #startReady(job) { return job.queue.length >= this.minStartBlocks || (job.ended && job.queue.length > 0); }
  #select(elapsed, startSeconds) {
    if (this.#activeSpeech) {
      const job = this.#activeSpeech;
      if (job.queue.length) { this.#sourceWaitAt = null; return { kind: 'speech', slot: job.slot, job, block: job.queue[0] }; }
      if (job.ended) this.#finishSpeech(job, 'completed');
      else if (elapsed < startSeconds - this.minSpeechReserveSeconds) {
        this.#sourceWaitAt ??= this.#now(); this.#stats.source_wait_ticks++;
        this.#stats.max_source_wait_ms = Math.max(this.#stats.max_source_wait_ms, this.#now() - this.#sourceWaitAt); return null;
      } else this.#finishSpeech(job, 'failed', 'SPEECH_STARVED');
    }
    this.#sourceWaitAt = null;
    const waiting = [...this.#jobs.values()].find(job => job.phase === 'queued');
    // Keep sending cached idle while the first small speech reserve arrives.
    // Reason: committing a single GOP before a delayed second GOP truncated the
    // reply; a completed short reply can still start without waiting for more.
    if (waiting && this.#startReady(waiting)) return { kind: 'speech', slot: waiting.slot, job: waiting, block: waiting.queue[0] };
    if (!this.#idle) {
      const candidates = [0, 1, 2].filter(index => index !== this.#lastIdle), chosen = this.#random(candidates.length);
      need(Number.isInteger(chosen) && chosen >= 0 && chosen < candidates.length, 'PLAYOUT_RANDOM'); this.#idle = { clip: candidates[chosen], index: 0 };
    }
    return { kind: 'idle', slot: null, idle: this.#idle, block: this.#idleClips[this.#idle.clip][this.#idle.index] };
  }
  #prepare(selection) {
    const relative = selection.block.relativeStartTicks;
    const bases = new Map(this.#tracks.map(track => {
      const target = BigInt(this.#globalBlock) * (track.handler === 'vide' ? 48000n : 25600n);
      const base = target - relative.get(track.id); need(base >= 0n, 'PLAYOUT_BLOCK_BASE'); return [track.id, base];
    }));
    return { selection, part: selection.block.rewrite(this.#sequence, bases) };
  }
  #prepareNext(elapsed, startSeconds) {
    // Retry only owned speech slots, without advancing the shared clocks.
    // Reason: a failed reply rewrite must fall back to idle, while a broken
    // idle pool, sink or global clock must remain visible as an origin fault.
    for (let attempt = 0; attempt < 3; attempt++) {
      const selection = this.#select(elapsed, startSeconds);
      if (!this.#running || !selection) return null;
      try { return this.#prepare(selection); }
      catch (error) {
        if (selection.kind !== 'speech') throw error;
        this.#finishSpeech(selection.job, 'failed', 'SPEECH_PREPARE_FAILED');
      }
    }
    throw mediaError('PLAYOUT_SOURCE_RETRY_LIMIT');
  }
  #endIdle(status) {
    if (this.#run?.kind === 'idle' && !this.#run.final) {
      this.#run.final = true; this.#run.status = status;
      if (status === 'preempted') this.#stats.idle_preemptions++;
    }
  }
  #commit(selection, part) {
    let notice = this.#run;
    if (selection.kind === 'speech') {
      const job = selection.job;
      if (!job.notice) {
        this.#endIdle('preempted');
        const queueWaitMs = Math.max(0, this.#startedAt + part.startSeconds * 1000 - job.createdAt);
        notice = this.#newNotice({ kind: 'speech', slot: job.slot, startSeconds: part.startSeconds, endSeconds: part.endSeconds, queueWaitMs });
        job.notice = notice; job.phase = 'active'; this.#activeSpeech = job; this.#stats.speech_starts++;
        this.#stats.max_queue_wait_ms = Math.max(this.#stats.max_queue_wait_ms, queueWaitMs);
      } else notice = job.notice;
      need(job.queue.shift() === selection.block, 'PLAYOUT_SOURCE_ORDER'); this.#queuedBlocks--; this.#queuedBytes -= selection.block.byteLength;
      notice.endSeconds = part.endSeconds; this.#run = notice;
      if (job.ended && !job.queue.length) this.#finishSpeech(job, 'completed');
    } else {
      if (!notice || notice.kind !== 'idle' || notice.final) {
        notice = this.#newNotice({ kind: 'idle', slot: null, idleClip: selection.idle.clip, idleBlock: selection.idle.index,
          startSeconds: part.startSeconds, endSeconds: part.endSeconds, queueWaitMs: 0 }); this.#stats.idle_runs++;
        if (selection.idle.index > 0) this.#stats.idle_resumptions++;
      }
      notice.endSeconds = part.endSeconds; this.#run = notice;
      selection.idle.index++;
      if (selection.idle.index === 15) { this.#stats.idle_clips++; this.#lastIdle = selection.idle.clip; this.#idle = null; this.#endIdle('completed'); }
    }
  }
  #newNotice(value) { need(this.#notices.length < 24, 'PLAYOUT_NOTICE_BOUND'); const notice = { ...value, tag: ++this.#tag, started: false, final: false, status: 'planned', code: null }; this.#notices.push(notice); return notice; }
  #deliver(elapsed) {
    for (const notice of this.#notices) {
      if (!notice.started && elapsed >= notice.startSeconds) { notice.started = true; this.#notify(this.#onStart, notice); }
      if (!this.#running) return;
      if (notice.final && elapsed >= notice.endSeconds) {
        notice.ended = true;
        if (notice.kind === 'speech') {
          if (notice.status === 'completed') this.#stats.speech_completed++;
          const job = this.#jobs.get(notice.slot); if (job?.notice === notice) this.#jobs.delete(notice.slot);
        }
        this.#notify(this.#onEnd, notice); if (this.#run === notice) this.#run = null;
        if (!this.#running) return;
      }
    }
    this.#notices = this.#notices.filter(notice => !notice.ended);
  }
  #send(data, type, context) {
    const result = this.#sink(data, type, context);
    need(result && typeof result.accepted === 'boolean' && Number.isSafeInteger(result.pendingBytes) && result.pendingBytes >= 0, 'PLAYOUT_SINK_CONTRACT');
    this.#stats.pending_high_water_bytes = Math.max(this.#stats.pending_high_water_bytes, result.pendingBytes);
    need(result.pendingBytes <= this.maxSinkPendingBytes, 'PLAYOUT_SINK_LIMIT');
    if (!result.accepted) {
      this.#stats.backpressure_blocks++; this.#blockedAt ??= this.#now();
      need(this.#now() - this.#blockedAt <= this.maxBlockedMs, 'PLAYOUT_BACKPRESSURE_TIMEOUT'); return false;
    }
    this.#blockedAt = null; return true;
  }
  #pump() {
    if (!this.#running) return;
    try {
      const elapsed = this.#elapsed(); this.#deliver(elapsed);
      for (const job of [...this.#jobs.values()]) if (job.phase === 'queued' && !this.#startReady(job) && this.#now() - job.createdAt >= this.maxStartWaitMs)
        this.#finishSpeech(job, 'failed', 'SPEECH_START_STARVED');
      if (!this.#running) return;
      if (!this.#initSent) { if (!this.#send(this.#init, 'init', null)) { this.#arm(this.tickMs); return; } this.#initSent = true; }
      for (let burst = 0; burst < this.maxBurst; burst++) {
        const now = this.#elapsed(), nextStart = this.#globalBlock * STEP;
        if (nextStart > now + this.aheadSeconds) break;
        if (!this.#prepared) {
          this.#prepared = this.#prepareNext(now, nextStart);
          if (!this.#running) return;
          if (!this.#prepared) break;
        }
        const { selection, part } = this.#prepared;
        const lateness = Math.max(0, (now - nextStart) * 1000); this.#stats.max_lateness_ms = Math.max(this.#stats.max_lateness_ms, lateness);
        need(lateness <= this.maxLatenessMs, 'PLAYOUT_PACING_LATE');
        const context = { kind: selection.kind, slot: selection.slot, globalBlock: this.#globalBlock,
          idleClip: selection.idle?.clip ?? null, idleBlock: selection.idle?.index ?? null };
        if (!this.#send(part.data, 'fragment', context)) break;
        this.#commit(selection, part); this.#stats.fragments++; this.#stats.bytes += part.data.length;
        this.#lastEnd = part.endSeconds; this.#globalBlock++; this.#sequence++; this.#prepared = null;
      }
      this.#arm(this.tickMs);
    } catch (error) {
      this.#stats.faults++; this.stop(); this.#notify(this.#onFault, { code: /^\w{1,64}$/.test(error?.code || '') ? error.code : 'PLAYOUT_FAILED' });
    }
  }
  snapshot() {
    return { ...this.#stats, running: this.#running, queued_blocks: this.#queuedBlocks, queued_bytes: this.#queuedBytes,
      speech_slots: this.#jobs.size, sequence_next: this.#sequence, media_seconds: this.#lastEnd,
      elapsed_ms: this.#elapsed() * 1000, ahead_seconds: this.aheadSeconds,
      min_speech_reserve_seconds: this.minSpeechReserveSeconds, min_start_blocks: this.minStartBlocks,
      completion: 'planned_wall_clock_not_viewer_ack' };
  }
}
