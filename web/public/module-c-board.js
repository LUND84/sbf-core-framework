import { PaidAlerts } from './module-c-alerts.js';

const interactionLabels = {
  queued: '等待主播回应', waiting: '等待主播回应', pending: '等待主播回应',
  dispatching: '正在提交给主播', running: '主播正在回应', needs_review: '回应待人工处理',
  done: '主播已回应', completed: '主播已回应', error: '回应待处理', interrupted: '回应已停止',
};

export function timestamp(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

export function countdown(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((timestamp(expiresAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function interactionLabel(state) {
  return interactionLabels[state] || '等待主播回应';
}

function node(document, tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function safeLogo(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.href : '';
  } catch { return ''; }
}

export class PaidBoard {
  constructor(element, { document = element.ownerDocument, origin = location.origin, now = Date.now } = {}) {
    this.element = element;
    this.document = document;
    this.origin = origin;
    this.now = now;
    this.offset = 0;
    this.entries = [];
    this.lastSignature = '';
    this.times = [];
  }

  update({ entries = [], serverTime } = {}) {
    const server = timestamp(serverTime);
    if (Number.isFinite(server)) this.offset = server - this.now();
    this.entries = Array.isArray(entries) ? entries : [];
    this.tick();
  }

  tick() {
    const now = this.now() + this.offset;
    const entries = this.entries.filter((entry) => timestamp(entry.expiresAt) > now
      && (!entry.startsAt || timestamp(entry.startsAt) <= now));
    const signature = JSON.stringify(entries);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.render(entries);
    }
    for (const { element, expiresAt } of this.times) {
      element.textContent = countdown(expiresAt, now);
    }
  }

  render(entries) {
    this.element.replaceChildren();
    this.times = [];
    this.element.hidden = entries.length === 0;
    if (!entries.length) return;
    const heading = node(this.document, 'div', 'mc-board-heading', '付费留言');
    heading.append(node(this.document, 'span', 'mc-board-count', `${entries.length} 条`));
    this.element.append(heading);
    const list = node(this.document, 'div', 'mc-board-list');
    for (const entry of entries) {
      const card = node(this.document, 'article', 'mc-board-card');
      const header = node(this.document, 'div', 'mc-card-heading');
      const logo = node(this.document, 'span', 'mc-token-logo', '◈');
      const url = safeLogo(entry.logoUrl, this.origin);
      if (url) {
        const image = node(this.document, 'img', '');
        image.alt = '代币标志';
        image.src = url;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        logo.append(image);
      }
      const name = node(this.document, 'strong', 'mc-card-name', entry.name || '匿名观众');
      const amount = node(this.document, 'span', 'mc-card-amount', `${entry.amount} U`);
      header.append(logo, name, amount);
      const chain = node(this.document, 'span', 'mc-card-chain', `${entry.tokenChain || entry.chain} · CA`);
      const ca = node(this.document, 'code', 'mc-card-ca', entry.ca || '');
      ca.title = entry.ca || '';
      const message = node(this.document, 'p', 'mc-card-message', entry.message || '');
      const footer = node(this.document, 'div', 'mc-card-footer');
      const time = node(this.document, 'span', 'mc-card-time');
      time.setAttribute('aria-label', '剩余展示时间');
      footer.append(node(this.document, 'span', '', interactionLabel(entry.interactionState)), time);
      this.times.push({ element: time, expiresAt: entry.expiresAt });
      card.append(header, chain, ca, message, footer);
      list.append(card);
    }
    this.element.append(list);
  }
}

export function installPaidBoard(element, { fetcher = fetch, alertsElement = null, ...options } = {}) {
  const board = new PaidBoard(element, options);
  const alerts = alertsElement ? new PaidAlerts(alertsElement, options) : null;
  let pending = false;
  let stopped = false;
  const refresh = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const response = await fetcher('/api/module-c/board', { credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(7000) });
      if (response.ok && !stopped) {
        const value = await response.json();
        if (!stopped) { board.update(value); alerts?.update(value); }
      }
    } catch { /* Existing cards expire locally during a temporary network failure. Reason: no stale paid placement is extended. */ }
    finally { pending = false; }
  };
  void refresh();
  const poll = setInterval(refresh, 1000);
  const tick = setInterval(() => board.tick(), 1000);
  return { board, alerts, refresh, stop: () => {
    stopped = true; clearInterval(poll); clearInterval(tick); alerts?.stop();
  } };
}
