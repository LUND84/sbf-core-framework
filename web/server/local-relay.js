import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LocalPlayout } from './local-playout.js';
import { EncodedClip, mediaError } from './local-fmp4.js';
import { ReplyValidator } from './reply-validator.js';
import { isPlayableClip } from './prepared-clip.js';

// One upload/validation and two admitted slots are bounded independently. Reason: rendering the next reply must not overwrite the reply whose wall-clock playback is still in progress.
const LIMIT = 64 * 1024 * 1024, SLOTS = 2;
function need(value, code) { if (!value) throw mediaError(code); }
function safeCode(error) { return /^\w{1,64}$/.test(error?.code || '') ? error.code : 'REPLY_INVALID'; }

export class LocalRelay {
  constructor(broker, playlist, options = {}) {
    need(playlist?.clips?.length === 3 && playlist.clips.every((v) => v instanceof EncodedClip), 'IDLE_PLAYLIST_REQUIRED');
    this.broker = broker; this.playlist = playlist; this.options = options;
    this.normalize = options.normalizeReply || null;
    this.validator = this.normalize ? null : new ReplyValidator();
    this.upload = null; this.validation = null; this.discard = null; this.uploadTimer = null;
    this.recoveryTimer = null;
    this.replies = new Map(); this.heldDone = new Map(); this.clock = options.now || (() => performance.now());
    this.kind = 'idle'; this.accepted = 0; this.rejected = 0; this.closed = false;
    this.lifetime = { stream_restarts: 0, scheduler_faults_total: 0, last_fault_code: null,
      last_restart_reason: 'startup', prior_epoch_hash: null, validation_last_ms: 0, validation_max_ms: 0 };
    this.lifetime.control_callback_errors = 0;
    this.restart('startup');
  }
  restart(reason = 'explicit_recovery') {
    if (this.player) {
      this.lifetime.stream_restarts++;
      this.lifetime.prior_epoch_hash = createHash('sha256').update(this.broker.stream.epoch || '').digest('hex').slice(0, 12);
    }
    this.lifetime.last_restart_reason = /^\w{1,64}$/.test(reason) ? reason : 'explicit_recovery';
    this.player?.stop(); this.broker.resetMedia();
    this.broker.stream = { ready: false, epoch: randomUUID(), mime: this.playlist.clips[0].mime,
      width: 1920, height: 1080, fps: 30, source: 'local-playlist' };
    this.broker.broadcast({ type: 'stream.reset', ...this.broker.stream }); this.kind = 'idle';
    this.player = new LocalPlayout({ ...this.options, idleClips: this.playlist.clips,
      sink: (data) => { this.broker.receiveMedia(data); return { accepted: true, pendingBytes: 0 }; },
      onClipStart: (event) => {
        this.kind = event.kind;
        const reply = this.replies.get(event.slot);
        if (reply) { reply.started = true; reply.queueWaitMs = event.queueWaitMs; }
        this.broker.publishStatus();
      },
      onClipEnd: (event) => this.clipEnded(event),
      onFault: (error) => {
        if (this.closed) return;
        const code = safeCode(error); this.lifetime.scheduler_faults_total++; this.lifetime.last_fault_code = code;
        this.cancel({ all: true, allowDrain: false });
        this.broker.failAll('本地播放调度暂停，正在恢复待机。');
        // Bound genuine fault recovery to four attempts/second. Reason: a persistent sink/config failure must not create an immediate epoch-reset/event-loop storm.
        this.recoveryTimer = (this.options.schedule || setTimeout)(() => {
          this.recoveryTimer = null;
          if (!this.closed) { this.restart(code); this.broker.publishStatus(); }
        }, 250);
        this.recoveryTimer.unref?.();
      },
    });
    this.player.start();
  }
  snapshot() {
    return { enabled: true, kind: this.kind, upload_bytes: this.upload?.received || 0,
      upload_active: Boolean(this.upload), validation_active: Boolean(this.validation),
      admitted_replies: this.replies.size, accepted: this.accepted, rejected: this.rejected,
      validator: this.validator?.snapshot() || null,
      completion: 'planned_wall_clock_not_viewer_ack', ...this.lifetime, ...this.player.snapshot() };
  }
  hasReply(id) { return this.replies.has(id); }
  finish(id, terminal) {
    if (typeof this.broker.finishLocalJob === 'function') this.broker.finishLocalJob(id, terminal);
    else if (this.broker.current?.id === id) {
      if (terminal) this.broker.chatEvent(terminal);
      this.broker.clearCurrent(); this.broker.dispatch(); this.broker.publishStatus();
    }
  }
  clipEnded(event) {
    if (event.kind !== 'speech') return;
    const reply = this.replies.get(event.slot); if (!reply || reply.ended) return;
    reply.ended = true;
    if (reply.producerLost || reply.worker !== this.broker.worker || !this.broker.workerInfo.connected) {
      reply.done = { id: reply.id, role: 'system', status: 'error', reason: 'producer_lost' };
    } else {
      // This acknowledges the server's complete planned slot, not a browser/audio device. Reason: ahead-of-time packet delivery cannot establish that a viewer has heard the reply.
      this.broker.send(reply.worker, { type: 'reply.clip.played', id: reply.id });
    }
    this.completeIfReady(reply.id);
  }
  reject(id, code, failCurrent = true) {
    this.rejected++; this.broker.send(this.broker.worker, { type: 'reply.clip.rejected', id, code });
    if (failCurrent) {
      this.cancel({ id });
      const terminal = { id, role: 'system', status: 'error', text: '回复片段无法接入，已继续待机。', error: code };
      if (typeof this.broker.rejectLocalJob === 'function') this.broker.rejectLocalJob(id, terminal);
      else this.finish(id, terminal);
    }
  }
  begin(message) {
    if (message.id !== this.broker.current?.id) { this.reject(message.id, 'REPLY_NOT_ACTIVE', false); return; }
    try {
      need(!this.upload && !this.validation && !this.replies.has(message.id) && this.replies.size < SLOTS, 'REPLY_DUPLICATE');
      need(message.mime === this.playlist.clips[0].mime && message.width === 1920 && message.height === 1080
        && message.fps === 30 && typeof message.source_epoch === 'string' && message.source_epoch.length > 0
        && message.source_epoch.length <= 128 && Number.isSafeInteger(message.bytes) && message.bytes >= 16
        && message.bytes <= LIMIT && /^[a-f0-9]{64}$/.test(message.sha256), 'REPLY_BEGIN_INVALID');
      this.discard = null;
      const { id, mime, source_epoch, bytes, sha256, width, height, fps } = message;
      this.upload = { meta: { id, mime, source_epoch, bytes, sha256, width, height, fps }, chunks: [], received: 0,
        worker: this.broker.worker };
      this.uploadTimer = setTimeout(() => this.reject(id, 'REPLY_UPLOAD_TIMEOUT'), this.broker.config.replyUploadTimeoutMs);
      this.uploadTimer.unref?.();
    } catch (error) { this.reject(message.id, safeCode(error)); }
  }
  binary(data) {
    if (!this.upload) {
      if (this.discard && data.length <= this.discard.remaining) { this.discard.remaining -= data.length; return; }
      throw mediaError('REPLY_BINARY_WITHOUT_BEGIN');
    }
    const upload = this.upload;
    if (data.length === 0 || data.length > 8 * 1024 * 1024 || upload.received + data.length > upload.meta.bytes
      || upload.chunks.length >= 512) { this.reject(upload.meta.id, 'REPLY_BYTE_LIMIT'); return; }
    upload.chunks.push(data); upload.received += data.length;
  }
  end(message) {
    if (this.discard?.id === message.id && !this.upload) { this.discard = null; return; }
    if (!this.upload || this.upload.meta.id !== message.id) { this.reject(message.id, 'REPLY_END_WITHOUT_BEGIN', false); return; }
    const upload = this.upload; clearTimeout(this.uploadTimer); this.uploadTimer = null; this.upload = null;
    this.validation = upload; upload.validationStarted = this.clock();
    try {
      need(this.broker.current?.id === message.id && message.sha256 === upload.meta.sha256
        && upload.received === upload.meta.bytes, 'REPLY_END_INVALID');
      const meta = { requestId: message.id, sourceEpoch: upload.meta.source_epoch, ...upload.meta };
      let normalized;
      if (this.validator) normalized = this.validator.normalize(upload.chunks, meta);
      else {
        const bytes = Buffer.concat(upload.chunks);
        need(createHash('sha256').update(bytes).digest('hex') === upload.meta.sha256, 'REPLY_SHA_MISMATCH');
        normalized = this.normalize(bytes, meta);
      }
      upload.chunks = [];
      if (normalized?.then) return normalized.then((result) => this.admit(upload, result), (error) => this.validationFailed(upload, error))
        .catch(() => {
          // The caller need not await this control operation. Reason: a status/socket callback failure must not become an unhandled rejection that kills the independent media service.
          this.lifetime.control_callback_errors++;
        });
      this.admit(upload, normalized);
    } catch (error) { this.validationFailed(upload, error); }
  }
  validationFailed(upload, error) {
    if (this.validation !== upload || this.closed) return;
    this.validation = null; this.reject(upload.meta.id, safeCode(error));
  }
  admit(upload, normalized) {
    if (this.validation !== upload || this.closed) return;
    this.validation = null;
    try {
      need(this.broker.current?.id === upload.meta.id && upload.worker === this.broker.worker, 'REPLY_NOT_ACTIVE');
      need(isPlayableClip(normalized.clip) && normalized.clip.compatibilitySignature === this.player.compatibilitySignature
        && normalized.clip.durationSeconds <= 120 && this.replies.size < SLOTS, 'REPLY_DECODER_INCOMPATIBLE');
      const id = upload.meta.id, duration = normalized.clip.durationSeconds;
      const reply = { id, worker: upload.worker, done: this.heldDone.get(id) || null, ended: false, started: false, duration, timer: null };
      this.player.enqueueSpeech(normalized.clip, { slot: id }); this.replies.set(id, reply); this.heldDone.delete(id); this.accepted++;
      const elapsed = Math.max(0, this.clock() - upload.validationStarted);
      this.lifetime.validation_last_ms = elapsed; this.lifetime.validation_max_ms = Math.max(this.lifetime.validation_max_ms, elapsed);
      // Each slot owns its guard, separate from generation. Reason: the next request's deadline must not overwrite a reply still waiting for its full clip boundary.
      if (this.broker.current?.id === id) { clearTimeout(this.broker.timer); this.broker.timer = null; }
      const queuedSeconds = [...this.replies.values()].reduce((sum, value) => sum + value.duration, 0);
      reply.timer = setTimeout(() => this.reject(id, 'REPLY_PLAYBACK_TIMEOUT'), (queuedSeconds + 20) * 1000); reply.timer.unref?.();
      this.broker.send(reply.worker, { type: 'reply.clip.accepted', id, duration_seconds: duration }); this.broker.publishStatus();
    } catch (error) { this.reject(upload.meta.id, safeCode(error)); }
  }
  markDone(id, message = { id, status: 'done' }) {
    const reply = this.replies.get(id);
    if (reply) reply.done = { ...message, id };
    else if (this.upload?.meta.id === id || this.validation?.meta.id === id) this.heldDone.set(id, { ...message, id });
    else return false;
    this.completeIfReady(id); return true;
  }
  terminal(message) {
    if (message.status === 'done') return this.markDone(message.id, message);
    if (['error', 'interrupted'].includes(message.status)) this.cancel({ id: message.id, allowDrain: false });
    return false;
  }
  completeIfReady(id) {
    const reply = this.replies.get(id); if (!reply?.ended || !reply.done) return;
    clearTimeout(reply.timer); this.replies.delete(id); this.finish(id, reply.done);
  }
  cancel({ id = this.broker.current?.id, all = false, allowDrain = true } = {}) {
    const matches = (value) => all || (id !== undefined && value === id);
    if (this.upload && matches(this.upload.meta.id)) {
      if (allowDrain) this.discard = { id: this.upload.meta.id, remaining: this.upload.meta.bytes - this.upload.received };
      else this.discard = null;
      clearTimeout(this.uploadTimer); this.uploadTimer = null; this.upload.chunks = []; this.upload = null;
    }
    if (!allowDrain && (all || (this.discard && matches(this.discard.id)))) this.discard = null;
    if (this.validation && matches(this.validation.meta.id)) this.validation = null;
    for (const [key, reply] of this.replies) if (matches(key)) {
      clearTimeout(reply.timer); this.player.cancelSpeech(key); this.replies.delete(key);
    }
    for (const key of this.heldDone.keys()) if (matches(key)) this.heldDone.delete(key);
    // Cancellation never rebuilds the media clock. Reason: unsent slots can be removed, while already committed media drains without a ghost ACK or a broken AAC join.
  }
  producerLost() {
    if (this.upload) this.cancel({ id: this.upload.meta.id, allowDrain: false });
    if (this.validation) this.cancel({ id: this.validation.meta.id, allowDrain: false });
    for (const reply of this.replies.values()) {
      reply.producerLost = true; reply.done = { id: reply.id, role: 'system', status: 'error', reason: 'producer_lost' };
      this.completeIfReady(reply.id);
    }
    this.discard = null;
  }
  close() {
    this.closed = true; this.cancel({ all: true, allowDrain: false }); this.player.stop(); this.validator?.close();
    if (this.recoveryTimer !== null) (this.options.cancel || clearTimeout)(this.recoveryTimer);
    this.recoveryTimer = null;
  }
}
