import Hls from 'hls.js';
import { PlaybackDiagnostics } from './playback-diagnostics.js';

// Standard HTTP media owns playback independently from chat/control reconnects.
// Reason: HLS's tested buffer/retry logic replaces the custom pause/seek loop.
export class HlsPlayer {
  constructor(video, onState, onLog, { HlsClass = Hls, now = () => performance.now() } = {}) {
    Object.assign(this, { video, onState, onLog, HlsClass, now, transport: 'hls',
      state: 'idle', source: null, generation: 0, hls: null, started: null,
      hidden: false, userPaused: false, frameRequest: null });
    this.diagnostics = new PlaybackDiagnostics(); this.resetMetrics();
    video.addEventListener('playing', () => { if (this.started !== null) this.setState('playing'); });
    video.addEventListener('waiting', () => {
      if (this.started === null || this.userPaused) return;
      this.diagnostics.waiting(video, this.bufferAhead());
      if (this.firstFrameMs !== null) this.waitingAfterFirstFrame++;
      this.setState('buffering', '视频传输恢复中');
    });
  }
  resetMetrics() {
    this.firstFrameMs = null; this.presentedFrames = 0; this.lastFrame = null;
    this.maxVisibleFrameGapMs = 0; this.visibleGapsOver250Ms = 0; this.waitingAfterFirstFrame = 0;
    this.httpStats = { bytesReceived: 0, mediaRequests: 0, loadedMediaSeconds: 0,
      initRequests: 0, partRequests: 0, segmentRequests: 0,
      lastFetchMs: null, lastDownloadMbps: null, fatalErrors: 0 };
    for (const track of ['main', 'audio']) {
      for (const field of ['Requests', 'PartRequests', 'SegmentRequests', 'InitRequests',
        'BytesReceived', 'LoadedMediaSeconds', 'LoadMs', 'TtfbMs']) this.httpStats[track + field] = 0;
      this.httpStats[track + 'LastFetchMs'] = null;
    }
  }
  recordLoad(data) {
    // A fragment accumulates its parts' stats. Reason: using it for each part
    // would count the same bytes repeatedly and hide the true request cost.
    const stats = data.part?.stats ?? data.frag?.stats;
    const bytes = Number.isFinite(stats?.loaded) && stats.loaded >= 0 ? stats.loaded
      : Number.isFinite(data.payload?.byteLength) ? data.payload.byteLength : 0;
    const loading = stats?.loading;
    const elapsed = Number.isFinite(loading?.start) && Number.isFinite(loading?.end)
      && loading.end > loading.start ? loading.end - loading.start : null;
    const ttfb = elapsed !== null && Number.isFinite(loading.first)
      && loading.first >= loading.start && loading.first <= loading.end ? loading.first - loading.start : 0;
    const init = data.frag?.sn === 'initSegment';
    const kind = init ? 'InitRequests' : data.part ? 'PartRequests' : 'SegmentRequests';
    const rawDuration = init ? 0 : data.part?.duration ?? data.frag?.duration;
    const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 0;
    this.httpStats.bytesReceived += bytes;
    this.httpStats[kind[0].toLowerCase() + kind.slice(1)]++;
    if (!init) { this.httpStats.mediaRequests++; this.httpStats.loadedMediaSeconds += duration; }
    this.httpStats.lastFetchMs = elapsed;
    this.httpStats.lastDownloadMbps = elapsed === null ? null : bytes * .008 / elapsed;
    const track = data.frag?.type;
    if (track === 'main' || track === 'audio') {
      this.httpStats[track + 'Requests']++;
      this.httpStats[track + kind]++;
      this.httpStats[track + 'BytesReceived'] += bytes;
      this.httpStats[track + 'LoadedMediaSeconds'] += duration;
      this.httpStats[track + 'LoadMs'] += elapsed ?? 0;
      this.httpStats[track + 'TtfbMs'] += ttfb;
      this.httpStats[track + 'LastFetchMs'] = elapsed;
    }
  }
  setState(state, detail = '') { this.state = state; this.detail = detail; this.onState({ state, detail }); }
  reset(meta) { this.meta = meta; this.start(); }
  start() {
    if (this.started !== null) return;
    const generation = ++this.generation; this.started = this.now(); this.resetMetrics();
    this.diagnostics.reset(this.video); this.setState('buffering', '正在接入持续直播');
    const url = '/api/hls/sbf-hls/index.m3u8';
    if (this.HlsClass.isSupported()) {
      this.hls = new this.HlsClass({ lowLatencyMode: true, enableWorker: true,
        liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 9,
        maxLiveSyncPlaybackRate: 1.03, backBufferLength: 20, maxBufferLength: 8 });
      const events = this.HlsClass.Events;
      this.hls.on(events.MEDIA_ATTACHED, () => { if (generation === this.generation) this.hls.loadSource(url); });
      this.hls.on(events.MANIFEST_PARSED, () => { if (generation === this.generation) void this.tryPlay(); });
      this.hls.on(events.FRAG_LOADED, (_event, data) => {
        if (generation !== this.generation) return;
        this.recordLoad(data);
      });
      this.hls.on(events.ERROR, (_event, data) => {
        if (generation !== this.generation || !data.fatal) return;
        this.httpStats.fatalErrors++;
        this.onLog('视频连接正在恢复'); this.setState('buffering', '视频连接正在恢复');
        if (data.type === this.HlsClass.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
        else if (data.type === this.HlsClass.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
        else this.setState('error', '请点击重新连接');
      });
      this.hls.attachMedia(this.video);
    } else if (this.video.canPlayType?.('application/vnd.apple.mpegurl')) {
      this.video.src = url; void this.tryPlay();
    } else { this.setState('error', '此浏览器不支持直播视频'); return; }
    const frame = now => {
      if (generation !== this.generation) return;
      this.firstFrameMs ??= now - this.started; this.presentedFrames++;
      if (!this.hidden && this.lastFrame !== null) {
        const gap = now - this.lastFrame;
        this.maxVisibleFrameGapMs = Math.max(this.maxVisibleFrameGapMs, gap);
        if (gap > 250) this.visibleGapsOver250Ms++;
      }
      this.lastFrame = this.hidden ? null : now;
      if (this.state !== 'playing' && !this.video.paused) this.setState('playing');
      this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
    };
    this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
  }
  async tryPlay(userInitiated = false) {
    if (userInitiated) this.userPaused = false;
    if (this.userPaused || this.started === null || !this.video.paused || this.playPending) return;
    const generation = this.generation; this.playPending = true;
    try { this.diagnostics.playCall(); await this.video.play(); }
    catch (error) {
      if (generation === this.generation) this.setState(error.name === 'NotAllowedError' ? 'blocked' : 'buffering', '点击继续播放');
    } finally { if (generation === this.generation) this.playPending = false; }
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
  setVisibility(hidden) { this.hidden = hidden; this.lastFrame = null; if (!hidden) this.maintain(); }
  maintain() { if (!this.userPaused && this.video.paused) void this.tryPlay(); }
  pauseByUser() { this.userPaused = true; this.video.pause(); this.setState('paused'); }
  goLive() { this.userPaused = false; void this.tryPlay(true); }
  collectStats() { /* HTTP counters are updated by the standard loader events. */ }
  snapshot() {
    const diagnostics = this.diagnostics.snapshot(this.video);
    return { transport: 'hls', receivedBytes: this.httpStats.bytesReceived, queuedBytes: 0,
      lag: Number.isFinite(this.hls?.latency) ? this.hls.latency : null,
      bufferAheadSeconds: this.bufferAhead(), bufferSeconds: this.bufferAhead(),
      bufferingMode: this.state === 'buffering' ? 'hls' : null, hasData: this.presentedFrames > 0,
      state: this.state, diagnostics, playbackEvents: [],
      observedSeconds: this.started === null ? null : (this.now() - this.started) / 1000,
      firstFrameMs: this.firstFrameMs, presentedFrames: this.presentedFrames,
      maxVisibleFrameGapMs: this.maxVisibleFrameGapMs, visibleGapsOver250Ms: this.visibleGapsOver250Ms,
      waitingAfterFirstFrame: this.waitingAfterFirstFrame, httpStats: { ...this.httpStats } };
  }
  clear() {
    this.generation++; this.hls?.destroy(); this.hls = null; this.started = null; this.playPending = false;
    if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest);
    this.frameRequest = null; this.video.removeAttribute?.('src'); this.video.load?.();
    this.resetMetrics(); this.setState('idle');
  }
}
