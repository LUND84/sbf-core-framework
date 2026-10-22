import { normalizeAddress } from './policies.js';

async function bytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('METADATA_UNAVAILABLE');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > limit) { await response.body.cancel?.().catch(() => {}); throw new Error('METADATA_TOO_LARGE'); }
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

export class TokenMetadata {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; this.cache = new Map(); }
  async lookup(chain, ca) {
    normalizeAddress(chain, ca);
    const key = `${chain}:${ca}`, cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await this.fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${encodeURIComponent(ca)}`,
      { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const pairs = JSON.parse((await bytes(response, 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(pairs)) throw new Error('INVALID_TOKEN_METADATA');
    const matches = pairs.filter(p => {
      if (p.chainId !== chain) return false;
      try { return normalizeAddress(chain, p.baseToken?.address) === normalizeAddress(chain, ca); } catch { return false; }
    }).sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const pair = matches[0], value = {};
    if (pair) {
      value.symbol = String(pair.baseToken.symbol || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
      if (typeof pair.info?.imageUrl === 'string') {
        const url = new URL(pair.info.imageUrl);
        if (url.protocol === 'https:' && url.hostname === 'cdn.dexscreener.com'
          && !url.username && !url.password && !url.port) value.logo = url.href;
      }
    }
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { value, expiresAt: Date.now() + 5 * 60 * 1000 }); return value;
  }
  async image(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'cdn.dexscreener.com'
      || target.username || target.password || target.port) throw new Error('LOGO_HOST_REJECTED');
    const response = await this.fetch(target, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const buffer = await bytes(response, 512 * 1024);
    const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) throw new Error('INVALID_LOGO_TYPE');
    return { buffer, type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
  }
}
