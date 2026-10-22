import { PlaybackDiagnostics } from './playback-diagnostics.js';
import { receiverSnapshot } from './rtc-stats.js';

// A peer owns media independently of the chat socket. Reason: reconnecting chat,
// changing source epoch or hiding a tab must not discard a healthy live decoder.
export class RtcPlayer {
  constructor(video, onState, onLog, { Reader = globalThis.MediaMTXWebRTCReader,
    now = () => performance.now(), origin = globalThis.location?.origin,
    transport = new URLSearchParams(globalThis.location?.hash?.slice(1) ?? '').get('rtc_transport') } = {}) {
    this.video = video; this.onState = onState; this.onLog = onLog; this.Reader = Reader;
    this.now = now; this.origin = origin; this.transport = 'webrtc'; this.reader = null;
    // Same 1080p bitstream over reliable delivery. Reason: the actual UDP
    // browser comparison had severe loss/retransmits; TCP restored 30 fps decode.
    this.preferredTransport = transport === 'udp' ? 'auto' : 'tcp';
    this.state = 'idle'; this.source = null; this.generation = 0;
    this.hidden = false; this.userPaused = false; this.frameRequest = null;
    this.diagnostics = new PlaybackDiagnostics(); this.resetMetrics();
    video.addEventListener('playing', () => { if (this.reader) this.setState('playing'); });
    video.addEventListener('waiting', () => {
      if (!this.reader || this.userPaused) return;
      this.diagnostics.waiting(video, null);
      if (this.firstFrameMs !== null) this.waitingAfterFirstFrame++;
      this.setState('buffering', '实时传输恢复中');
      // No pause or seek here. Reason: native WebRTC already owns packet jitter recovery.
    });
  }
  resetMetrics() {
    this.started = null; this.firstFrameMs = null; this.presentedFrames = 0;
    this.maxVisibleFrameGapMs = 0; this.visibleGapsOver250Ms = 0;
    this.waitingAfterFirstFrame = 0; this.lastFrame = null;
    this.statsSource = null; this.rtcStats = null; this.statsPending = false;
  }
  setState(state, detail = '') { this.state = state; this.detail = detail; this.onState({ state, detail }); }
  reset(meta) { this.meta = meta; this.start(); }
  start() {
    if (this.reader) return;
    const generation = ++this.generation; this.resetMetrics(); this.started = this.now();
    this.diagnostics.reset(this.video); this.setState('buffering', '正在接入持续直播');
    this.reader = new this.Reader({ url: this.origin + '/api/webrtc/sbf-trial/whep',
      transport: this.preferredTransport,
      onTrack: event => {
        if (generation !== this.generation) return;
        this.statsSource = typeof event.target?.getStats === 'function' ? event.target : event.receiver;
        void this.collectStats();
        if (this.video.srcObject !== event.streams[0]) this.video.srcObject = event.streams[0];
        void this.tryPlay();
      },
      onError: () => { if (generation === this.generation) { this.onLog('实时媒体连接重试中'); this.setState('buffering', '正在恢复实时连接'); } },
    });
    const frame = now => {
      if (generation !== this.generation) return;
      this.firstFrameMs ??= now - this.started; this.presentedFrames++;
      if (!this.hidden && this.lastFrame !== null) {
        const gap = now - this.lastFrame;
        this.maxVisibleFrameGapMs = Math.max(this.maxVisibleFrameGapMs, gap);
        if (gap > 250) this.visibleGapsOver250Ms++;
      }
      this.lastFrame = this.hidden ? null : now;
      if ((this.presentedFrames === 1 || this.state !== 'playing') && !this.video.paused) this.setState('playing');
      this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
    };
    this.frameRequest = this.video.requestVideoFrameCallback?.(frame) ?? null;
  }
  async tryPlay(userInitiated = false) {
    if (userInitiated) this.userPaused = false;
    if (this.userPaused || !this.reader || !this.video.paused || !this.video.srcObject || this.playPending) return;
    const generation = this.generation; this.playPending = true;
    try { this.diagnostics.playCall(); await this.video.play(); }
    catch (error) {
      if (generation === this.generation) this.setState(error.name === 'NotAllowedError' ? 'blocked' : 'buffering', '点击继续播放');
    } finally { if (generation === this.generation) this.playPending = false; }
  }
  setVisibility(hidden) { this.hidden = hidden; this.lastFrame = null; if (!hidden) this.maintain(); }
  maintain() { if (!this.userPaused && this.video.paused) void this.tryPlay(); }
  pauseByUser() { this.userPaused = true; this.video.pause(); this.setState('paused'); }
  goLive() { this.userPaused = false; void this.tryPlay(true); }
  async collectStats() {
    if (!this.statsSource?.getStats || this.statsPending) return;
    const generation = this.generation; this.statsPending = true;
    try {
      const report = await this.statsSource.getStats();
      if (generation === this.generation) this.rtcStats = receiverSnapshot(report, this.rtcStats);
    } catch { /* A closing peer can reject stats; media recovery remains independent. */ }
    finally { if (generation === this.generation) this.statsPending = false; }
  }
  snapshot() {
    const diagnostics = this.diagnostics.snapshot(this.video);
    return { transport: 'webrtc', receivedBytes: this.rtcStats?.bytesReceived ?? null, queuedBytes: 0, lag: null,
      bufferSeconds: 0, bufferAheadSeconds: 0, bufferingMode: this.state === 'buffering' ? 'native' : null,
      hasData: this.presentedFrames > 0, state: this.state, diagnostics, playbackEvents: [],
      observedSeconds: this.started === null ? null : (this.now() - this.started) / 1000,
      firstFrameMs: this.firstFrameMs, presentedFrames: this.presentedFrames,
      maxVisibleFrameGapMs: this.maxVisibleFrameGapMs, visibleGapsOver250Ms: this.visibleGapsOver250Ms,
      waitingAfterFirstFrame: this.waitingAfterFirstFrame, rtcStats: this.rtcStats };
  }
  clear() {
    this.generation++; this.reader?.close(); this.reader = null; this.playPending = false;
    if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest);
    this.frameRequest = null; this.video.srcObject = null; this.resetMetrics(); this.setState('idle');
  }
}
