import { mp4FragmentKind, playbackTarget } from './format.js';
import { Fmp4ChunkAssembler } from './fmp4-chunks.js';
import { PlaybackDiagnostics } from './playback-diagnostics.js';
import { PlaybackTrace, formatPlaybackTrace } from './playback-trace.js';
import { PlaybackBuffer } from './playback-buffer.js';
import { PlaybackScheduler, PlaybackWork as Work } from './playback-scheduler.js';

// A recovered burst is useful jitter reserve, not proof of sustained lag.
// Reason: the real recovery trace lost1.499s in an immediate seek and underflowed again.
const CATCHUP = Object.freeze({ reserveSeconds: 2.3, burstSeconds: 16 / 30,
  observeMs: 3000, severeMs: 5000, recoveryMs: 5000, maxObservationGapMs: 2500, rate: 1.02 });

function playbackPolicy(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new RangeError('PLAYBACK_POLICY_INVALID');
  const streamed = meta?.source === 'local-playlist-stream';
  const declared = meta && Object.hasOwn(meta, 'playbackPolicy');
  // A stream marker and its policy are a pair. Reason: silently falling back to the legacy two-second gate would hide a deployment mismatch.
  if (!streamed && !declared) return { targetSeconds: 2, lowWaterSeconds: 0.5, maxLagSeconds: 4.5 };
  const value = meta?.playbackPolicy, keys = ['targetSeconds', 'lowWaterSeconds', 'maxLagSeconds'];
  // Keep a bounded candidate envelope, never zero reserve or unlimited lag.
  // Reason: remote metadata may select this stream mode, but must not disable recovery or create arbitrary viewing delay.
  if (!streamed || !declared || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    || value.targetSeconds < 1 || value.targetSeconds > 2 || value.lowWaterSeconds < 0.1
    || value.lowWaterSeconds > 0.5 || value.maxLagSeconds < 2 || value.maxLagSeconds > 4.5
    || value.targetSeconds - value.lowWaterSeconds <= 16 / 30
    || value.maxLagSeconds <= value.targetSeconds + 0.5) throw new RangeError('PLAYBACK_POLICY_INVALID');
  // Reserve spans a whole GOP16 period before the floor; catchup precedes hard seek.
  // Reason: target1/floor0.5 can pause before a perfectly on-time0.533s fragment, while these bounds still cannot guarantee network delivery.
  return { targetSeconds: value.targetSeconds, lowWaterSeconds: value.lowWaterSeconds, maxLagSeconds: value.maxLagSeconds };
}

export class LivePlayer {
  constructor(video, onState, onLog) {
    this.video = video;
    this.onState = onState;
    this.onLog = onLog;
    this.diagnostics = new PlaybackDiagnostics();
    this.playbackTrace = new PlaybackTrace();
    this.observationStartedAt = null;
    this.generation = 0;
    this.receivedBytes = 0;
    this.keepSeconds = 18;
    this.targetDelay = 2;
    this.lowWaterSeconds = 0.5;
    this.maxLagSeconds = 4.5;
    this.bufferingMode = 'startup';
    this.autoPaused = false;
    this.hasPlayed = false;
    this.playPending = null;
    this.visibilityHidden = false;
    this.visibilityResumeIntent = false;
    this.visibilitySuspended = false;
    this.visibilityRetryUsed = false;
    this.resetCatchup();
    this.scheduler = new PlaybackScheduler(work => this.runScheduled(work));
    this.mediaBuffer = new PlaybackBuffer({ onComplete: () => this.scheduler.dispatch(Work.POLICY | Work.MEDIA),
      onError: detail => this.fail(detail), onTrace: (reason, context) => this.trace(reason, context, false) });
    this.disposed = false;
    // The HTML autoplay flag bypasses the two-second gate. Reason: decoded data alone is not a usable live reserve.
    this.video.autoplay = false;
    // Decode buffered MSE data before play admission, without allowing HTML autoplay.
    // Reason: the page's preload=none hint would defeat overlapping decoder preparation with reserve accumulation.
    this.video.preload = 'auto';
    this.video.addEventListener('playing', () => this.scheduler.dispatch(Work.PLAYING));
    this.video.addEventListener('play', () => this.scheduler.dispatch(Work.NATIVE_PLAY));
    this.video.addEventListener('waiting', () => this.scheduler.dispatch(Work.WAITING));
    this.video.addEventListener('pause', () => this.scheduler.dispatch(Work.PAUSE));
    this.video.addEventListener('error', () => {
      if (this.source && this.video.error) this.fail(`浏览器解码失败（代码 ${this.video.error.code}）`);
    });
    // Observe decoder events without requiring frame callbacks for playback.
    // Reason: MSE/native progress drives scheduling even when requestVideoFrameCallback is unavailable or throttled.
    this.video.addEventListener('seeking', () => { if (this.source) this.trace('seeking'); });
    this.video.addEventListener('seeked', () => {
      if (this.source) this.trace('seeked');
      this.scheduler.dispatch(Work.POLICY);
    });
    this.video.addEventListener('loadeddata', () => this.scheduler.dispatch(Work.PLAY, true));
    this.video.addEventListener('canplay', () => this.scheduler.dispatch(Work.PLAY, true));
    this.video.addEventListener('timeupdate', () => this.scheduler.dispatch(Work.POLICY, true));
  }

  get queue() { return this.mediaBuffer.items; }
  get queuedBytes() { return this.mediaBuffer.queuedBytes; }

  runScheduled(work) {
    if (!this.source || this.state === 'error') return;
    if (work & Work.PAUSE) this.onPause();
    if (work & Work.NATIVE_PLAY) this.onNativePlay();
    if (work & Work.PLAYING) this.onPlaying();
    if (work & Work.WAITING) this.onWaiting();
    if (work & Work.LIVE) {
      this.applyGoLive(this.liveAutomaticRequested === true);
      this.liveAutomaticRequested = false;
    }
    if (work & Work.PLAY) this.applyTryPlay(this.userPlayRequested === true);
    this.userPlayRequested = false;
    if (work & Work.POLICY && !(work & Work.WAITING)) this.applyPlaybackPolicy();
    if (work & Work.MEDIA) {
      if (this.mediaBuffer.step(this.video.currentTime, this.keepSeconds) === 'quota') {
        this.applyGoLive(true);
        if (!this.mediaBuffer.trim(this.video.currentTime, 3)) this.fail('浏览器的视频缓冲空间不足，请重新连接。');
      }
    }
  }

  onPlaying() {
    if (!this.source || this.video.paused || this.state === 'error') return;
    const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    if (this.bufferingMode && (!target || target.ahead < this.targetDelay - 1e-6)) {
      this.holdBuffering(this.bufferingMode, 'pause-playing-gate');
      return;
    }
    this.trace('playing', {}, this.autoPaused || Boolean(this.bufferingMode));
    this.autoPaused = false;
    this.bufferingMode = null;
    this.hasPlayed = true;
    this.visibilityResumeIntent = true;
    this.visibilitySuspended = false;
    this.setState('playing');
  }

  onNativePlay() {
    // Native fullscreen controls can resume too. Reason: a deliberate play must release the prior manual pause.
    if (this.source && !this.video.paused && this.playBlocked) {
      this.playBlocked = false;
      this.bufferingMode = this.hasPlayed ? 'rebuffer' : 'startup';
      const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
      // Preserve the existing native-resume correction envelope.
      // Reason: a recent deliberate pause must not newly skip buffered speech merely because resume is explicit.
      if (target && ((!target.inside && target.target > this.video.currentTime) || target.lag > this.maxLagSeconds)) {
        this.applyGoLive();
      } else this.applyPlaybackPolicy();
    }
  }

  onWaiting() {
    if (this.source && !this.playBlocked && this.state !== 'error') {
      const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
      this.diagnostics.waiting(this.video, target?.ahead ?? null);
      this.trace('waiting');
      // Ignore a stale queued waiting task. Reason: recovered ready3/4 data must not be paused again solely by an earlier underflow event.
      if (this.video.readyState >= 3 && target?.ahead > this.lowWaterSeconds) {
        this.diagnostics.ignoredWaiting();
        this.trace('waiting-ignored');
        return;
      }
      // Seeking temporarily lowers decoder readiness. Reason: native waiting during a buffered seek must not pause and abort an admitted play.
      if (this.video.seeking === true && target?.ahead > this.lowWaterSeconds) {
        this.trace('waiting-seeking');
        return;
      }
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup', 'pause-waiting');
    }
  }

  onPause() {
    if (this.source && this.video.paused && this.state !== 'error') {
      if (this.captureVisibilityPause()) {
        this.scheduler.dispatch(Work.PLAY);
        return;
      }
      if (this.autoPaused) {
        this.setState('buffering', this.bufferingDetail());
        return;
      }
      this.recordManualPause();
    }
  }

  recordManualPause() {
    this.visibilityResumeIntent = this.visibilitySuspended = false;
    this.playBlocked = true;
    this.setState('paused');
  }

  pauseByUser() {
    // Explicit controls/MediaSession can disambiguate a hidden user pause.
    // Reason: an unlabelled native pause cannot reveal whether the browser or a lock-screen user requested it.
    this.visibilityResumeIntent = this.visibilitySuspended = false;
    this.playBlocked = true; this.autoPaused = false;
    if (this.source && this.state !== 'error') this.setState('paused');
    this.video.pause();
  }

  captureVisibilityPause() {
    const hidden = this.visibilityHidden || globalThis.document?.hidden === true;
    if (!hidden || !this.visibilityResumeIntent || this.playBlocked || !this.hasPlayed
      || !this.video.paused || (this.autoPaused && !this.visibilitySuspended)) return false;
    // Consult visibility in both pause paths, including an updateend preceding native pause.
    // Reason: the queued pause event must not be the only opportunity to distinguish background interruption from manual intent.
    this.visibilityHidden = true; this.visibilitySuspended = true;
    this.autoPaused = true; this.bufferingMode = 'rebuffer';
    this.setState('buffering', '浏览器暂停了后台播放，允许播放时自动继续。');
    return true;
  }

  setVisibility(hidden) {
    if (typeof hidden !== 'boolean') throw new TypeError('PLAYBACK_VISIBILITY');
    if (hidden === this.visibilityHidden) return;
    if (hidden) {
      // Respect a pause already observable before the hidden transition.
      // Reason: switching tabs must never turn an existing deliberate pause into an automatic resume.
      if (this.source && this.hasPlayed && this.video.paused && !this.autoPaused && !this.visibilitySuspended) this.recordManualPause();
      this.visibilityResumeIntent = this.hasPlayed && !this.playBlocked
        && (!this.video.paused || this.autoPaused || this.visibilitySuspended);
    } else if (this.video.paused) {
      this.captureVisibilityPause();
    }
    this.visibilityHidden = hidden; this.visibilityRetryUsed = false;
    this.resetCatchup(true);
    if (!hidden && this.visibilitySuspended && this.visibilityResumeIntent && !this.playBlocked) {
      this.autoPaused = true; this.bufferingMode = this.hasPlayed ? 'rebuffer' : 'startup';
      this.scheduler.dispatch(Work.PLAY | Work.POLICY);
    }
  }

  trace(reason, context = {}, visible = true) {
    // Diagnostics must never block media actions. Reason: logging or observation errors must not skip pause, seek or the next append.
    try {
      const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
      const row = this.playbackTrace.record(reason, this.video, { ahead: target?.ahead, lag: target?.lag, ...context });
      if (visible) this.onLog(formatPlaybackTrace(row));
    } catch { /* Numeric tracing is best-effort; playback retains its existing policy. */ }
  }

  setState(state, detail = '') {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.onState({ state, detail });
  }

  reset(meta) {
    this.clear();
    this.meta = meta;
    try {
      const policy = playbackPolicy(meta);
      this.targetDelay = policy.targetSeconds; this.lowWaterSeconds = policy.lowWaterSeconds;
      this.maxLagSeconds = policy.maxLagSeconds;
    } catch {
      this.fail('视频播放策略无效，请重新连接并核对视频源。');
      return;
    }
    this.chunkAssembler = meta.transport === 'fmp4-chunks' ? new Fmp4ChunkAssembler() : null;
    this.receivedBytes = 0;
    this.observationStartedAt = performance.now();
    this.epoch = meta.epoch;
    if (!window.MediaSource || !MediaSource.isTypeSupported(meta.mime || '')) {
      this.fail('此浏览器不支持当前视频格式。请使用较新的 Chrome 或 Edge。');
      return;
    }
    const generation = this.generation;
    const source = new MediaSource();
    this.source = source;
    this.objectUrl = URL.createObjectURL(source);
    this.video.src = this.objectUrl;
    this.setState('buffering');
    this.onLog(`切换视频批次 ${String(meta.epoch)}；等待初始化片段。`);
    source.addEventListener('sourceopen', () => {
      if (generation !== this.generation) return;
      try {
        this.buffer = source.addSourceBuffer(meta.mime);
        this.buffer.mode = 'segments';
        this.mediaBuffer.attach(this.buffer);
        this.pump();
      } catch (error) {
        this.fail(`无法初始化播放器：${error.message}`);
      }
    }, { once: true });
    source.addEventListener('sourceclose', () => {
      if (generation === this.generation && !this.disposed) {
        this.fail('播放器连接已关闭，请重新连接。');
      }
    });
  }

  append(data) {
    if (!this.source || this.state === 'error') return;
    if (!(data instanceof ArrayBuffer) || !data.byteLength) return;
    if (this.chunkAssembler) {
      try {
        for (const segment of this.chunkAssembler.push(data)) this.appendSegment(segment);
      } catch (error) {
        this.fail(`视频分块重组失败：${error.message}`);
      }
    } else this.appendSegment(data);
  }

  appendSegment(data) {
    if (this.state === 'error') return;
    const kind = mp4FragmentKind(data);
    if (!this.receivedInit) {
      if (kind !== 'init') {
        this.fail('未收到视频初始化片段。请重新连接以同步视频。');
        return;
      }
      this.receivedInit = true;
      this.onLog('已收到 fMP4 初始化片段。');
    } else if (kind === 'init') {
      this.fail('收到未重置的视频初始化片段。请重新连接。');
      return;
    }
    if (kind === 'unknown') {
      this.fail('收到无法识别的 fMP4 片段。');
      return;
    }
    this.receivedBytes += data.byteLength;
    if (this.mediaBuffer.push(data)) this.pump();
  }

  pump() {
    this.scheduler.dispatch(Work.MEDIA);
  }

  ranges() {
    const ranges = [];
    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i += 1) {
      ranges.push({ start: buffered.start(i), end: buffered.end(i) });
    }
    return ranges;
  }

  correctPlayback() {
    this.scheduler.dispatch(Work.POLICY);
  }

  applyPlaybackPolicy() {
    if (!this.source || this.state === 'error' || this.playBlocked) return;
    if (this.manualPauseObserved()) return;
    let target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    if (!target || target.edge <= 0.02) {
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup', 'pause-no-buffer');
      return;
    }
    // Prime the first received range while later GOPs are arriving; stay paused until admitted.
    // Reason: waiting for the full reserve at empty time zero serializes network buffering and decoder seek.
    if (!this.hasPlayed && !target.inside && !this.video.seeking) {
      const firstPosition = target.span >= this.targetDelay ? target.target : this.ranges().at(-1).start;
      this.trace('seek-join', { seekTarget: firstPosition });
      this.diagnostics.autoSeek();
      this.video.currentTime = firstPosition;
      this.resetCatchup(true);
      target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    }
    if (!target.inside && target.span < this.targetDelay - 1e-6) {
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup');
      return;
    }
    if (!target.inside && target.target > this.video.currentTime) {
      this.trace('seek-join', { seekTarget: target.target });
      this.diagnostics.autoSeek();
      this.video.currentTime = target.target;
      this.video.playbackRate = 1;
      this.resetCatchup(true);
      target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    }
    if (!this.bufferingMode && target.ahead <= this.lowWaterSeconds) {
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup', 'pause-low-water');
    }
    if (this.bufferingMode) {
      this.video.playbackRate = 1;
      if (target.ahead < this.targetDelay - 1e-6) {
        this.holdBuffering(this.bufferingMode);
        return;
      }
      this.applyTryPlay();
      return;
    }
    this.applyStableCatchup(target);
    if (this.video.paused) {
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup');
      this.applyTryPlay();
    }
  }

  resetCatchup(recovering = false) {
    this.catchupWindow = { highSince: null, severeSince: null, lastObservedAt: null,
      safeAfter: performance.now() + (recovering ? CATCHUP.recoveryMs : 0) };
  }

  applyStableCatchup(target) {
    const window = this.catchupWindow, now = performance.now();
    const reserve = Math.max(this.targetDelay, CATCHUP.reserveSeconds);
    this.video.playbackRate = 1;
    // Only the current contiguous range funds correction; the newest range can be beyond a gap.
    // Reason: a large global lag with little playable data must not accelerate or skip healthy buffered speech.
    const healthy = this.video.readyState >= 3 && !this.video.seeking && !this.video.paused
      && !this.bufferingMode && target.inside && target.ahead >= reserve
      && target.ahead >= target.lag - 1e-6 && this.queuedBytes === 0;
    const observationGap = window.lastObservedAt === null ? 0 : now - window.lastObservedAt;
    window.lastObservedAt = now;
    if (observationGap > CATCHUP.maxObservationGapMs) window.highSince = window.severeSince = null;
    if (!healthy || now < window.safeAfter) {
      window.highSince = window.severeSince = null;
      return;
    }
    const softLimit = Math.max(this.maxLagSeconds + CATCHUP.burstSeconds, reserve + 0.5);
    const severeLimit = Math.max(this.maxLagSeconds + 2, reserve + 2);
    window.highSince = target.lag > softLimit ? window.highSince ?? now : null;
    window.severeSince = target.lag > severeLimit ? window.severeSince ?? now : null;
    // One monotonic window belongs to this player, with no extra timer or callback queue.
    // Reason: duplicate append/playing notifications must neither restart its deadline nor multiply seeks.
    if (window.severeSince !== null && now - window.severeSince >= CATCHUP.severeMs) {
      const seekTarget = target.edge - reserve;
      this.trace('seek-lag', { seekTarget });
      this.diagnostics.autoSeek();
      this.video.currentTime = seekTarget;
      this.resetCatchup(true);
    } else if (window.highSince !== null && now - window.highSince >= CATCHUP.observeMs
      && target.ahead > reserve + 0.5) {
      // Speedup is small, delayed and above a protected reserve.
      // Reason: an isolated delivery burst must not spend the buffer needed for the next network gap.
      this.video.playbackRate = CATCHUP.rate;
    }
  }

  bufferingDetail() {
    return this.bufferingMode === 'startup' ? `正在积累约 ${this.targetDelay} 秒播放缓冲。`
      : `缓冲偏低，积累约 ${this.targetDelay} 秒后自动继续。`;
  }

  manualPauseObserved() {
    // pause events are queued browser tasks. Reason: updateend may run before that event and must not resume a manual pause.
    if (this.hasPlayed && this.video.paused && !this.autoPaused) {
      if (this.captureVisibilityPause()) return false;
      this.recordManualPause();
      return true;
    }
    return false;
  }

  holdBuffering(mode, reason = mode === 'startup' ? 'pause-startup' : 'pause-rebuffer') {
    this.resetCatchup(true);
    this.bufferingMode = mode;
    this.autoPaused = true;
    this.video.playbackRate = 1;
    // Count calls, not repeated buffer decisions. Reason: a paused video may receive many maintenance callbacks without another program pause.
    if (!this.video.paused) { this.trace(reason); this.diagnostics.pauseCall(); this.video.pause(); }
    this.setState('buffering', this.bufferingDetail());
  }

  tryPlay(userInitiated = false) {
    this.userPlayRequested ||= userInitiated;
    this.scheduler.dispatch(Work.PLAY);
  }

  async applyTryPlay(userInitiated = false) {
    if (!this.source || this.state === 'error') return;
    const generation = this.generation;
    if (userInitiated) this.playBlocked = false;
    if (this.playBlocked) return;
    if (!userInitiated && this.manualPauseObserved()) return;
    // Reserve admission applies to a new start. Reason: a later loadeddata task must not rebuffer an already admitted play.
    if (!this.video.paused || this.playPending) return;
    // Decode and reserve are independent startup gates; seeked/canplay revisit this decision.
    // Reason: play during the initial seek creates native waiting before any frame has been presented.
    if (!this.hasPlayed && (this.video.seeking || !(this.video.readyState >= 3))) return;
    const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    if (!target || target.ahead < this.targetDelay - 1e-6) {
      this.holdBuffering(this.hasPlayed ? 'rebuffer' : 'startup');
      return;
    }
    if (!userInitiated && this.visibilityHidden && this.visibilitySuspended) {
      // At most one retry per hidden interval; visible recovery gets a new opportunity.
      // Reason: an OS-enforced background pause must not create a play/pause hot loop.
      if (this.visibilityRetryUsed) return;
      this.visibilityRetryUsed = true;
    }
    const pending = { generation, hiddenResume: this.visibilityHidden && this.visibilitySuspended };
    const priorBufferingMode = this.bufferingMode;
    this.playPending = pending;
    try {
      // The reserve has admitted this start. Reason: queued playing/timeupdate may follow normal frame consumption below2s.
      this.bufferingMode = null;
      this.autoPaused = false;
      this.resetCatchup(true);
      this.trace('play-call');
      this.diagnostics.playCall();
      await this.video.play();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error.name === 'AbortError') { this.trace('play-abort'); return; }
      this.bufferingMode = priorBufferingMode;
      if (error.name === 'NotAllowedError') {
        if (pending.hiddenResume && this.visibilityResumeIntent && !userInitiated) {
          this.visibilitySuspended = true; this.autoPaused = true;
          this.bufferingMode = this.hasPlayed ? 'rebuffer' : 'startup';
          this.setState('buffering', '浏览器限制后台播放，返回页面后自动重试。');
        } else {
          this.playBlocked = true;
          this.setState('blocked', '浏览器需要点击后才允许播放。');
        }
      } else {
        this.fail(`无法播放：${error.message}`);
      }
    } finally {
      if (this.playPending === pending) {
        this.playPending = null;
        // A background permission promise can settle after the visible callback.
        // Reason: retry the new foreground context once, without allowing an old epoch or manual pause to revive playback.
        if (generation === this.generation && pending.hiddenResume && !this.visibilityHidden
          && this.visibilitySuspended && this.visibilityResumeIntent && !this.playBlocked) {
          this.scheduler.dispatch(Work.PLAY, true);
        }
      }
    }
  }

  goLive(automatic = false) {
    this.liveAutomaticRequested = automatic;
    this.scheduler.dispatch(Work.LIVE);
  }

  applyGoLive(automatic = false) {
    // Quota recovery must not override deliberate pause.
    // Reason: incoming data pressure is not a user request to resume or move their paused position.
    if (automatic && (this.playBlocked || this.manualPauseObserved())) return;
    const target = playbackTarget(this.ranges(), this.video.currentTime, this.targetDelay);
    if (!target) return;
    if (automatic) { this.trace('seek-quota', { seekTarget: target.target }); this.diagnostics.autoSeek(); }
    this.video.currentTime = target.target;
    this.video.playbackRate = 1;
    this.resetCatchup(true);
    this.applyTryPlay(!automatic);
  }

  maintain() {
    if (!this.source || this.state === 'error') return;
    this.scheduler.dispatch(Work.POLICY | Work.MEDIA);
  }

  snapshot() {
    const ranges = this.ranges();
    const target = playbackTarget(ranges, this.video.currentTime, this.targetDelay);
    return {
      receivedBytes: this.receivedBytes,
      observedSeconds: this.observationStartedAt === null ? null : Math.max(0, (performance.now() - this.observationStartedAt) / 1000),
      queuedBytes: this.queuedBytes,
      lag: target?.lag ?? null,
      bufferSeconds: ranges.reduce((sum, range) => sum + range.end - range.start, 0),
      // Past buffered video cannot prevent a future stall. Reason: recovery uses playable data ahead of the current position.
      bufferAheadSeconds: target?.ahead ?? 0,
      bufferingMode: this.bufferingMode,
      playbackPolicy: { targetSeconds: this.targetDelay, lowWaterSeconds: this.lowWaterSeconds, maxLagSeconds: this.maxLagSeconds },
      hasData: Boolean(ranges.length),
      state: this.state,
      diagnostics: this.diagnostics.snapshot(this.video),
      playbackEvents: this.playbackTrace.snapshot(),
      scheduling: this.scheduler.snapshot(),
    };
  }

  fail(detail) {
    if (this.state === 'error' && this.detail === detail) return;
    this.setState('error', detail);
    this.onLog(detail);
  }

  clear() {
    this.generation += 1;
    this.scheduler.reset();
    this.mediaBuffer.clear();
    this.disposed = true;
    if (this.buffer && this.source?.readyState === 'open') {
      try {
        this.buffer.abort();
        this.source.removeSourceBuffer(this.buffer);
      } catch { /* A closing MediaSource may already have removed its buffer. */ }
    }
    this.source = null;
    this.buffer = null;
    this.receivedInit = false;
    this.chunkAssembler = null;
    this.playBlocked = false;
    this.playPending = null;
    this.bufferingMode = 'startup';
    // clear queues a pause too. Reason: its event may arrive after reset attaches the next source, before sourceopen.
    this.autoPaused = true;
    this.hasPlayed = false;
    this.visibilityResumeIntent = this.visibilitySuspended = this.visibilityRetryUsed = false;
    this.resetCatchup();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.diagnostics.reset(this.video);
    this.playbackTrace.reset();
    this.observationStartedAt = null;
    this.userPlayRequested = false;
    this.liveAutomaticRequested = false;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.disposed = false;
    this.setState('idle');
  }
}
