import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { MediaMetrics } from './media-metrics.js';
import { LocalRelay } from './local-relay.js';
import { StreamRelay } from './stream-relay.js';
import { AutonomousTalk } from './autonomous-talk.js';
import { ContinuousActorSource } from './continuous-actor-source.js';
import { enqueueInteraction } from './interaction-priority.js';

const finished = new Set(['done', 'error', 'interrupted']);

export class Broker extends EventEmitter {
  constructor(config, { idlePlaylist = null, localOptions = {}, autonomousOptions = {},
    actorSourceFactory = options => new ContinuousActorSource(options) } = {}) {
    super();
    this.config = config;
    this.worker = null;
    this.workerInfo = { connected: false, engine: null, mode: null };
    this.mediaMetrics = new MediaMetrics();
    this.stream = this.emptyStream();
    this.init = null;
    this.fragments = [];
    this.cachedBytes = 0;
    this.viewers = new Set();
    this.httpViewers = new Set();
    this.chunkedViewers = new WeakSet();
    this.pending = [];
    this.current = null;
    // Production and planned playback own different slots. Reason: a hot GPU
    // must prepare the next reply while a previously admitted clip is airing.
    this.activeJobs = new Map();
    this.timer = null;
    this.history = [];
    this.interrupting = false;
    this.interruptCommandId = null;
    if (config.idlePlaylistManifest && !idlePlaylist) throw new Error('Enabled local idle requires a verified playlist before startup');
    this.localMode = config.replyMediaMode || 'sealed-replies';
    this.local = idlePlaylist ? new (this.localMode === 'streamed-replies-v1' ? StreamRelay : LocalRelay)(
      this, idlePlaylist, localOptions) : null;
    this.autonomous = new AutonomousTalk(this, autonomousOptions);
    this.actorSourceState = { ready: false, reason: 'disabled' };
    this.actorSource = config.continuousActorEnabled ? actorSourceFactory({ onChange: snapshot => {
      this.actorSourceState = snapshot;
      if (snapshot.ready) this.dispatch();
      this.publishStatus();
    } }) : null;
    if (this.actorSource) {
      this.actorSourceState = this.actorSource.snapshot();
      this.actorSource.start();
    }
  }

  emptyStream() {
    return { ready: false, mime: null, epoch: null, width: null, height: null, fps: null };
  }

  status() {
    return {
      worker: { ...this.workerInfo },
      stream: { ...this.stream },
      media: this.mediaMetrics.snapshot(),
      local: this.local ? this.local.snapshot() : { enabled: false },
      queue: { pending: this.pending.length, current: this.current?.id || null,
        active: this.activeJobs.size, capacity: this.workerInfo.replyPipeline ? 2 : 1,
        interrupting: this.interrupting },
      authRequired: Boolean(this.config.accessCode),
      viewers: this.viewers.size + this.httpViewers.size,
      autonomous: this.autonomous?.snapshot() || { enabled: false, state: 'disabled', completed: 0, topic: null },
      actorSource: { ...this.actorSourceState },
    };
  }

  send(socket, data, binary = false) {
    if (this.chunkedViewers.has(socket)) {
      if (binary) {
        // Only opted-in viewers change message size. Reason: this diagnostic must not alter the default media protocol.
        for (let offset = 0; offset < data.length; offset += 32 * 1024) {
          if (!this.sendMessage(socket, data.subarray(offset, offset + 32 * 1024), true)) return false;
        }
        return true;
      }
      if (data.type === 'stream.reset') data = { ...data, transport: 'fmp4-chunks' };
    }
    return this.sendMessage(socket, data, binary);
  }

  sendMessage(socket, data, binary = false) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const viewer = this.viewers.has(socket);
    if (viewer) this.mediaMetrics.recordViewerPending(socket.bufferedAmount);
    if (socket.bufferedAmount > this.config.maxClientBufferedBytes) {
      if (viewer) this.mediaMetrics.recordBackpressureClose();
      socket.close(1013, 'Playback connection is too slow; reconnect');
      return false;
    }
    try { socket.send(binary ? data : JSON.stringify(data), { binary }); }
    catch {
      // A failed viewer owns only its connection. Reason: one socket must not
      // throw through the shared media pump and reset every viewer's timeline.
      if (viewer) { this.viewers.delete(socket); try { socket.terminate?.(); } catch {} }
      return false;
    }
    if (viewer) this.mediaMetrics.recordViewerPending(socket.bufferedAmount);
    return true;
  }

  broadcast(data, binary = false) {
    for (const viewer of this.viewers) this.send(viewer, data, binary);
    if (binary) for (const response of this.httpViewers) this.sendHttpMedia(response, data);
  }

  publishStatus() {
    const status = this.status();
    this.broadcast({ type: 'status', ...status });
    this.emit('status', status);
  }

  chatEvent(event) {
    const id = String(event.id || '');
    const request = this.activeJobs.get(id) || (this.current?.id === id ? this.current : null)
      || this.pending.find(item => item.id === id);
    const platform = ['x-live', 'paid-message'].includes(request?.source) ? request
      : this.history.findLast(item => item.id === id && ['x-live', 'paid-message'].includes(item.source));
    const paid = platform?.source === 'paid-message' ? platform : null;
    const safe = {
      type: 'chat.event', id,
      role: ['user', 'assistant', 'system'].includes(event.role) ? event.role : 'system',
      text: String(event.text || '').slice(0, 6000),
      status: String(event.status || ''),
      error: typeof event.error === 'string' ? event.error.slice(0, 600) : undefined,
      source: platform ? platform.source : event.source === 'autonomous-crypto' || this.autonomous?.owns(event.id)
        ? 'autonomous-crypto' : undefined,
      ...(paid ? { paymentId: paid.paymentId, chain: paid.chain, ca: paid.ca,
        amountAtomic: paid.amountAtomic,
        ...(paid.logoUrl ? { logoUrl: paid.logoUrl } : {}),
        ...(paid.symbol ? { symbol: paid.symbol } : {}) } : platform ? { broadcastId: platform.broadcastId, eventId: platform.eventId,
        ...(platform.author ? { author: { ...platform.author } } : {}) } : {}),
      completion: event.completion === 'actor-output-admission' ? event.completion : undefined,
    };
    this.history.push(safe);
    if (this.history.length > 60) this.history.shift();
    this.broadcast(safe);
    this.emit('chat', safe);
  }

  attachViewer(socket, { chunks = false } = {}) {
    if (this.viewers.size + this.httpViewers.size >= this.config.maxViewers) {
      socket.close(1013, 'Demo viewer capacity reached');
      return;
    }
    this.viewers.add(socket);
    if (chunks) this.chunkedViewers.add(socket);
    this.send(socket, { type: 'status', ...this.status() });
    for (const event of this.history) this.send(socket, event);
    if (this.stream.epoch && this.init) {
      this.send(socket, { type: 'stream.reset', ...this.stream });
      this.send(socket, this.init, true);
      for (const fragment of this.fragments) this.send(socket, fragment, true);
    }
    socket.on('close', () => {
      this.viewers.delete(socket);
      this.publishStatus();
    });
  }

  attachHttpViewer(response) {
    if (this.viewers.size + this.httpViewers.size >= this.config.maxViewers
        || !this.stream.epoch || !this.init) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Media source unavailable or viewer capacity reached');
      return false;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store',
      'X-SBF-Epoch': this.stream.epoch });
    this.httpViewers.add(response);
    const cleanup = () => { if (this.httpViewers.delete(response)) this.publishStatus(); };
    response.once('close', cleanup);
    response.once('error', () => { cleanup(); response.destroy(); });
    response.flushHeaders?.();
    if (this.sendHttpMedia(response, this.init)) {
      for (const fragment of this.fragments) if (!this.sendHttpMedia(response, fragment)) break;
    }
    this.publishStatus();
    return true;
  }

  sendHttpMedia(response, data) {
    if (response.destroyed || response.writableEnded) return false;
    const pending = response.writableLength || 0;
    const limit = Math.min(8 * 1024 ** 2, this.config.maxClientBufferedBytes);
    this.mediaMetrics.recordViewerPending(pending);
    // Node's writable queue is the only HTTP queue. Reason: a slow diagnostic must not create an unbounded second media backlog.
    if (pending + data.length > limit) {
      this.mediaMetrics.recordBackpressureClose();
      response.destroy();
      return false;
    }
    try {
      response.write(data);
      this.mediaMetrics.recordViewerPending(response.writableLength || 0);
      return true;
    } catch {
      response.destroy();
      return false;
    }
  }

  attachWorker(socket) {
    if (this.worker?.readyState === WebSocket.OPEN) {
      socket.close(4409, 'Another GPU worker is already connected');
      return;
    }
    if (this.worker) {
      // Retire before callbacks can dispatch. Reason: a CLOSING producer cannot
      // retain a generation slot or receive work while its replacement binds.
      this.worker = null;
      this.workerInfo = { connected: false, engine: null, mode: null };
      this.interrupting = false; this.interruptCommandId = null;
      if (this.local) { this.local.producerLost?.(); this.failProducer('GPU旧连接已退出，未完成生成已清理。'); }
      else this.failAll('GPU旧连接已退出，未完成生成已清理。');
    }
    this.worker = socket;
    this.workerInfo = { connected: true, engine: null, mode: null };
    if (!this.local) this.resetMedia();
    this.publishStatus();
    socket.on('message', (data, binary) => {
      if (socket !== this.worker) return;
      try {
        if (binary) {
          if (this.continuousActor()) throw new Error('Control-only worker sent media');
          if (this.local) this.local.binary(Buffer.from(data));
          else this.receiveMedia(Buffer.from(data));
        }
        else this.receiveWorker(JSON.parse(data.toString()));
      } catch {
        socket.close(1008, 'Invalid worker protocol');
      }
    });
    socket.on('close', () => {
      if (socket !== this.worker) return;
      this.worker = null;
      this.interrupting = false;
      this.interruptCommandId = null;
      this.workerInfo = { connected: false, engine: null, mode: null };
      if (this.local) {
        this.local.producerLost?.();
        this.failProducer('GPU 连接已断开，请等待重新连接后发送。');
      } else { this.resetMedia(); this.failAll('GPU 连接已断开，请等待重新连接后发送。'); }
      this.publishStatus();
    });
  }

  retireProducer(socket) {
    if (socket !== this.worker) return false;
    // Close the dispatch gate before any failed receipt retires a request.
    // Reason: Python still owns the actor until this connection's cleanup has
    // completed; releasing only the server slot can otherwise dispatch a busy turn.
    this.workerInfo = { ...this.workerInfo, connected: false };
    try { socket.close(1011, 'Stream receipt delivery failed'); } catch { socket.terminate?.(); }
    this.publishStatus();
    return true;
  }

  resetMedia() {
    // Each HTTP response belongs to exactly one epoch. Reason: a client must reconnect for the next init instead of mixing timelines.
    const ended = [...this.httpViewers];
    this.httpViewers.clear();
    for (const response of ended) response.end();
    this.mediaMetrics.reset();
    this.stream = this.emptyStream();
    this.init = null;
    this.fragments = [];
    this.cachedBytes = 0;
  }

  receiveWorker(message) {
    if (!message || typeof message !== 'object') throw new Error('Invalid message');
    switch (message.type) {
      case 'worker.hello':
        if (!['avatar', 'test-pattern'].includes(message.mode)) throw new Error('Invalid mode');
        const directActor = message.mediaMode === 'continuous-actor-v1';
        if (directActor ? (!this.config.continuousActorEnabled || message.mode !== 'avatar')
          : this.local ? (message.mediaMode !== this.localMode || message.mode !== 'avatar')
            : ['sealed-replies', 'streamed-replies-v1'].includes(message.mediaMode)) {
          this.chatEvent({ role: 'system', status: 'error', text: 'GPU媒体模式与推流服务器不兼容，请更新配置后重连。' });
          throw new Error('Incompatible worker media mode');
        }
        this.workerInfo = {
          connected: true, engine: String(message.engine || 'unknown').slice(0, 60),
          mode: message.mode, workerId: String(message.workerId || '').slice(0, 80),
          voice: String(message.voice || '').slice(0, 100),
          chatMode: String(message.chatMode || '').slice(0, 40),
          autonomousCrypto: message.autonomousCrypto === 1 && message.chatMode === 'llm' && message.mode === 'avatar',
          mediaMode: directActor ? 'continuous-actor-v1' : this.local ? this.localMode : 'continuous',
          warmPrefetch: directActor && message.warm_prefetch === 1,
          replyPipeline: Boolean(!directActor && this.local && message.reply_pipeline === 1),
        };
        if (this.workerInfo.replyPipeline) this.send(this.worker, {
          type: 'worker.ready', reply_pipeline: 1, ...(this.localMode === 'streamed-replies-v1' ? { mediaMode: this.localMode } : {}),
        });
        this.publishStatus();
        this.dispatch();
        break;
      case 'stream.reset':
        if (this.continuousActor()) throw new Error('Control-only worker sent media reset');
        if (this.local) {
          this.local.sourceLost?.(this.current?.id);
          if (this.current && !this.local.hasReply(this.current.id)) this.local.cancel({ id: this.current.id });
          this.failProducer('GPU回复源已重置，待机画面继续播放。'); this.publishStatus(); break;
        }
        if (typeof message.epoch !== 'string' || !message.epoch || message.epoch.length > 128
          || typeof message.mime !== 'string' || message.mime.length > 160
          || !message.mime.startsWith('video/mp4')) throw new Error('Invalid stream metadata');
        this.resetMedia();
        this.stream = {
          ready: false, epoch: message.epoch, mime: message.mime,
          width: positive(message.width), height: positive(message.height), fps: positive(message.fps),
        };
        this.broadcast({ type: 'stream.reset', ...this.stream });
        this.publishStatus();
        break;
      case 'chat.event':
        if (!this.activeJobs.has(message.id)) return;
        if (this.current?.id === message.id && this.current.rejectionPending) {
          // Rejected generation is released only after the producer has retired it.
          // Reason: the next request may share a TCP read with rejected; a synchronous fault receipt does not yet clear Python's actor owner.
          if (['error', 'interrupted'].includes(message.status)) this.finishLocalJob(message.id);
          break;
        }
        if (!this.continuousActor() && this.local?.terminal(message)) return;
        this.chatEvent(message);
        if (finished.has(message.status)) {
          this.finishLocalJob(message.id);
        }
        break;
      case 'chat.rendered':
        this.releaseGeneration(message.id);
        break;
      case 'worker.error':
        if (this.local) {
          this.local.sourceLost?.(this.current?.id);
          if (this.current && !this.local.hasReply(this.current.id)) this.local.cancel({ id: this.current.id });
          this.failProducer('GPU回复暂时不可用，待机画面继续播放。');
        }
        else this.stream.ready = false;
        this.chatEvent({ role: 'system', text: String(message.message || 'GPU 服务错误'), status: 'error' });
        this.emit('workerError', String(message.message || 'GPU service error'));
        this.publishStatus();
        break;
      case 'reply.clip.begin':
        if (!this.local || this.workerInfo.mediaMode !== 'sealed-replies') throw new Error('Sealed mode not enabled');
        this.local.begin(message); break;
      case 'reply.clip.end':
        if (!this.local || this.workerInfo.mediaMode !== 'sealed-replies') throw new Error('Sealed mode not enabled');
        this.local.end(message); break;
      case 'stream.reply.begin':
      case 'stream.reply.part':
      case 'stream.reply.end':
        if (!this.local || this.workerInfo.mediaMode !== 'streamed-replies-v1') throw new Error('Streaming mode not enabled');
        this.local[message.type.split('.').at(-1)](message); break;
      case 'interrupt.ack':
        // Only the outstanding command owns this gate. Reason: a duplicate old
        // ACK must not cancel a new generation after its original gate closed.
        if (!this.interruptCommandId) break;
        if (this.interruptCommandId && message.id !== this.interruptCommandId
            && (this.workerInfo.replyPipeline || message.id !== undefined)) break;
        this.interrupting = false;
        this.interruptCommandId = null;
        if (message.status === 'error') this.failProducer('GPU未确认停止完成，请稍后重试。');
        else this.dispatch();
        this.publishStatus();
        break;
      case 'ping':
        this.send(this.worker, { type: 'pong' });
        break;
      case 'pong':
        break;
      default:
        throw new Error('Unknown worker message');
    }
  }

  receiveMedia(data) {
    if (!this.stream.epoch || data.length < 8) throw new Error('Media before stream reset');
    const boxType = data.toString('ascii', 4, 8);
    if (!this.init) {
      if (boxType !== 'ftyp' || !data.includes(Buffer.from('moov'))) throw new Error('Missing init segment');
      this.init = data;
      this.mediaMetrics.setInitBytes(data.length);
      this.broadcast(data, true);
      return;
    }
    if (boxType !== 'moof' || !data.includes(Buffer.from('mdat'))) throw new Error('Invalid media fragment');
    this.mediaMetrics.recordFragment(data.length);
    this.fragments.push(data);
    this.cachedBytes += data.length;
    while (this.fragments.length > 3 || this.cachedBytes > this.config.maxCachedMediaBytes) {
      this.cachedBytes -= this.fragments.shift().length;
    }
    this.mediaMetrics.setCache(this.fragments.length, this.cachedBytes);
    this.broadcast(data, true);
    if (!this.stream.ready) {
      this.stream.ready = true;
      this.publishStatus();
    }
  }

  submit(text, metadata = {}) {
    if (this.interrupting) {
      throw Object.assign(new Error('正在停止上一条回复，请稍后发送。'), { statusCode: 409 });
    }
    if (!this.generationReady()) {
      throw Object.assign(new Error('GPU 视频服务尚未就绪。'), { statusCode: 503 });
    }
    if (this.workerInfo.mode !== 'avatar') {
      throw Object.assign(new Error('当前为连接测试画面，不能生成数字人回复。'), { statusCode: 409 });
    }
    // Verified paid ingress reserves its own bounded pending capacity.
    // Reason: a full X queue must not force paid outbox delivery to miss the next actor slot; ordinary ingress still counts all pending work.
    const queued = metadata.source === 'paid-message'
      ? this.pending.filter(request => request.source === 'paid-message').length : this.pending.length;
    if (queued >= this.config.maxQueue) {
      throw Object.assign(new Error('等待队列已满，请稍后发送。'), { statusCode: 429 });
    }
    const request = this.createRequest(text, metadata);
    this.autonomous.warm.clear();
    const position = this.enqueue(request) + this.activeJobs.size + 1;
    this.chatEvent({ ...request, role: 'user', status: 'queued' });
    this.dispatch();
    this.publishStatus();
    return { id: request.id, position };
  }

  createRequest(text, metadata = {}) {
    return { id: randomUUID(), text, createdAt: Date.now(), ...metadata };
  }

  enqueue(request) { return enqueueInteraction(this.pending, request); }

  continuousActor() { return this.workerInfo.mediaMode === 'continuous-actor-v1'; }

  generationReady() {
    return this.workerInfo.connected && this.worker?.readyState === WebSocket.OPEN
      && (this.continuousActor() ? this.actorSourceState.ready === true
        : this.stream.ready && (!this.local || this.workerInfo.mediaMode === this.localMode));
  }

  dispatch() {
    if (this.current || this.interrupting || !this.pending.length || !this.workerInfo.connected
        || (this.continuousActor() && !this.generationReady())
        || this.activeJobs.size >= (this.workerInfo.replyPipeline ? 2 : 1)) return;
    this.current = this.pending.shift();
    this.activeJobs.set(this.current.id, this.current);
    if (!this.send(this.worker, { type: 'chat.request', ...this.current })) {
      this.failProducer('GPU 连接不可用。');
      return;
    }
    const generationId = this.current.id;
    this.timer = setTimeout(() => {
      if (this.current?.id !== generationId) return;
      this.interrupting = true;
      this.interruptCommandId = randomUUID();
      this.send(this.worker, { type: 'interrupt', id: this.interruptCommandId, request_id: generationId });
      this.local?.cancel({ id: generationId });
      this.finishLocalJob(generationId, { id: generationId, role: 'system', status: 'error', text: '本次生成超时，已停止该回复。' });
      this.publishStatus();
    }, this.config.chatTimeoutMs);
    this.timer.unref?.();
  }

  clearCurrent({ keepJob = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!keepJob && this.current) this.activeJobs.delete(this.current.id);
    this.current = null;
  }

  releaseGeneration(id) {
    if (!this.workerInfo.replyPipeline || this.current?.id !== id || this.current.rejectionPending || !this.local?.hasReply?.(id)) return false;
    this.clearCurrent({ keepJob: true });
    this.dispatch(); this.publishStatus(); return true;
  }

  finishLocalJob(id, terminal = null) {
    if (!this.activeJobs.has(id)) return false;
    if (terminal && !this.activeJobs.get(id).rejectionPending) this.chatEvent({ id, role: 'system', text: terminal.status === 'error'
      ? '回复未完成，已继续待机。' : '', ...terminal });
    this.activeJobs.delete(id);
    if (this.current?.id === id) this.clearCurrent();
    this.dispatch(); this.publishStatus(); return true;
  }

  rejectLocalJob(id, terminal) {
    if (!this.activeJobs.has(id)) return false;
    if (this.current?.id !== id) return this.finishLocalJob(id, terminal);
    if (this.current.rejectionPending) return true;
    this.chatEvent(terminal); this.current.rejectionPending = true;
    clearTimeout(this.timer);
    // Bound missing producer terminal ACK, independently of upload duration.
    // Reason: waiting for cleanup must neither hold a generation forever nor reuse an actor whose cleanup was never confirmed.
    this.timer = setTimeout(() => {
      if (this.current?.id !== id || !this.current.rejectionPending) return;
      this.interrupting = true; this.interruptCommandId = randomUUID();
      this.send(this.worker, { type: 'interrupt', id: this.interruptCommandId, request_id: id });
      this.finishLocalJob(id); this.publishStatus();
    }, Math.min(5000, this.config.replyUploadTimeoutMs));
    this.timer.unref?.(); this.publishStatus(); return true;
  }

  failProducer(text) {
    const keepCleanupGate = Boolean(this.worker && this.current?.rejectionPending);
    const failed = [...this.activeJobs.values()].filter(request => !this.local?.hasReply?.(request.id)
      && !(keepCleanupGate && request === this.current));
    const queued = this.pending; this.pending = [];
    // Already sealed media belongs to the relay, not the producer connection.
    // Reason: a GPU error must not erase an independently playable reply/idle.
    for (const request of failed) {
      this.activeJobs.delete(request.id);
      if (!request.rejectionPending) this.chatEvent({ id: request.id, role: 'system', text, status: 'error' });
    }
    if (this.current && !keepCleanupGate) this.clearCurrent({ keepJob: this.local?.hasReply?.(this.current.id) === true });
    for (const request of queued) this.chatEvent({ id: request.id, role: 'system', text, status: 'error' });
  }

  failAll(text) {
    const requests = [...this.activeJobs.values(), ...this.pending];
    this.pending = [];
    this.clearCurrent();
    this.activeJobs.clear();
    for (const request of requests) {
      if (!request.rejectionPending) this.chatEvent({ id: request.id, role: 'system', text, status: 'error' });
    }
  }

  interrupt() {
    this.autonomous.setEnabled(false);
    this.interrupting = this.workerInfo.connected;
    this.interruptCommandId = this.workerInfo.connected ? randomUUID() : null;
    if (this.workerInfo.connected) this.send(this.worker, { type: 'interrupt', id: this.interruptCommandId });
    this.local?.cancel({ all: true });
    for (const request of [...this.activeJobs.values(), ...this.pending]) {
      if (!request.rejectionPending) this.chatEvent({ id: request.id, role: 'system', text: '已停止回复。', status: 'interrupted' });
    }
    this.pending = [];
    this.clearCurrent();
    this.activeJobs.clear();
    this.publishStatus();
  }

  close() {
    this.actorSource?.close();
    this.autonomous.close();
    this.local?.close();
    this.clearCurrent();
    this.activeJobs.clear();
    this.worker?.terminate();
    for (const viewer of this.viewers) viewer.terminate();
    for (const response of this.httpViewers) response.destroy();
    this.httpViewers.clear();
  }
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
