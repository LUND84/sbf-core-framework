const COUNT = Number.MAX_SAFE_INTEGER, TIME_MS = 366 * 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function number(value, max = COUNT, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= max && (!integer || Number.isSafeInteger(value)) ? value : null;
}
function boolean(value) { return typeof value === 'boolean' ? value : null; }

// A separate, fail-soft request path. Reason: diagnostics must not invoke login/reconnect or wait on the media/control path.
export class PlaybackReporter {
  #fetcher;
  #now;
  #setTimer;
  #clearTimer;
  #tabId;
  #routeClass;
  #startedAt;
  #lastNow = 0;
  #connectionAt;
  #epochAt = null;
  #connectionIndex = 0;
  #epochIndex = 0;
  #firstData = null;
  #firstPlaying = null;
  #firstCompleteMedia = null;
  #firstMediaAppendEnd = null;
  #requestIndex = 0;
  #requests = [];
  #seq = 0;
  #lastSent = -Infinity;
  #pending = null;
  #disabledReasonCode = 0;
  #lastDisconnect = null;
  #health = { lastHTTPStatus: null, lastOutcomeCode: 0, attemptCount: 0, acceptedCount: 0,
    httpErrorCount: 0, deadlineCount: 0, networkErrorCount: 0, timerErrorCount: 0, cancelCount: 0,
    lastAttemptElapsedMs: null, lastResultElapsedMs: null };
  constructor({ fetcher = (...args) => fetch(...args), now = () => performance.now(),
    randomUUID = () => globalThis.crypto.randomUUID(), routeClass = 'main',
    // Browser host functions require their Window receiver. Reason: storing the raw function
    // and invoking this.#setTimer() passes the reporter instead, preventing every HTTP report.
    setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = handle => globalThis.clearTimeout(handle) } = {}) {
    this.#fetcher = fetcher; this.#now = now;
    this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    this.#routeClass = ['main', 'alternate'].includes(routeClass) ? routeClass : 'main';
    // No deterministic/device identifier fallback. Reason: unsupported random UUID generation should disable reports rather than track a viewer.
    try { const id = randomUUID(); this.#tabId = typeof id === 'string' && UUID.test(id) ? id : null; }
    catch { this.#tabId = null; }
    this.#disabledReasonCode = this.#tabId ? 0 : 1;
    this.#startedAt = this.#connectionAt = this.#time();
  }
  #time() {
    try { this.#lastNow = Math.max(this.#lastNow, number(this.#now(), TIME_MS) ?? this.#lastNow); }
    catch { /* An unavailable observation clock must not affect playback. */ }
    return this.#lastNow;
  }
  connectionSwitched() {
    this.#connectionIndex += 1; this.#connectionAt = this.#time();
    this.#epochAt = null; this.#firstData = this.#firstPlaying = null;
    this.#firstCompleteMedia = this.#firstMediaAppendEnd = null;
  }
  connectionClosed(code, clean, snapshot = {}) {
    // Retain one numeric pre-clear observation across reconnects.
    // Reason: clearPlayback resets the media counters before a copied trace can explain the disconnect.
    this.#lastDisconnect = { code: number(code, 4999, true), wasClean: boolean(clean),
      elapsedMs: this.#time() - this.#startedAt, connectionIndex: this.#connectionIndex,
      receivedBytes: number(snapshot.receivedBytes, COUNT, true),
      bufferAheadSeconds: number(snapshot.bufferAheadSeconds, 3600),
      currentTime: number(snapshot.diagnostics?.currentTime, 366 * 86400),
      readyState: number(snapshot.diagnostics?.readyState, 4, true) };
  }
  epochSwitched() {
    this.#epochIndex += 1; this.#epochAt = this.#time();
    this.#firstData = this.#firstPlaying = null;
    this.#firstCompleteMedia = this.#firstMediaAppendEnd = null;
  }
  dataReceived() { if (this.#epochAt !== null) this.#firstData ??= this.#time() - this.#epochAt; }
  completeMediaReceived() { if (this.#epochAt !== null) this.#firstCompleteMedia ??= this.#time() - this.#epochAt; }
  mediaAppendCompleted() { if (this.#epochAt !== null) this.#firstMediaAppendEnd ??= this.#time() - this.#epochAt; }
  playing() { if (this.#epochAt !== null) this.#firstPlaying ??= this.#time() - this.#epochAt; }
  requestSubmitted() {
    if (this.#requestIndex >= COUNT) return null;
    const index = ++this.#requestIndex;
    this.#requests.push({ index, connectionIndex: this.#connectionIndex, epochIndex: this.#epochIndex,
      submittedElapsedMs: this.#time() - this.#startedAt, acceptedElapsedMs: null, failedElapsedMs: null });
    // Keep four numeric admissions, never the text or remote ID. Reason: the next diagnostic copy must remain bounded and shareable.
    if (this.#requests.length > 4) this.#requests.shift();
    return index;
  }
  requestSettled(index, accepted) {
    const entry = this.#requests.find(value => value.index === index);
    if (!entry || typeof accepted !== 'boolean' || entry.acceptedElapsedMs !== null || entry.failedElapsedMs !== null) return false;
    entry[accepted ? 'acceptedElapsedMs' : 'failedElapsedMs'] = this.#time() - this.#startedAt;
    return true;
  }
  #increment(name) { this.#health[name] = Math.min(COUNT, this.#health[name] + 1); }
  #finish(request, code, status = null) {
    if (request.settled) return;
    request.settled = true;
    if (this.#pending === request) this.#pending = null;
    this.#health.lastOutcomeCode = code;
    this.#health.lastResultElapsedMs = this.#time() - this.#startedAt;
    if (status !== null) this.#health.lastHTTPStatus = status;
    const count = { 2: 'acceptedCount', 3: 'httpErrorCount', 4: 'deadlineCount',
      5: 'networkErrorCount', 6: 'timerErrorCount', 7: 'cancelCount' }[code];
    if (count) this.#increment(count);
    // Release ownership before best-effort cleanup. Reason: a timer adapter failure must not latch pending forever.
    try { if (request.timer !== null) this.#clearTimer(request.timer); }
    catch { this.#increment('timerErrorCount'); }
  }
  snapshot() {
    // Fixed numeric outcomes: 0 idle,1 pending,2 accepted,3 HTTP error,4 deadline,5 network error,6 timer error,7 canceled.
    // Disabled reason: 0 none,1 UUID unavailable,2 inactive. Reason: retain useful failures without error text, URLs or credentials.
    const now = this.#time();
    return { ...this.#health, pending: Boolean(this.#pending), disabledReasonCode: this.#disabledReasonCode,
      deadlineMs: 1500, minIntervalMs: 2000,
      // These are raw local stages, not audible speech or rendered-mouth latency. Reason: playing/append alone cannot establish either semantic event.
      timing: { connectionIndex: this.#connectionIndex, connectionElapsedMs: now - this.#connectionAt,
        epochIndex: this.#epochIndex, epochElapsedMs: this.#epochAt === null ? null : now - this.#epochAt,
        firstDataMs: this.#firstData, firstCompleteMediaMs: this.#firstCompleteMedia,
        firstMediaAppendEndMs: this.#firstMediaAppendEnd, firstPlayingMs: this.#firstPlaying },
      requests: this.#requests.map(entry => ({ ...entry })),
      lastDisconnect: this.#lastDisconnect ? { ...this.#lastDisconnect } : null };
  }
  cancel() {
    if (!this.#pending) return;
    const request = this.#pending;
    this.#finish(request, 7);
    try { request.controller.abort(); } catch { /* Observation cleanup must not affect playback. */ }
  }
  sample(snapshot, { enabled, connection, visibility } = {}) {
    try {
      const now = this.#time();
      this.#disabledReasonCode = !this.#tabId ? 1 : !enabled ? 2 : 0;
      if (this.#disabledReasonCode || this.#pending || now - this.#lastSent < 2000) return;
      if (snapshot.receivedBytes > 0) this.dataReceived();
      if (snapshot.state === 'playing') this.playing();
      const diagnostic = snapshot.diagnostics ?? {};
      const report = {
        tabId: this.#tabId, seq: ++this.#seq, perfNowMs: now, elapsedMs: now - this.#startedAt,
        connectionIndex: this.#connectionIndex, connectionElapsedMs: now - this.#connectionAt,
        epochIndex: this.#epochIndex, epochElapsedMs: this.#epochAt === null ? null : now - this.#epochAt,
        firstDataMs: this.#firstData, firstPlayingMs: this.#firstPlaying, routeClass: this.#routeClass,
        connection: ['connecting', 'open', 'closed'].includes(connection) ? connection : 'closed',
        visibility: ['visible', 'hidden', 'prerender'].includes(visibility) ? visibility : 'hidden',
        state: ['idle', 'buffering', 'playing', 'paused', 'blocked', 'error'].includes(snapshot.state) ? snapshot.state : 'idle',
        receivedBytes: number(snapshot.receivedBytes, COUNT, true) ?? 0,
        queuedBytes: number(snapshot.queuedBytes, COUNT, true) ?? 0,
        bufferAheadSeconds: number(snapshot.bufferAheadSeconds, 3600) ?? 0,
        bufferSeconds: number(snapshot.bufferSeconds, 3600) ?? 0,
        lag: number(snapshot.lag, 3600), hasData: snapshot.hasData === true,
        paused: boolean(diagnostic.paused), seeking: boolean(diagnostic.seeking),
        readyState: number(diagnostic.readyState, 4, true), currentTime: number(diagnostic.currentTime, 366 * 86400),
      };
      for (const key of ['totalVideoFrames', 'droppedVideoFrames']) report[key] = number(diagnostic[key], COUNT, true);
      for (const key of ['waitingEvents', 'ignoredStaleWaiting', 'programPauseCalls', 'playCalls', 'autoSeekCalls'])
        report[key] = number(diagnostic[key], COUNT, true) ?? 0;
      const controller = new AbortController(), request = { controller, timer: null, settled: false };
      this.#pending = request; this.#lastSent = now;
      this.#increment('attemptCount'); this.#health.lastOutcomeCode = 1;
      this.#health.lastAttemptElapsedMs = now - this.#startedAt;
      // One small request, no retry queue, 1.5s deadline. Reason: an impaired viewing path must not accumulate diagnostic traffic.
      try { request.timer = this.#setTimer(() => {
        this.#finish(request, 4);
        try { controller.abort(); } catch { /* The settled request already released its slot. */ }
      }, 1500); }
      catch { this.#finish(request, 6); return; }
      try {
        Promise.resolve(this.#fetcher('/api/playback-report', { method: 'POST', credentials: 'same-origin',
          cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report),
          signal: controller.signal })).then(response => {
          const status = number(response?.status, 599, true);
          if (status === null || status < 100) this.#finish(request, 5);
          else this.#finish(request, status === 202 ? 2 : 3, status);
        }).catch(() => this.#finish(request, 5));
      } catch { this.#finish(request, 5); }
    } catch { /* Reports cannot escape into the application's playback timer. */ }
  }
}
