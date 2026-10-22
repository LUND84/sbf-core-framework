// Viewport exposure gates only visible-frame-gap measurements, never playback.
// Reason: browsers may throttle offscreen rVFC while audio and media time continue.
export class ViewportFrameVisibility {
  constructor(element, { view = element?.ownerDocument?.defaultView ?? globalThis.window,
    now = () => performance.now(),
    observerFactory = callback => typeof globalThis.IntersectionObserver === 'function'
      ? new globalThis.IntersectionObserver(callback, { threshold: 0 }) : null,
    readViewport = () => {
      const visual = view?.visualViewport, left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
      return { left, top, right: left + (visual?.width ?? view?.innerWidth),
        bottom: top + (visual?.height ?? view?.innerHeight) };
    } } = {}) {
    Object.assign(this, { element, view, now, observerFactory, readViewport, connected: false,
      generation: 0, observer: null, observerVisible: null, exposed: null, observing: false, hidden: false,
      lastFrame: null, visibleMs: 0, visibleSince: null, visiblePresentedFrames: 0, lastObservationMs: null });
    this.onGeometry = () => { if (this.connected) this.refresh(); }; this.connect();
  }
  connect() {
    if (this.connected) return;
    this.connected = true; const generation = ++this.generation;
    try {
      this.observer = this.observerFactory(entries => {
        if (!this.connected || generation !== this.generation) return;
        for (const entry of entries) if (entry.target === this.element && typeof entry.isIntersecting === 'boolean') {
          this.observerVisible = entry.isIntersecting && entry.intersectionRatio > 0; this.refresh();
        }
      });
      this.observer?.observe(this.element);
    } catch { this.observer = null; this.observerVisible = null; }
    // Scroll/resize also cover browsers without IntersectionObserver and no offscreen frame callback.
    // Reason: leaving and returning between two rVFC callbacks must still clear the old frame anchor.
    this.view?.addEventListener?.('scroll', this.onGeometry, { passive: true, capture: true });
    this.view?.addEventListener?.('resize', this.onGeometry, { passive: true });
    for (const event of ['pause', 'playing', 'emptied']) this.element?.addEventListener?.(event, this.onGeometry);
  }
  geometryVisible() {
    try {
      const rect = this.element.getBoundingClientRect(), viewport = this.readViewport();
      const values = [rect.left, rect.top, rect.right, rect.bottom,
        viewport.left, viewport.top, viewport.right, viewport.bottom];
      return values.every(Number.isFinite) && rect.right > rect.left && rect.bottom > rect.top
        && viewport.right > viewport.left && viewport.bottom > viewport.top
        && rect.right > viewport.left && rect.left < viewport.right
        && rect.bottom > viewport.top && rect.top < viewport.bottom;
    } catch { return false; }
  }
  refresh(at = this.now()) {
    if (Number.isFinite(at)) { at = Math.max(at, this.lastObservationMs ?? at); this.lastObservationMs = at; }
    const exposed = this.connected && !this.hidden && this.observerVisible !== false && this.geometryVisible();
    const observing = exposed && this.element.paused !== true;
    if (this.visibleSince !== null && Number.isFinite(at))
      this.visibleMs = Math.min(Number.MAX_SAFE_INTEGER, this.visibleMs + Math.max(0, at - this.visibleSince));
    this.visibleSince = observing && Number.isFinite(at) ? at : null;
    if (!observing || observing !== this.observing) this.lastFrame = null;
    this.exposed = exposed; this.observing = observing; return observing;
  }
  frameGap(now, { hidden = false } = {}) {
    this.connect(); this.hidden = Boolean(hidden);
    if (!Number.isFinite(now) || !this.refresh(now)) { this.reset(); return null; }
    const gap = this.lastFrame === null ? null : Math.max(0, now - this.lastFrame);
    this.visiblePresentedFrames = Math.min(Number.MAX_SAFE_INTEGER, this.visiblePresentedFrames + 1);
    this.lastFrame = now; return gap;
  }
  reset() { this.lastFrame = null; }
  resetMetrics() {
    this.visibleMs = 0; this.visiblePresentedFrames = 0; this.visibleSince = null; this.reset();
  }
  setHidden(hidden) { this.hidden = Boolean(hidden); this.refresh(); }
  snapshot() {
    const at = this.now(); this.refresh(at);
    // Count actual exposed observation separately from callbacks, and expose an unfinished gap.
    // Reason: an entirely offscreen window or a final frozen frame must not earn a visible-playback PASS.
    return { viewportVisible: this.exposed === true, visibleObservationSeconds: this.visibleMs / 1000,
      visiblePresentedFrames: this.visiblePresentedFrames,
      visibleFrameAgeMs: this.observing && this.lastFrame !== null ? Math.max(0, at - this.lastFrame) : null };
  }
  disconnect() {
    this.connected = false; this.generation++; this.observer?.disconnect(); this.observer = null;
    this.view?.removeEventListener?.('scroll', this.onGeometry, true);
    this.view?.removeEventListener?.('resize', this.onGeometry);
    for (const event of ['pause', 'playing', 'emptied']) this.element?.removeEventListener?.(event, this.onGeometry);
    this.refresh(); this.observing = false; this.visibleSince = null;
    this.observerVisible = null; this.exposed = null; this.reset();
  }
}
