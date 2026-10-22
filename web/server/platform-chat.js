import { createHash } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'];
const EVENT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const PLAIN_NAME = /^[^\u0000-\u001f\u007f<>]{1,120}$/u;
export const PLATFORM_CHAT_TTL_MS = 8 * 60 * 60 * 1000;
export const PLATFORM_CHAT_MAX_ENTRIES = 10000;

function reject(statusCode, code) { throw Object.assign(new Error(code), { statusCode }); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

export function platformRequestId(broadcastId, eventId) {
  return digest(JSON.stringify(['x-live', broadcastId, eventId]));
}

export class PlatformChat {
  constructor(broker, config, auth, { now = Date.now, ttlMs = PLATFORM_CHAT_TTL_MS,
    maxEntries = PLATFORM_CHAT_MAX_ENTRIES } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('INVALID_PLATFORM_CHAT_LIMITS');
    }
    this.broker = broker; this.config = config; this.auth = auth;
    this.now = now; this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.accepted = new Map();
  }

  authorize(request) {
    // Only a local collector with the existing worker credential can submit platform events.
    // Reason: viewer cookies, Origin and forwarded client addresses are not collector authentication.
    if (!this.auth.worker(request)) reject(401, 'PLATFORM_WORKER_REQUIRED');
    // Reject forwarded requests even when their last network hop is local.
    // Reason: the public reverse proxy reaches core through loopback, while the collector connects directly.
    if (PROXY_HEADERS.some(header => Object.hasOwn(request.headers, header))) {
      reject(403, 'PLATFORM_DIRECT_LOOPBACK_REQUIRED');
    }
    if (!LOOPBACK.has(request.socket?.remoteAddress)) reject(403, 'PLATFORM_LOOPBACK_REQUIRED');
  }

  validate(body) {
    if (!this.config.xBroadcastId) reject(503, 'PLATFORM_CHAT_DISABLED');
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['broadcastId', 'eventId', 'text', 'author'].includes(key))) {
      reject(400, 'PLATFORM_EVENT_INVALID');
    }
    if (body.broadcastId !== this.config.xBroadcastId) reject(400, 'PLATFORM_BROADCAST_MISMATCH');
    if (typeof body.eventId !== 'string' || !EVENT_ID.test(body.eventId)) reject(400, 'PLATFORM_EVENT_ID_INVALID');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > this.config.maxTextLength
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.text)) reject(400, 'PLATFORM_TEXT_INVALID');
    let author;
    if (body.author !== undefined) {
      if (!body.author || typeof body.author !== 'object' || Array.isArray(body.author)
        || Object.keys(body.author).some(key => !['id', 'name'].includes(key))) reject(400, 'PLATFORM_AUTHOR_INVALID');
      author = {};
      if (body.author.id !== undefined) {
        if (typeof body.author.id !== 'string' || !EVENT_ID.test(body.author.id)) reject(400, 'PLATFORM_AUTHOR_INVALID');
        author.id = body.author.id;
      }
      if (body.author.name !== undefined) {
        if (typeof body.author.name !== 'string' || !PLAIN_NAME.test(body.author.name)) reject(400, 'PLATFORM_AUTHOR_INVALID');
        author.name = body.author.name;
      }
    }
    return { broadcastId: body.broadcastId, eventId: body.eventId, text: body.text.trim(), author };
  }

  prune(at) {
    // Entries have a fixed acceptance expiry and remain in insertion order.
    // Reason: duplicate retries must not extend retention or evict a still-protected accepted event.
    for (const [id, entry] of this.accepted) {
      if (entry.expiresAt > at) break;
      this.accepted.delete(id);
    }
  }

  submit(body) {
    const event = this.validate(body), at = this.now(); this.prune(at);
    const id = platformRequestId(event.broadcastId, event.eventId), textHash = digest(event.text);
    const previous = this.accepted.get(id);
    if (previous) {
      if (previous.textHash !== textHash) reject(409, 'PLATFORM_EVENT_CONFLICT');
      return { statusCode: 200, receipt: { ...previous.receipt, duplicate: true } };
    }
    if (this.accepted.size >= this.maxEntries) reject(503, 'PLATFORM_DEDUP_CAPACITY');
    let result;
    try {
      result = this.broker.submit(event.text, { id, kind: 'chat', source: 'x-live',
        broadcastId: event.broadcastId, eventId: event.eventId, ...(event.author ? { author: event.author } : {}) });
    } catch (error) {
      if (error.statusCode === 409) reject(503, 'PLATFORM_ACTOR_BUSY');
      throw error;
    }
    const receipt = { ...result, accepted: true, source: 'x-live', broadcastId: event.broadcastId, eventId: event.eventId };
    // Commit deduplication only after the queue accepted the event.
    // Reason: source unavailability and a full queue must remain retryable by the durable collector.
    this.accepted.set(id, { textHash, receipt, expiresAt: at + this.ttlMs });
    return { statusCode: 202, receipt: { ...receipt, duplicate: false } };
  }

  close() { this.accepted.clear(); }
}
