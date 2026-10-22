import { ALERT_DURATIONS, ALERT_STYLES, paintAlertArt } from './module-c-alert-art.js';
export { ALERT_DURATIONS, ALERT_STYLES } from './module-c-alert-art.js';

export function normalizeAlert(value) {
  if (!value || !/^[a-f0-9]{16}$/.test(value.id) || value.version !== 1
    || !Number.isInteger(value.tierIndex) || value.tierIndex < 1 || value.tierIndex > 7
    || !Number.isSafeInteger(value.startsAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt - value.startsAt !== ALERT_DURATIONS[value.tierIndex - 1]
    || typeof value.amount !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value.amount)
    || Number(value.amount) <= 0 || Number(value.amount) > 100000
    || typeof value.ca !== 'string' || !value.ca || value.ca.length > 100) return null;
  return { ...value, name: typeof value.name === 'string' ? value.name.slice(0, 40) : '',
    symbol: typeof value.symbol === 'string' ? value.symbol.slice(0, 24) : '' };
}
export function activeAlert(alerts, now) {
  return alerts.filter(event => event.startsAt <= now && event.expiresAt > now)
    .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))[0] || null;
}
export function alertProgress(event, now) {
  return Math.max(0, Math.min(1, (now - event.startsAt) / (event.expiresAt - event.startsAt)));
}
export function safeAlertLogo(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
  try { const url = new URL(value, origin); return url.origin === origin ? url.href : ''; } catch { return ''; }
}
function element(document, tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function stylesheet(document) {
  if (!document.getElementById('mc-alert-stylesheet')) {
    const link = document.createElement('link'); link.id = 'mc-alert-stylesheet'; link.rel = 'stylesheet';
    link.href = new URL('./module-c-alerts.css', import.meta.url).href; document.head.append(link);
  }
}
export function ensureAlertSurface(boardElement) {
  const document = boardElement.ownerDocument;
  let surface = document.getElementById('mc-alerts');
  if (!surface) {
    surface = element(document, 'aside', 'mc-alerts'); surface.id = 'mc-alerts'; surface.hidden = true;
    surface.setAttribute('aria-label', '确认到账庆典'); surface.setAttribute('aria-live', 'polite');
    boardElement.parentElement.append(surface);
  }
  return surface;
}

export class PaidAlerts {
  constructor(surface, { document = surface.ownerDocument, origin = globalThis.location?.origin || '', now = Date.now,
    monotonic = () => globalThis.performance?.now?.() ?? now(),
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis), cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false } = {}) {
    this.surface = surface; this.document = document; this.origin = origin; this.now = now;
    this.requestFrame = requestFrame; this.cancelFrame = cancelFrame; this.reducedMotion = reducedMotion;
    this.monotonic = monotonic; this.anchorTime = null; this.anchorMono = 0; this.lastTime = -Infinity;
    this.lastServerTime = -Infinity; this.windows = new Map(); this.finished = new Set();
    this.events = []; this.activeId = ''; this.frame = null; this.stopped = false;
    this.renderCount = 0; stylesheet(document);
  }
  update({ alerts = [], serverTime } = {}) {
    if (this.stopped) return;
    if (!Number.isSafeInteger(serverTime) || serverTime < this.lastServerTime) return;
    const current = this.anchorTime === null ? serverTime : this.clock();
    this.lastServerTime = serverTime; this.anchorTime = Math.max(current, serverTime);
    this.anchorMono = this.monotonic(); this.lastTime = this.anchorTime;
    this.events = Array.isArray(alerts) ? alerts.slice(0, 8).map(normalizeAlert).filter(Boolean).flatMap(event => {
      if (this.finished.has(event.id)) return [];
      let window = this.windows.get(event.id);
      if (!window) {
        if (this.windows.size >= 10000) return [];
        window = { startsAt: event.startsAt, expiresAt: event.expiresAt, tierIndex: event.tierIndex };
        this.windows.set(event.id, window);
      }
      return [{ ...event, ...window }];
    }) : [];
    this.tick();
  }
  clock() {
    const candidate = this.anchorTime === null ? this.now()
      : this.anchorTime + Math.max(0, this.monotonic() - this.anchorMono);
    this.lastTime = Math.max(this.lastTime, candidate); return this.lastTime;
  }
  mount(event) {
    this.renderCount++; this.activeId = event.id;
    this.card = element(this.document, 'div', 'mc-alert-card');
    this.canvas = element(this.document, 'canvas', 'mc-alert-canvas'); this.canvas.setAttribute('aria-hidden', 'true');
    const content = element(this.document, 'div', 'mc-alert-content');
    this.tier = element(this.document, 'span', 'mc-alert-tier');
    const heading = element(this.document, 'div', 'mc-alert-heading');
    this.logo = element(this.document, 'span', 'mc-alert-logo', '◈');
    this.name = element(this.document, 'strong', 'mc-alert-name');
    this.amount = element(this.document, 'strong', 'mc-alert-amount');
    heading.append(this.logo, this.name); content.append(this.tier, heading, this.amount);
    const project = element(this.document, 'div', 'mc-alert-project');
    this.chain = element(this.document, 'span', 'mc-alert-chain'); this.ca = element(this.document, 'code', 'mc-alert-ca');
    project.append(this.chain, this.ca);
    this.progress = element(this.document, 'div', 'mc-alert-progress');
    this.card.append(this.canvas, content, project, this.progress); this.surface.replaceChildren(this.card);
    this.imageUrl = ''; this.metadataSignature = '';
  }
  metadata(event) {
    const signature = JSON.stringify([event.tierIndex, event.name, event.amount, event.symbol, event.tokenChain, event.chain, event.ca, event.logoUrl]);
    if (signature === this.metadataSignature) return;
    this.metadataSignature = signature;
    const style = ALERT_STYLES[event.tierIndex - 1];
    this.surface.dataset.tier = String(event.tierIndex); this.surface.dataset.eventId = event.id;
    this.card.style.setProperty('--mc-alert-color', style.color); this.card.style.setProperty('--mc-alert-second', style.second);
    this.tier.textContent = `TIER 0${event.tierIndex} · ${style.name}`;
    this.name.textContent = event.name || '匿名观众'; this.name.title = event.name || '匿名观众';
    this.amount.textContent = `${event.amount} U`;
    this.chain.textContent = `${event.symbol ? event.symbol + ' · ' : ''}${event.tokenChain || event.chain || ''} · CA`;
    this.ca.textContent = event.ca; this.ca.title = event.ca;
    const url = safeAlertLogo(event.logoUrl, this.origin);
    if (url !== this.imageUrl) {
      this.imageUrl = url; this.logo.replaceChildren(); this.logo.textContent = '◈';
      if (url) {
        const image = element(this.document, 'img', ''); image.alt = '代币标志'; image.src = url; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true }); this.logo.append(image);
      }
    }
  }
  tick() {
    if (this.stopped) return;
    if (this.frame !== null) { this.cancelFrame?.(this.frame); this.frame = null; }
    const now = this.clock();
    for (const event of this.events) if (event.expiresAt <= now) this.finished.add(event.id);
    const event = activeAlert(this.events.filter(event => !this.finished.has(event.id)), now);
    this.surface.hidden = !event;
    if (event) {
      if (this.activeId !== event.id) this.mount(event);
      this.metadata(event);
      const progress = alertProgress(event, now), duration = event.expiresAt - event.startsAt;
      const opacity = Math.min(1, progress * duration / 300, (1 - progress) * duration / 500);
      this.surface.dataset.progress = progress.toFixed(5); this.card.style.opacity = String(opacity);
      this.progress.style.transform = `scaleX(${1 - progress})`;
      const box = this.surface.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(box.width * dpr)), height = Math.max(1, Math.round(box.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      const ctx = this.canvas.getContext('2d');
      if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); paintAlertArt(ctx, box.width, box.height, event, progress, this.reducedMotion); }
    }
    if (this.events.some(event => event.expiresAt > now) && this.requestFrame) this.frame = this.requestFrame(() => { this.frame = null; this.tick(); });
  }
  stop() {
    this.stopped = true; this.cancelFrame?.(this.frame); this.frame = null;
    this.events = []; this.surface.replaceChildren(); this.surface.hidden = true;
  }
}
