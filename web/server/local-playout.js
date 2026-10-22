import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { EncodedClip, mediaError } from './local-fmp4.js';
import { isPlayableClip } from './prepared-clip.js';

function need(value, code) { if (!value) throw mediaError(code); }
export class LocalPlayout {
  #idle; #speech = []; #current = null; #index = 0; #bases; #sequence = 1;
  #timer = null; #running = false; #startedAt = null; #blockedAt = null; #lastIdle = -1;
  #kind = null; #idleIndex = null;
  #slot = null; #notices = []; #onClipStart; #onClipEnd;
  #currentNotice = null;
  #preparedPart = null; #queuedAt = null;
  #initSent = false; #sink; #clock; #schedule; #cancel; #fault; #random; #pendingBytes = 0;
  #lastEndSeconds = 0;
  #stats = { fragments: 0, bytes: 0, idle_clips: 0, speech_clips: 0, backpressure_blocks: 0,
    pending_high_water_bytes: 0, max_lateness_ms: 0, faults: 0, callback_errors: 0,
    last_queue_wait_ms: 0, max_queue_wait_ms: 0 };

  constructor({ idleClips, sink, onFault = () => {}, onClipStart = null, onClipEnd = null, now = () => performance.now(),
    schedule = setTimeout, cancel = clearTimeout, random = (length) => randomInt(length),
    aheadSeconds = 2, tickMs = 20, maxBurst = 2, maxIdleSeconds = 8,
    maxPendingBytes = 128 * 1024 * 1024, maxQueuedClips = 8, maxPoolBytes = 256 * 1024 * 1024,
    maxSinkPendingBytes = 4 * 1024 * 1024, maxBlockedMs = 5000, maxLatenessMs = 1500 } = {}) {
    need(Array.isArray(idleClips) && idleClips.length === 3 && idleClips.every((v) => v instanceof EncodedClip), 'IDLE_THREE_CLIPS');
    need(new Set(idleClips.map((v) => v.contentHash)).size === 3, 'IDLE_THREE_DISTINCT_CLIPS');
    need(idleClips.every((v) => typeof v.compatibilitySignature === 'string'
      && v.compatibilitySignature === idleClips[0].compatibilitySignature && v.durationSeconds <= maxIdleSeconds), 'IDLE_INCOMPATIBLE');
    need(idleClips.reduce((sum, v) => sum + v.byteLength, 0) <= maxPoolBytes, 'IDLE_POOL_LIMIT');
    need([sink, onFault, now, schedule, cancel, random].every((v) => typeof v === 'function')
      && aheadSeconds >= 0 && aheadSeconds <= 4 && tickMs >= 5
      && tickMs <= 100 && Number.isInteger(maxBurst) && maxBurst >= 1 && maxBurst <= 4, 'PLAYOUT_OPTIONS');
    for (const value of [maxPendingBytes, maxQueuedClips, maxSinkPendingBytes, maxBlockedMs, maxLatenessMs]) need(Number.isSafeInteger(value) && value > 0, 'PLAYOUT_OPTIONS');
    this.#idle = [...idleClips]; this.#sink = sink; this.#clock = now; this.#schedule = schedule;
    this.#cancel = cancel; this.#fault = onFault; this.#random = random;
    need([onClipStart, onClipEnd].every((v) => v === null || typeof v === 'function'), 'PLAYOUT_OPTIONS');
    this.#onClipStart = onClipStart; this.#onClipEnd = onClipEnd;
    Object.assign(this, { aheadSeconds, tickMs, maxBurst, maxPendingBytes, maxQueuedClips,
      maxSinkPendingBytes, maxBlockedMs, maxLatenessMs });
    this.#bases = new Map(idleClips[0].tracks.map((v) => [v.id, 0n]));
    this.mime = idleClips[0].mime; this.signature = idleClips[0].signature;
    this.compatibilitySignature = idleClips[0].compatibilitySignature;
    Object.freeze(this);
  }

  enqueueSpeech(clip, { slot = null } = {}) {
    need(isPlayableClip(clip) && clip.compatibilitySignature === this.compatibilitySignature, 'SPEECH_INCOMPATIBLE');
    need(slot === null || (typeof slot === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(slot)), 'SPEECH_SLOT_INVALID');
    const position = slot === null ? -1 : this.#speech.findIndex((entry) => entry.slot === slot);
    const replacedBytes = position < 0 ? 0 : this.#speech[position].clip.byteLength;
    need((position >= 0 || this.#speech.length < this.maxQueuedClips)
      && this.#pendingBytes - replacedBytes + clip.byteLength <= this.maxPendingBytes, 'SPEECH_QUEUE_FULL');
    const entry = { slot, clip, queuedAt: this.#clock() };
    if (position < 0) this.#speech.push(entry);
    else this.#speech[position] = entry;
    this.#pendingBytes += clip.byteLength - replacedBytes;
    // An unsent idle selection is replaceable. Reason: speech arriving before its first packet must not wait for an idle that viewers have not received.
    if (this.#index === 0 && this.#kind === 'idle') { this.#current = null; this.#preparedPart = null; }
  }
  cancelSpeech(slot) {
    // Only an unsent selection can be removed. Reason: already delivered AAC/video must finish its complete shared-timeline clip without an epoch reset.
    if (slot !== null && this.#kind === 'speech' && this.#slot === slot && this.#index === 0) {
      this.#current = null; this.#preparedPart = null; this.#slot = null; return true;
    }
    const position = this.#speech.findIndex((entry) => entry.slot === slot && slot !== null);
    if (position < 0) return false;
    this.#pendingBytes -= this.#speech[position].clip.byteLength; this.#speech.splice(position, 1); return true;
  }

  start() {
    need(!this.#running && this.#startedAt === null, 'PLAYOUT_ALREADY_STARTED');
    this.#startedAt = this.#clock(); need(Number.isFinite(this.#startedAt), 'PLAYOUT_CLOCK');
    this.#running = true; this.#arm(0);
  }
  stop() {
    this.#running = false;
    if (this.#timer !== null) this.#cancel(this.#timer);
    this.#timer = null;
    this.#notices = [];
  }
  #arm(delay) { this.#timer = this.#schedule(() => { this.#timer = null; this.#pump(); }, delay); }
  #choose() {
    if (this.#current && this.#index < this.#current.fragmentCount) return;
    if (this.#current) for (const [id, ticks] of this.#current.durationTicks) this.#bases.set(id, this.#bases.get(id) + ticks);
    // Switch only after a complete clip. Reason: arbitrary half-second cuts can split AAC/video rational boundaries and accumulate drift.
    if (this.#speech.length) {
      const job = this.#speech.shift(); this.#current = job.clip; this.#slot = job.slot; this.#queuedAt = job.queuedAt;
      this.#pendingBytes -= this.#current.byteLength;
      this.#kind = 'speech'; this.#idleIndex = null;
    } else {
      const candidates = [0, 1, 2].filter((v) => v !== this.#lastIdle);
      const pick = this.#random(candidates.length);
      need(Number.isInteger(pick) && pick >= 0 && pick < candidates.length, 'PLAYOUT_RANDOM');
      this.#idleIndex = candidates[pick]; this.#current = this.#idle[this.#idleIndex]; this.#kind = 'idle';
      this.#slot = null;
      this.#queuedAt = null;
    }
    this.#index = 0;
    this.#currentNotice = null;
    this.#preparedPart = null;
  }
  #notify(callback, notice) {
    // Business status/ACK failures cannot stop local idle. Reason: the media clock and producer control plane have separate failure lifetimes.
    try { callback?.({ ...notice }); } catch { this.#stats.callback_errors++; }
  }
  #send(data, kind) {
    // Accepted=false must mean no delivery. Reason: retrying an accepted fragment would duplicate DTS/mfhd on every viewer.
    const result = this.#sink(data, kind);
    need(result && typeof result.accepted === 'boolean' && Number.isSafeInteger(result.pendingBytes) && result.pendingBytes >= 0, 'PLAYOUT_SINK_CONTRACT');
    this.#stats.pending_high_water_bytes = Math.max(this.#stats.pending_high_water_bytes, result.pendingBytes);
    need(result.pendingBytes <= this.maxSinkPendingBytes, 'PLAYOUT_SINK_LIMIT');
    if (!result.accepted) {
      this.#stats.backpressure_blocks++;
      this.#blockedAt ??= this.#clock();
      need(this.#clock() - this.#blockedAt <= this.maxBlockedMs, 'PLAYOUT_BACKPRESSURE_TIMEOUT');
      return false;
    }
    this.#blockedAt = null; return true;
  }
  #pump() {
    if (!this.#running) return;
    try {
      const elapsed = Math.max(0, this.#clock() - this.#startedAt) / 1000;
      for (const notice of this.#notices) {
        if (!notice.started && elapsed >= notice.startSeconds) {
          notice.started = true; this.#notify(this.#onClipStart, notice);
        }
        if (elapsed >= notice.endSeconds) {
          need(notice.outputComplete, 'PLAYOUT_END_BEFORE_OUTPUT_COMPLETE');
          notice.ended = true; this.#notify(this.#onClipEnd, notice);
        }
      }
      this.#notices = this.#notices.filter((notice) => !notice.ended);
      if (!this.#running) return;
      if (!this.#initSent) {
        if (!this.#send(this.#idle[0].init, 'init')) { this.#arm(this.tickMs); return; }
        this.#initSent = true;
      }
      for (let emitted = 0; emitted < this.maxBurst; emitted++) {
        this.#choose();
        // Keep at most one future fragment copy. Reason: a 20ms pacing tick must not recopy a 0.5MiB packet while waiting for the same DTS deadline.
        const part = this.#preparedPart ??= this.#current.rewrite(this.#index, this.#sequence, this.#bases);
        const elapsed = Math.max(0, this.#clock() - this.#startedAt) / 1000;
        if (part.startSeconds > elapsed + this.aheadSeconds) break;
        const late = Math.max(0, (elapsed - part.startSeconds) * 1000);
        this.#stats.max_lateness_ms = Math.max(this.#stats.max_lateness_ms, late);
        // Never dump a long overdue burst. Reason: it would recreate periodic buffering and unbounded client queues after CPU/network stalls.
        need(late <= this.maxLatenessMs, 'PLAYOUT_PACING_LATE');
        if (!this.#send(part.data, 'fragment')) break;
        if (this.#index === 0) {
          const queueWait = this.#queuedAt === null ? 0 : Math.max(0, this.#startedAt + part.startSeconds * 1000 - this.#queuedAt);
          if (this.#kind === 'speech') {
            this.#stats.last_queue_wait_ms = queueWait;
            this.#stats.max_queue_wait_ms = Math.max(this.#stats.max_queue_wait_ms, queueWait);
          }
          this.#stats[this.#kind === 'idle' ? 'idle_clips' : 'speech_clips']++;
          if (this.#kind === 'idle') this.#lastIdle = this.#idleIndex;
          // Notify on planned wall time, not ahead-of-time output. Reason: queue completion must not mean a viewer has already heard the clip.
          if (this.#onClipStart || this.#onClipEnd) {
            need(this.#notices.length < 32, 'PLAYOUT_NOTICE_BOUND');
            this.#currentNotice = { slot: this.#slot, kind: this.#kind, startSeconds: part.startSeconds,
              endSeconds: part.startSeconds + this.#current.durationSeconds, queueWaitMs: queueWait,
              committedAheadMs: Math.max(0, (part.startSeconds - elapsed) * 1000), started: false, outputComplete: false };
            this.#notices.push(this.#currentNotice);
          }
        }
        this.#stats.fragments++; this.#stats.bytes += part.data.length;
        this.#lastEndSeconds = part.endSeconds;
        this.#index++; this.#sequence++;
        this.#preparedPart = null;
        if (this.#currentNotice && this.#index === this.#current.fragmentCount) this.#currentNotice.outputComplete = true;
      }
      this.#arm(this.tickMs);
    } catch (error) {
      this.#stats.faults++; this.stop();
      // Isolate the callback after stopping. Reason: diagnostics must not crash the relay if an integration callback itself throws.
      try { this.#fault({ code: /^\w{1,64}$/.test(error?.code || '') ? error.code : 'PLAYOUT_FAILED' }); } catch {}
    }
  }
  snapshot() {
    return { ...this.#stats, running: this.#running, queued_clips: this.#speech.length,
      queued_bytes: this.#pendingBytes, sequence_next: this.#sequence,
      current_kind: this.#current ? this.#kind : null,
      ahead_seconds: this.aheadSeconds,
      elapsed_ms: this.#startedAt === null ? 0 : Math.max(0, this.#clock() - this.#startedAt),
      media_seconds: this.#lastEndSeconds };
  }
}
