import mpegts from 'mpegts.js';
import { PlaybackDiagnostics } from './playback-diagnostics.js';
import { FlvLiveSync, FLV_SYNC_POLICY } from './flv-live-sync.js';
import { FlvPipelineProbe } from './flv-pipeline-probe.js';
import { ViewportFrameVisibility } from './viewport-frame-visibility.js';
import { FlvIngestWatchdog } from './flv-ingest-watchdog.js';

const SOURCE_PROFILES = new Map([
  ['/api/flv/live.flv', 'program'],
  ['/api/flv/actor.flv', 'actor-continuous'],
]);

// The maintained library owns HTTP streaming, FLV transmuxing and MSE.
// Reason: chat reconnects and tab visibility must not restart a healthy decoder.
export class FlvPlayer {
  constructor(video, onState, onLog, { Mpegts = mpegts, now = () => performance.now(),
    setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = id => clearTimeout(id),
    origin = () => location.origin, mediaPath = '/api/flv/live.flv' } = {}) {
    // Static entrypoints can select only owned streams. Reason: diagnostics need
    // an isolated actor profile without accepting arbitrary media URLs or queries.
    if (!SOURCE_PROFILES.has(mediaPath)) throw new TypeError('Unsupported FLV media path');
    Object.assign(this, { video, onState, onLog, Mpegts, now, setTimer, clearTimer, origin, mediaPath,
      sourceProfile: SOURCE_PROFILES.get(mediaPath),
      transport: 'flv', state: 'idle', source: null, engine: null, started: null,
      generation: 0, hidden: false, userPaused: false, frameRequest: null, retryTimer: null,
      reconnectAttempts: 0, playPending: false, broadcastLive: true });
    // The HTML autoplay attribute must not bypass the initial reserve below.
    // Reason: starting at the first tiny append reproduced startup stop/start.
    video.autoplay = false;
    this.pipelineProbe = new FlvPipelineProbe(video, now, () => this.bufferAhead());
    this.ingestWatchdog = new FlvIngestWatchdog(now);
    this.viewportFrames = new ViewportFrameVisibility(video, { now });
    this.diagnostics = new PlaybackDiagnostics(); this.resetMetrics();
    this.liveSync = new FlvLiveSync(video, now, (rate, previous) => {
      if (rate === 1 || previous === 1 || Math.abs(rate - (this.lastReportedRate ?? 1)) >= .05) {
        this.lastReportedRate = rate; this.recordPlayback('rate-change');
      }
    });
    video.addEventListener('playing', () => {
      if (this.started === null) return;
      this.recordPlayback('playing'); this.syncPlayback();
      this.reconnectAttempts = 0; this.startupPending = false; this.setState('playing');
    });
    video.addEventListener('waiting', () => {
      if (this.started === null || this.userPaused) return;
      // Record the triggering rate first: recovery's 1x must not hide prior catch-up.
      this.recordPlayback('waiting'); this.liveSync.recover();
      this.diagnostics.waiting(video, this.bufferAhead());
      if (this.firstFrameMs !== null) this.waitingAfterFirstFrame++;
      this.setState('buffering', '视频传输恢复中');
    });
    video.addEventListener('canplay', () => { this.syncPlayback(); void this.tryPlay(); });
    for (const event of ['timeupdate', 'progress']) video.addEventListener(event, () => { this.syncPlayback(); });
  }
  resetMetrics() {
    this.viewportFrames?.resetMetrics();
    this.firstFrameMs = null; this.presentedFrames = 0; this.lastFrame = null;
    this.maxVisibleFrameGapMs = 0; this.visibleGapsOver250Ms = 0; this.waitingAfterFirstFrame = 0;
    this.playbackEvents = []; this.rateEvents = []; this.lastReportedRate = 1; this.pipelineProbe.reset();
    // The public statistics API exposes speed, not cumulative bytes or media time.
    // Reason: integrating an instantaneous speed would invent transferred-byte evidence.
    this.httpStats = { bytesReceived: null, mainBytesReceived: null, mainLoadedMediaSeconds: null,
      mediaRequests: null, loadedMediaSeconds: null, lastFetchMs: null, lastDownloadMbps: null, fatalErrors: 0 };
  }
  setState(state, detail = '') { this.state = state; this.detail = detail; this.onState({ state, detail }); }
  reset(meta) { this.meta = meta; this.start(); }
  setBroadcastLive(live) {
    this.broadcastLive = live === true;
    if (!this.broadcastLive && (this.started !== null || this.engine || this.retryTimer !== null)) this.clear();
  }
  start() {
    if (!this.broadcastLive || this.started !== null) return;
    const generation = ++this.generation; this.started = this.now(); this.resetMetrics();
    this.diagnostics.reset(this.video); this.setState('buffering', '正在接入持续直播');
    let supported = false;
    try { supported = this.Mpegts.isSupported() && this.Mpegts.getFeatureList().mseLivePlayback; } catch { /* Unsupported browsers stay explicit. */ }
    if (!supported) { this.setState('error', '此浏览器不支持持续直播视频'); return; }
    this.openEngine(generation);
    const frame = now => {
      if (generation !== this.generation) return;
      if (this.video.paused) {
        this.lastFrame = null; this.viewportFrames.reset();
        this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
        return;
      }
      this.firstFrameMs ??= now - this.started; this.presentedFrames++;
      // Only exposed frames count toward visible continuity. Reason: offscreen
      // callback throttling must not become a stall or a zero-gap playback PASS.
      const gap = this.viewportFrames.frameGap(now, { hidden: this.hidden });
      if (gap !== null) {
        this.maxVisibleFrameGapMs = Math.max(this.maxVisibleFrameGapMs, gap);
        if (gap > 250) { this.visibleGapsOver250Ms++; this.recordPlayback('frame-gap'); }
      }
      this.syncPlayback();
      if (this.state !== 'playing' && !this.video.paused) this.setState('playing');
      this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
    };
    this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
  }
  openEngine(generation) {
    if (!this.broadcastLive || generation !== this.generation) return;
    this.startupPending = true;
    this.startupPositioned = false;
    this.liveSync.reset();
    let engine;
    try {
      engine = this.Mpegts.createPlayer({ type: 'flv', isLive: true,
        // Blob workers have no page-relative base URL. Reason: resolve the owned
        // media URL before the official loader moves into its worker.
        url: new URL(this.mediaPath, this.origin()).href,
        cors: false, withCredentials: true, hasVideo: true, hasAudio: true },
      { enableWorker: true, enableWorkerForMSE: true, enableStashBuffer: true, stashInitialSize: 512 * 1024,
        isLive: true, lazyLoad: false, deferLoadAfterSourceOpen: false, statisticsInfoReportInterval: 200,
        // One bounded playback-rate owner works on the current playable range.
        // Reason: the official hysteresis retains 1.2x after waiting and counts disconnected future ranges.
        liveBufferLatencyChasing: false, liveBufferLatencyChasingOnPaused: false,
        liveSync: false,
        autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 12 });
      this.engine = engine;
      this.ingestWatchdog.attach();
      this.pipelineProbe.attach(engine);
      const current = () => generation === this.generation && this.engine === engine;
      engine.on(this.Mpegts.Events.STATISTICS_INFO, info => {
        if (current()) { this.recordStatistics(info); if (this.startupPending) void this.tryPlay(); }
      });
      engine.on(this.Mpegts.Events.ERROR, (type, detail, info) => {
        if (!current()) return;
        this.httpStats.fatalErrors++;
        const known = Object.values(this.Mpegts.ErrorDetails ?? {}).includes(detail) ? detail : 'MediaUnavailable';
        const code = Number.isInteger(info?.code) && info.code >= 100 && info.code <= 599 ? ` (${info.code})` : '';
        this.onLog(`视频连接错误：${known}${code}`);
        if ([401, 403].includes(info?.code)) { this.setState('error', '请重新验证访问后连接'); return; }
        if ([this.Mpegts.ErrorTypes.NETWORK_ERROR, this.Mpegts.ErrorTypes.MEDIA_ERROR].includes(type)) this.scheduleReconnect(generation, engine);
        else this.setState('error', '请点击重新连接');
      });
      engine.on(this.Mpegts.Events.LOADING_COMPLETE, () => { if (current()) this.scheduleReconnect(generation, engine); });
      engine.attachMediaElement(this.video); engine.load(); void this.tryPlay();
    } catch {
      if (this.engine === engine) { this.engine?.destroy(); this.engine = null; }
      this.setState('error', '持续视频连接未能建立');
    }
  }
  scheduleReconnect(generation, engine) {
    if (!this.broadcastLive || this.retryTimer !== null || generation !== this.generation || this.engine !== engine) return;
    this.setState('buffering', '视频连接正在恢复'); this.onLog('持续视频连接正在恢复');
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.reconnectAttempts++, 5));
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (!this.broadcastLive || generation !== this.generation || this.engine !== engine) return;
      this.engine = null; this.playPending = false; engine.destroy(); this.openEngine(generation);
    }, delay);
  }
  reconnect() {
    // A control-WebSocket reset deliberately leaves start() idempotent.
    // Reason: an explicit media reconnect must replace the current engine without erasing its session history.
    if (this.started !== null && this.engine) this.scheduleReconnect(this.generation, this.engine);
  }
  recordStatistics(info) {
    this.pipelineProbe.recordStatistics(info);
    // SpeedSampler divides byte counts by 1024: speed is KiB/s despite its KB/s label.
    // Reason: unit conversion must not inflate the measured stream rate or fabricate totals.
    this.httpStats.lastDownloadMbps = Number.isFinite(info?.speed) && info.speed >= 0 ? info.speed * 1024 * 8 / 1e6 : null;
    this.syncPlayback();
    // Existing collectStats polls this even when the worker stops emitting events.
    // Reason: a fresh sampling heartbeat must not conceal frozen raw receive counters.
    if (this.started !== null && this.engine && this.retryTimer === null
      && this.ingestWatchdog.observe(info?.rawFetch, {
        suppressed: this.userPaused || ['blocked', 'error', 'paused'].includes(this.state),
      })) this.scheduleReconnect(this.generation, this.engine);
  }
  syncPlayback() {
    if (this.started !== null && this.engine) this.liveSync.update(this.bufferAhead());
  }
  recordPlayback(reason) {
    if (this.started === null) return;
    if (reason === 'waiting') this.pipelineProbe.mark(4);
    const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
    // Bound critical events to sixteen and rate events to eight, then publish at most sixteen.
    // Reason: frequent tiny rate changes must never evict the latest eight waiting/playing/frame-gap events.
    const ring = reason === 'rate-change' ? this.rateEvents : this.playbackEvents;
    const capacity = reason === 'rate-change' ? 8 : 16;
    ring.push({ elapsedMs: numeric(this.now() - this.started),
      currentTime: numeric(this.video.currentTime), bufferAheadSeconds: numeric(this.bufferAhead()),
      playbackRate: numeric(this.video.playbackRate), readyState: numeric(this.video.readyState), reason });
    if (ring.length > capacity) ring.shift();
  }
  async tryPlay(userInitiated = false) {
    if (userInitiated) this.userPaused = false;
    if (!this.broadcastLive || this.userPaused || this.started === null || !this.engine || !this.video.paused || this.playPending) return;
    this.positionStartup();
    // Gate only the first play of an engine, never pause an active live video.
    // Reason: one second of actual media absorbs initial delivery jitter without
    // bringing back the old recurring low-water pause/rebuffer loop.
    if (this.startupPending && this.bufferAhead() < 1) return;
    const generation = this.generation, engine = this.engine; this.playPending = true;
    try { this.diagnostics.playCall(); await engine.play(); }
    catch (error) {
      if (generation === this.generation && engine === this.engine) this.setState(error.name === 'NotAllowedError' ? 'blocked' : 'buffering', '点击继续播放');
    } finally { if (generation === this.generation && engine === this.engine) this.playPending = false; }
  }
  positionStartup() {
    if (!this.startupPending || this.startupPositioned || this.video.readyState < 1 || this.video.seeking) return;
    const ranges = this.video.buffered;
    if (!ranges?.length) return;
    const start = ranges.start(0), end = ranges.end(0);
    // Position only a genuinely ready first range, before the one-second play gate.
    // Reason: worker MSE may append after zero without HTML progress/stalled events,
    // leaving the official startup jumper idle and bufferAhead() permanently zero.
    if (Number.isFinite(start) && Number.isFinite(end) && this.video.currentTime < start && end - start >= 1) {
      this.startupPositioned = true; this.diagnostics.autoSeek(); this.engine.currentTime = start;
    }
  }
  bufferAhead() {
    const ranges = this.video.buffered;
    for (let i = 0; i < (ranges?.length ?? 0); i++) {
      if (ranges.start(i) <= this.video.currentTime + .05 && ranges.end(i) >= this.video.currentTime) {
        return Math.max(0, ranges.end(i) - this.video.currentTime);
      }
    }
    return 0;
  }
  setVisibility(hidden) {
    if (this.hidden && !hidden) this.ingestWatchdog.defer();
    this.hidden = hidden; this.lastFrame = null; this.viewportFrames.setHidden(hidden); if (!hidden) this.maintain();
  }
  maintain() { this.syncPlayback(); if (!this.userPaused && this.video.paused) void this.tryPlay(); }
  pauseByUser() { this.userPaused = true; this.diagnostics.pauseCall(); this.engine?.pause(); this.setState('paused'); }
  goLive() { this.userPaused = false; void this.tryPlay(true); }
  collectStats() { if (this.engine) this.recordStatistics(this.engine.statisticsInfo); }
  snapshot() {
    return { transport: 'flv', sourceProfile: this.sourceProfile, receivedBytes: null, queuedBytes: null, lag: null,
      bufferAheadSeconds: this.bufferAhead(), bufferSeconds: this.bufferAhead(),
      bufferingMode: this.state === 'buffering' ? 'flv' : null, hasData: this.presentedFrames > 0,
      state: this.state, diagnostics: this.diagnostics.snapshot(this.video),
      playbackEvents: [...this.playbackEvents, ...this.rateEvents]
        .sort((a, b) => a.elapsedMs - b.elapsedMs).slice(-16).map(event => ({ ...event })),
      mediaCurrentTime: Number.isFinite(this.video.currentTime) ? this.video.currentTime : null,
      playbackRate: Number.isFinite(this.video.playbackRate) ? this.video.playbackRate : null,
      clientUnixMs: Date.now(), playbackPolicy: { ...FLV_SYNC_POLICY }, pipelineBoundaries: this.pipelineProbe.snapshot(),
      observedSeconds: this.started === null ? null : (this.now() - this.started) / 1000,
      firstFrameMs: this.firstFrameMs, presentedFrames: this.presentedFrames, ...this.viewportFrames.snapshot(),
      maxVisibleFrameGapMs: this.maxVisibleFrameGapMs, visibleGapsOver250Ms: this.visibleGapsOver250Ms,
      waitingAfterFirstFrame: this.waitingAfterFirstFrame, httpStats: { ...this.httpStats } };
  }
  clear() {
    this.ingestWatchdog.clear();
    this.viewportFrames.disconnect();
    this.generation++; if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null; this.engine?.destroy(); this.engine = null; this.started = null; this.playPending = false;
    this.liveSync.reset();
    if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest);
    this.frameRequest = null; this.reconnectAttempts = 0; this.resetMetrics(); this.setState('idle');
  }
}
