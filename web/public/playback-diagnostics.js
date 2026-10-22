// Browser-local, constant-size numeric counters only. Reason: locate player-induced stalls without collecting chat, credentials or telemetry.
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function quality(video) {
  try {
    const value = video?.getVideoPlaybackQuality?.();
    return { totalVideoFrames: integer(value?.totalVideoFrames), droppedVideoFrames: integer(value?.droppedVideoFrames) };
  } catch { return { totalVideoFrames: null, droppedVideoFrames: null }; }
}

export class PlaybackDiagnostics {
  reset(video) {
    this.waitingEvents = 0; this.ignoredStaleWaiting = 0; this.programPauseCalls = 0;
    this.playCalls = 0; this.autoSeekCalls = 0; this.lastWaiting = null;
    this.baseline = quality(video); this.lastQuality = { ...this.baseline };
  }
  constructor() { this.reset(); }
  increment(name) { this[name] = Math.min(Number.MAX_SAFE_INTEGER, this[name] + 1); }
  waiting(video, ahead) {
    this.increment('waitingEvents');
    this.lastWaiting = { readyState: integer(video.readyState), bufferAheadSeconds: number(ahead),
      paused: typeof video.paused === 'boolean' ? video.paused : null, seeking: typeof video.seeking === 'boolean' ? video.seeking : null };
  }
  ignoredWaiting() { this.increment('ignoredStaleWaiting'); }
  pauseCall() { this.increment('programPauseCalls'); }
  playCall() { this.increment('playCalls'); }
  autoSeek() { this.increment('autoSeekCalls'); }
  snapshot(video = {}) {
    const native = quality(video), frames = {};
    for (const key of ['totalVideoFrames', 'droppedVideoFrames']) {
      const value = native[key], prior = this.lastQuality[key];
      // Native quality can reset after load asynchronously. Reason: epoch deltas must not become negative or inherit frames from the replaced source.
      if (value !== null && ((prior !== null && value < prior) || value < (this.baseline[key] ?? 0))) this.baseline[key] = 0;
      frames[key] = value === null ? null : Math.max(0, value - (this.baseline[key] ?? 0));
      this.lastQuality[key] = value;
    }
    return { readyState: integer(video.readyState), paused: typeof video.paused === 'boolean' ? video.paused : null,
      seeking: typeof video.seeking === 'boolean' ? video.seeking : null, currentTime: number(video.currentTime), ...frames,
      waitingEvents: this.waitingEvents, ignoredStaleWaiting: this.ignoredStaleWaiting,
      programPauseCalls: this.programPauseCalls, playCalls: this.playCalls, autoSeekCalls: this.autoSeekCalls,
      lastWaiting: this.lastWaiting ? { ...this.lastWaiting } : null };
  }
}

export function playbackDiagnosticText(value = {}) {
  const show = number => Number.isFinite(number) ? String(number) : '—';
  const flags = `${value.paused === null || value.paused === undefined ? '—' : value.paused ? '停' : '播'}/${value.seeking === null || value.seeking === undefined ? '—' : value.seeking ? '跳转' : '稳'}`;
  const waiting = value.lastWaiting;
  const last = waiting ? ` · 等待 ${show(waiting.readyState)}/${Number.isFinite(waiting.bufferAheadSeconds) ? waiting.bufferAheadSeconds.toFixed(2) + 's' : '—'}` : '';
  // Frame totals are cumulative epoch counters, not FPS. Reason: delivered/decoded/displayed rates must not be inferred from a metadata label.
  return `ready ${show(value.readyState)} · ${flags} · 画面帧 ${show(value.totalVideoFrames)} · 丢帧 ${show(value.droppedVideoFrames)} · 程序暂停 ${show(value.programPauseCalls)} · 过期等待 ${show(value.ignoredStaleWaiting)} · seek ${show(value.autoSeekCalls)}${last}`;
}
