import { createHmac, timingSafeEqual } from 'node:crypto';

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuth(config) {
  const token = createHmac('sha256', config.sessionSecret)
    .update(config.accessCode).digest('hex');
  return {
    required: Boolean(config.accessCode),
    viewer(request) {
      if (!config.accessCode) return true;
      const cookie = request.headers.cookie || '';
      const value = cookie.split(';').map((part) => part.trim())
        .find((part) => part.startsWith('sbf_demo='))?.slice(9) || '';
      return safeEqual(value, token);
    },
    worker(request) {
      if (!config.workerToken) return false;
      return safeEqual(request.headers.authorization || '', `Bearer ${config.workerToken}`);
    },
    login(code, secure) {
      if (!safeEqual(code ?? '', config.accessCode)) return null;
      return `sbf_demo=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`;
    },
    origin(request) {
      const origin = request.headers.origin;
      if (!origin) return false;
      if (config.publicOrigin) return origin === config.publicOrigin;
      const scheme = config.trustProxy && request.headers['x-forwarded-proto'] === 'https'
        ? 'https' : 'http';
      return origin === `${scheme}://${request.headers.host}`;
    },
    isSecure(request) {
      return Boolean(request.socket.encrypted)
        || (config.trustProxy && request.headers['x-forwarded-proto'] === 'https');
    },
  };
}

export class RateLimiter {
  constructor(limit, windowMs, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.buckets = new Map();
  }

  allow(key) {
    const now = this.clock();
    if (this.buckets.size > 1000) {
      for (const [ip, bucket] of this.buckets) {
        if (now - bucket.start >= this.windowMs) this.buckets.delete(ip);
      }
      if (this.buckets.size > 2000) return false;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}
