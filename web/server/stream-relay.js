import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StreamPlayout } from './stream-playout.js';
import { StreamValidator } from './stream-validator.js';
import { StreamReceiveTimings } from './stream-receive-timings.js';
import { mediaError } from './local-fmp4.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/, HASH = /^[a-f0-9]{64}$/;
const LIMIT = 64 * 1024 * 1024, PART = 8 * 1024 * 1024, CHUNK = 256 * 1024;
function need(value, code) { if (!value) throw mediaError(code); }
function codeOf(error) { return /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'STREAM_REPLY_INVALID'; }

export class StreamRelay {
  constructor(broker, playlist, options = {}) {
    need(playlist?.mode === 'streamed-replies-v1' && Array.isArray(playlist.idleClips) && playlist.idleClips.length === 3, 'STREAM_IDLE_REQUIRED');
    this.broker = broker; this.playlist = playlist; this.options = options; this.validator = options.validator || new StreamValidator();
    this.clock = options.now || (() => performance.now()); this.schedule = options.schedule || setTimeout; this.unschedule = options.cancel || clearTimeout;
    this.timings = new StreamReceiveTimings({ clock: this.clock,
      report: options.onIngestTiming ?? (row => console.info('stream_ingest_timing ' + JSON.stringify(row))) });
    this.sessions = new Map(); this.assembly = null; this.discard = null; this.controlTimer = null; this.recoveryTimer = null;
    this.closed = false; this.kind = 'idle'; this.accepted = 0; this.rejected = 0;
    this.lifetime = { stream_restarts: 0, scheduler_faults_total: 0, last_fault_code: null, last_restart_reason: 'startup',
      control_callback_errors: 0, validation_last_ms: 0, validation_max_ms: 0, source_faults_total: 0 };
    this.restart('startup');
  }
  call(fn) { try { return fn(); } catch { this.lifetime.control_callback_errors++; return undefined; } }
  send(worker, message) { return this.call(() => this.broker.send(worker, message)); }
  ack(session, message, trace = null) {
    if (this.send(session.worker, message) === true) {
      this.timings.ackQueued(trace, session.worker?.bufferedAmount); return true;
    }
    // Disable dispatch before freeing the server slot, then retire only its producer connection.
    // Reason: Python still owns the turn while awaiting the lost ACK; immediate dispatch would reuse a busy actor. Closing WS runs its owned cleanup while the hot media reader remains independent.
    if (session.worker === this.broker.worker) this.broker.workerInfo = { ...this.broker.workerInfo, connected: false };
    this.call(() => typeof this.broker.retireProducer === 'function' ? this.broker.retireProducer(session.worker)
      : session.worker?.close?.(1011, 'Stream receipt delivery failed'));
    this.cancel({ id: session.id, allowDrain: false });
    this.finish(session.id, { id: session.id, role: 'system', status: 'error', error: 'STREAM_ACK_SEND_FAILED' }); this.publish(); return false;
  }
  publish() { this.call(() => this.broker.publishStatus()); }
  live(session) { return !this.closed && this.sessions.get(session.id) === session && !session.cancelled; }
  restart(reason = 'explicit_recovery') {
    if (this.player) this.lifetime.stream_restarts++;
    this.lifetime.last_restart_reason = /^[A-Z_a-z0-9]{1,64}$/.test(reason) ? reason : 'explicit_recovery';
    this.player?.stop(); this.broker.resetMedia();
    this.broker.stream = { ready: false, epoch: randomUUID(), mime: this.playlist.mime, width: 1920, height: 1080,
      fps: 30, source: 'local-playlist-stream', playbackPolicy: { targetSeconds: 1.2, lowWaterSeconds: 0.25, maxLagSeconds: 2.5 } };
    this.broker.broadcast({ type: 'stream.reset', ...this.broker.stream }); this.kind = 'idle';
    this.player = new StreamPlayout({ minStartBlocks: 2, ...this.options, init: this.playlist.init, idleClips: this.playlist.idleClips,
      sink: data => { this.broker.receiveMedia(data); return { accepted: true, pendingBytes: 0 }; },
      onTagStart: event => {
        this.kind = event.kind; const session = this.sessions.get(event.slot);
        if (session) { session.started = true; session.queueWaitMs = event.queueWaitMs; }
        this.publish();
      },
      onTagEnd: event => this.tagEnded(event),
      onSourceFault: event => {
        this.lifetime.source_faults_total++; const session = this.sessions.get(event.slot);
        if (session) this.reject(session.id, event.code);
      },
      onFault: error => {
        if (this.closed) return;
        const code = codeOf(error); this.lifetime.scheduler_faults_total++; this.lifetime.last_fault_code = code;
        this.cancel({ all: true, allowDrain: false }); this.call(() => this.broker.failAll('本地调度故障，正在恢复待机。'));
        // Only a genuine shared scheduler fault rebuilds the epoch, at bounded frequency.
        // Reason: GPU/validator/request faults must not reset every viewer's independent idle clock.
        this.recoveryTimer = this.schedule(() => { this.recoveryTimer = null; if (!this.closed) { this.restart(code); this.publish(); } }, 250);
        this.recoveryTimer.unref?.();
      } });
    this.player.start();
  }
  hasReply(id) { return this.sessions.get(id)?.admitted === true; }
  finish(id, terminal = null) {
    this.call(() => {
      if (typeof this.broker.finishLocalJob === 'function') this.broker.finishLocalJob(id, terminal);
      else if (this.broker.current?.id === id) { if (terminal) this.broker.chatEvent(terminal); this.broker.clearCurrent(); this.broker.dispatch(); }
    });
  }
  reject(id, code, failJob = true) {
    id = typeof id === 'string' && ID.test(id) ? id : ''; const session = this.sessions.get(id);
    this.rejected++; this.send(session?.worker || this.broker.worker, { type: 'stream.reply.rejected', id, code });
    if (!failJob) return;
    this.cancel({ id });
    const terminal = { id, role: 'system', status: 'error', text: '回复流无法继续，待机画面保持播放。', error: code };
    this.call(() => typeof this.broker.rejectLocalJob === 'function' ? this.broker.rejectLocalJob(id, terminal) : this.finish(id, terminal));
    this.publish();
  }
  begin(message) {
    const arrivedAt = this.timings.arrival();
    const id = message?.id;
    if (id !== this.broker.current?.id) { this.reject(id, 'STREAM_NOT_ACTIVE', false); return; }
    try {
      need(!this.closed && typeof id === 'string' && ID.test(id) && !this.sessions.has(id) && this.sessions.size < 2 && !this.assembly, 'STREAM_BEGIN_BUSY');
      need(message.mime === this.playlist.mime && message.width === 1920 && message.height === 1080 && message.fps === 30
        && typeof message.source_epoch === 'string' && message.source_epoch.length > 0 && message.source_epoch.length <= 128
        && Number.isSafeInteger(message.init_bytes) && message.init_bytes > 16 && message.init_bytes <= 65536
        && HASH.test(message.init_sha256), 'STREAM_BEGIN_INVALID');
      const session = { id, worker: this.broker.worker, mime: message.mime, createdAt: this.clock(), progressAt: this.clock(),
        ready: false, admitted: false, parts: 0, bytes: 0, blocks: 0, pending: [], hash: createHash('sha256'),
        initBytes: message.init_bytes, ending: false, endAccepted: false, wallEnded: false, played: false, done: null, producerLost: false };
      this.sessions.set(id, session); this.discard = null;
      this.assembly = { session, kind: 'init', bytes: message.init_bytes, sha256: message.init_sha256, received: 0, chunks: [], hash: createHash('sha256'),
        trace: this.timings.begin(id, 'init', null, message.init_bytes, arrivedAt) };
      this.arm();
    } catch (error) { this.reject(id, codeOf(error)); }
  }
  part(message) {
    const arrivedAt = this.timings.arrival();
    const session = this.sessions.get(message?.id);
    if (!session) {
      this.reject(message?.id, 'STREAM_NOT_ACTIVE', false);
      // Drain only this one declared bounded stale packet; never authorize the next connection.
      // Reason: an already-in-flight failed request must not make its remaining binary look like a new request's init.
      if (!this.assembly && Number.isSafeInteger(message?.bytes) && message.bytes > 16 && message.bytes <= PART)
        this.discard = { id: message.id, remaining: message.bytes };
      return;
    }
    try {
      need(session.ready && !session.ending && session.worker === this.broker.worker && !this.assembly, 'STREAM_PART_STATE');
      need(Number.isSafeInteger(message.index) && message.index === session.parts && message.index < 225, 'STREAM_PART_ORDER');
      need(Number.isSafeInteger(message.bytes) && message.bytes > 16 && message.bytes <= PART && HASH.test(message.sha256)
        && session.bytes + session.initBytes + message.bytes <= LIMIT, 'STREAM_PART_BOUND');
      need(session.pending.length < 3 && this.pendingBytes() + message.bytes <= 16 * 1024 * 1024, 'STREAM_WINDOW_LIMIT');
      this.assembly = { session, kind: 'part', index: message.index, bytes: message.bytes, sha256: message.sha256, received: 0, chunks: [], hash: createHash('sha256'),
        trace: this.timings.begin(session.id, 'part', message.index, message.bytes, arrivedAt) };
    } catch (error) { this.reject(session.id, codeOf(error)); }
  }
  binary(data) {
    const arrivedAt = this.timings.arrival();
    if (!this.assembly) {
      if (this.discard && Buffer.isBuffer(data) && data.length > 0 && data.length <= CHUNK && data.length <= this.discard.remaining) {
        this.discard.remaining -= data.length; if (!this.discard.remaining) this.discard = null; return;
      }
      throw mediaError('STREAM_BINARY_WITHOUT_PACKET');
    }
    const packet = this.assembly, session = packet.session;
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > CHUNK || packet.received + data.length > packet.bytes || packet.chunks.length >= 128) {
      this.reject(session.id, 'STREAM_BINARY_BOUND'); return;
    }
    this.timings.binary(packet.trace, packet.received + data.length === packet.bytes, arrivedAt);
    packet.chunks.push(data); packet.received += data.length; packet.hash.update(data); session.hash.update(data);
    if (packet.received !== packet.bytes) return;
    this.assembly = null; session.progressAt = this.clock();
    if (packet.hash.digest('hex') !== packet.sha256) { this.reject(session.id, packet.kind === 'init' ? 'STREAM_INIT_SHA' : 'STREAM_PART_SHA'); return; }
    const bytes = Buffer.concat(packet.chunks); packet.chunks = [];
    this.timings.assembled(packet.trace);
    if (packet.kind === 'init') {
      this.async(session, () => {
        this.timings.validationStarted(packet.trace);
        return this.validator.begin(session.id, { init: bytes, mime: session.mime,
          compatibilitySignature: this.player.compatibilitySignature });
      }, result => {
        this.timings.validated(packet.trace, result?.timing); this.timings.credited(packet.trace);
        session.ready = true; this.ack(session, { type: 'stream.reply.ready', id: session.id }, packet.trace); this.publish();
      });
    } else {
      const pending = { index: packet.index, bytes: packet.bytes, blocks: null, trace: packet.trace }; session.pending.push(pending); session.parts++; session.bytes += bytes.length;
      this.async(session, () => {
        this.timings.validationStarted(packet.trace); return this.validator.push(session.id, packet.index, bytes);
      }, result => {
        need(Array.isArray(result.blocks) && result.blocks.length <= 4, 'STREAM_VALIDATOR_RESULT'); pending.blocks = [...result.blocks];
        const ms = result.validationMs; need(Number.isFinite(ms) && ms >= 0, 'STREAM_VALIDATOR_RESULT');
        this.lifetime.validation_last_ms = ms; this.lifetime.validation_max_ms = Math.max(ms, this.lifetime.validation_max_ms);
        this.timings.validated(packet.trace, result.timing);
        this.admit(session);
      });
    }
  }
  async(session, operation, success) {
    // Own every asynchronous rejection and verify session identity again after awaiting.
    // Reason: cancellation/reconnect must not admit a stale worker result into a new request or kill the independent player with an unhandled Promise.
    Promise.resolve().then(() => {
      need(this.live(session), 'STREAM_SESSION_RETIRED'); return operation();
    }).then(result => { if (this.live(session)) success(result); })
      .catch(error => { if (this.live(session)) this.reject(session.id, codeOf(error)); });
  }
  admit(session) {
    if (!this.live(session)) return;
    while (session.pending.length && session.pending[0].blocks !== null) {
      const part = session.pending[0];
      while (part.blocks.length) {
        // Slot creation and first-block ownership are separate states.
        // Reason: a full playout queue may refuse credit after creating the slot; a retry must not create the same slot twice.
        if (!session.playoutBegun) { this.player.beginSpeech(session.id); session.playoutBegun = true; }
        const credit = this.player.appendSpeech(session.id, part.blocks[0]);
        if (!credit.accepted) { this.timings.creditBlocked(part.trace); return; }
        session.admitted = true; session.blocks++; part.blocks.shift();
      }
      session.pending.shift(); session.progressAt = this.clock();
      this.timings.credited(part.trace);
      if (!this.ack(session, { type: 'stream.reply.part.accepted', id: session.id, index: part.index }, part.trace)) return;
    }
    this.acceptEnd(session);
  }
  end(message) {
    const session = this.sessions.get(message?.id);
    if (!session) { if (this.discard?.id === message?.id) this.discard = null; this.reject(message?.id, 'STREAM_END_WITHOUT_BEGIN', false); return; }
    try {
      need(session.ready && !session.ending && !this.assembly && session.worker === this.broker.worker && session.parts > 0
        && message.parts === session.parts && message.bytes === session.bytes && HASH.test(message.source_sha256), 'STREAM_END_INVALID');
      need(session.hash.digest('hex') === message.source_sha256, 'STREAM_SOURCE_SHA'); session.ending = true;
      this.async(session, () => this.validator.end(session.id), receipt => {
        need(receipt.sample_bytes_unchanged === true && receipt.source_included_sha256 === message.source_sha256, 'STREAM_END_RECEIPT');
        session.receipt = receipt; this.admit(session);
      });
    } catch (error) { this.reject(session.id, codeOf(error)); }
  }
  acceptEnd(session) {
    if (!session.receipt || session.pending.length || session.endAccepted) return;
    need(session.admitted && session.receipt.blocks === session.blocks, 'STREAM_END_BLOCK_COUNT');
    this.player.endSpeech(session.id); session.endAccepted = true; session.progressAt = this.clock();
    if (this.broker.current?.id === session.id) { clearTimeout(this.broker.timer); this.broker.timer = null; }
    // accepted precedes played even if wall completion raced with control receipt.
    // Reason: Python only commits after the full stream receipt and the server's complete planned slot, not first-block admission.
    if (!this.ack(session, { type: 'stream.reply.accepted', id: session.id, blocks: session.blocks })) return;
    this.accepted++; this.maybePlayed(session); this.publish();
  }
  tagEnded(event) {
    if (event.kind !== 'speech') return;
    const session = this.sessions.get(event.slot); if (!session) return;
    session.wallEnded = true;
    if (event.status !== 'completed') { this.reject(session.id, event.code || 'STREAM_PLAYBACK_CANCELLED'); return; }
    this.maybePlayed(session);
  }
  maybePlayed(session) {
    if (!this.live(session) || !session.endAccepted || !session.wallEnded || session.played) return;
    if (session.producerLost || session.worker !== this.broker.worker || !this.broker.workerInfo.connected) {
      this.retire(session); this.finish(session.id, { id: session.id, role: 'system', status: 'error', reason: 'producer_lost' }); return;
    }
    if (!this.ack(session, { type: 'stream.reply.played', id: session.id })) return;
    session.played = true; this.completeIfReady(session.id);
  }
  markDone(id, message = { id, status: 'done' }) {
    const session = this.sessions.get(id); if (!session) return false;
    session.done = { ...message, id }; this.completeIfReady(id); return true;
  }
  terminal(message) {
    if (message.status === 'done') return this.markDone(message.id, message);
    if (['error', 'interrupted'].includes(message.status)) this.cancel({ id: message.id, allowDrain: false }); return false;
  }
  completeIfReady(id) {
    const session = this.sessions.get(id); if (!session?.played || !session.done) return;
    this.retire(session); this.finish(id, session.done);
  }
  retire(session) { session.cancelled = true; this.sessions.delete(session.id); session.pending = []; }
  cancel({ id = this.broker.current?.id, all = false, allowDrain = true } = {}) {
    const match = value => all || (id !== undefined && value === id);
    if (this.assembly && match(this.assembly.session.id)) {
      const packet = this.assembly; this.discard = allowDrain ? { id: packet.session.id, remaining: packet.bytes - packet.received } : null;
      this.assembly.chunks = []; this.assembly = null;
    }
    if (!allowDrain && (all || match(this.discard?.id))) this.discard = null;
    for (const session of [...this.sessions.values()]) if (match(session.id)) {
      this.retire(session); this.player.cancelSpeech(session.id);
      void Promise.resolve(this.validator.cancel(session.id)).catch(() => { this.lifetime.control_callback_errors++; });
    }
  }
  sourceLost(id = this.broker.current?.id) {
    const session = this.sessions.get(id); if (session && !session.endAccepted) this.reject(id, 'STREAM_SOURCE_LOST');
  }
  producerLost() {
    for (const session of [...this.sessions.values()]) {
      // An already ACKed slot cannot wait forever for a disconnected producer's done.
      // Reason: commit/history belongs to that producer; a replacement must neither inherit its ACK nor keep its registry slot occupied.
      if (session.played) { this.retire(session); this.finish(session.id, { id: session.id, role: 'system', status: 'error', reason: 'producer_lost' }); }
      else if (session.endAccepted) { session.producerLost = true; this.maybePlayed(session); }
      else { const id = session.id; this.cancel({ id, allowDrain: false }); this.finish(id, { id, role: 'system', status: 'error', reason: 'producer_lost' }); }
    }
    this.discard = null;
  }
  pendingBytes() { return (this.assembly?.received || 0) + [...this.sessions.values()].reduce((sum, session) => sum + session.pending.reduce((size, part) => size + part.bytes, 0), 0); }
  arm() {
    if (this.closed || this.controlTimer !== null || !this.sessions.size) return;
    this.controlTimer = this.schedule(() => {
      this.controlTimer = null;
      for (const session of [...this.sessions.values()]) {
        try {
          const age = this.clock() - session.createdAt, idle = this.clock() - session.progressAt;
          need(age <= (session.endAccepted ? 260000 : 120000) && (session.endAccepted || idle <= this.broker.config.replyUploadTimeoutMs), 'STREAM_REPLY_TIMEOUT');
          this.admit(session);
        } catch (error) { if (this.live(session)) this.reject(session.id, codeOf(error)); }
      }
      this.arm();
    }, 20); this.controlTimer.unref?.();
  }
  snapshot() {
    return { enabled: true, mode: 'streamed-replies-v1', kind: this.kind, upload_bytes: this.assembly?.received || 0,
      upload_active: Boolean(this.assembly), validation_active: [...this.sessions.values()].some(session => session.pending.length > 0),
      admitted_replies: [...this.sessions.values()].filter(session => session.admitted).length, accepted: this.accepted, rejected: this.rejected,
      pending_source_bytes: this.pendingBytes(), validator: this.validator.snapshot(), ...this.timings.snapshot(), ...this.lifetime, ...this.player.snapshot() };
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.cancel({ all: true, allowDrain: false }); this.player.stop(); this.validator.close();
    for (const timer of [this.controlTimer, this.recoveryTimer]) if (timer !== null) this.unschedule(timer);
    this.controlTimer = this.recoveryTimer = null;
  }
}
