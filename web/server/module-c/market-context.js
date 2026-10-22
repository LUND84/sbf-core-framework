import { normalizeAddress } from './policies.js';

const CHAINS = new Set(['solana', 'tron', 'ethereum', 'bsc']);
const WINDOWS = ['m5', 'h1', 'h6', 'h24'];
const API = 'https://api.dexscreener.com/tokens/v1/';
const MAX_BYTES = 1024 * 1024;

function number(value, { signed = false, string = false, integer = false } = {}) {
  if (string && typeof value === 'string' && value.length <= 80
    && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)
    || (integer && !Number.isSafeInteger(value))) return null;
  return value;
}

function label(value, limit) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>\[\]{}]/g, '')
    .trim().slice(0, limit) : '';
}

function windowValues(value, signed = false) {
  return Object.fromEntries(WINDOWS.map(window => [window, number(value?.[window], { signed })]));
}

function pairContext(pair, chain, ca) {
  if (!pair || pair.chainId !== chain) return null;
  let address, pairAddress;
  try {
    address = normalizeAddress(chain, pair.baseToken?.address);
    pairAddress = normalizeAddress(chain, pair.pairAddress);
  } catch { return null; }
  if (address !== ca) return null;
  const token = { address, name: label(pair.baseToken.name, 80), symbol: label(pair.baseToken.symbol, 24) };
  const market = { pairAddress, dexId: typeof pair.dexId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(pair.dexId)
    ? pair.dexId : null, priceUsd: number(pair.priceUsd, { string: true }),
  priceChangePercent: windowValues(pair.priceChange, true), liquidityUsd: number(pair.liquidity?.usd),
  volumeUsd: windowValues(pair.volume), transactions: Object.fromEntries(WINDOWS.map(window => [window, {
    buys: number(pair.txns?.[window]?.buys, { integer: true }), sells: number(pair.txns?.[window]?.sells, { integer: true }),
  }])), pairCreatedAt: number(pair.pairCreatedAt, { integer: true }) };
  const hasMetric = market.priceUsd !== null || market.liquidityUsd !== null
    || Object.values(market.priceChangePercent).some(value => value !== null)
    || Object.values(market.volumeUsd).some(value => value !== null)
    || Object.values(market.transactions).some(value => value.buys !== null || value.sells !== null);
  return hasMetric ? { token, market } : null;
}

async function jsonBody(response, signal) {
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > MAX_BYTES
    || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('MARKET_PROVIDER_RESPONSE');
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('MARKET_PROVIDER_TIMEOUT');
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('MARKET_PROVIDER_BODY_LIMIT');
      chunks.push(Buffer.from(result.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

// Fetch only fixed-host token data; token labels and fields remain data, never instructions.
// Reason: a paid message must not choose a URL, inject market facts, or become an LLM system prompt.
export class PaidMarketContext {
  constructor({ fetchImpl = fetch, now = Date.now, timeoutMs = 2500, cacheTtlMs = 15000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2800
      || !Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 30000) throw new Error('INVALID_MARKET_OPTIONS');
    this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs; this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map(); this.inflight = new Map();
  }

  async lookup(chain, ca) {
    let canonical;
    try {
      if (!CHAINS.has(chain)) throw new Error('INVALID_MARKET_CHAIN');
      canonical = normalizeAddress(chain, ca);
    } catch {
      return { sourcedAt: this.now(), chain: CHAINS.has(chain) ? chain : null, ca: null, status: 'invalid-input',
        token: { address: null }, market: null, source: null, reason: 'INVALID_CHAIN_OR_CA' };
    }
    const key = `${chain}:${canonical}`, cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return structuredClone(cached.value);
    let task = this.inflight.get(key);
    if (!task) {
      task = this.retrieve(chain, canonical).then(value => {
        if (this.cache.size >= 256 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value);
        const ttl = value.status === 'unavailable' ? Math.min(this.cacheTtlMs, 2000) : this.cacheTtlMs;
        this.cache.set(key, { value, expiresAt: this.now() + ttl }); return value;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
    return structuredClone(await task);
  }

  async retrieve(chain, ca) {
    const url = API + chain + '/' + encodeURIComponent(ca);
    const source = { provider: 'DexScreener', kind: 'dex-market-data', url,
      documentation: 'https://docs.dexscreener.com/api/reference', nativeOnChain: false,
      timestampKind: 'retrieval-time', observationTimestampAvailable: false,
      pairSelection: 'highest-reported-usd-liquidity-matching-base-token' };
    const result = { sourcedAt: this.now(), chain, ca, status: 'unavailable', token: { address: ca }, market: null, source };
    const controller = new AbortController(); let timer;
    try {
      const pairs = await Promise.race([
        (async () => jsonBody(await this.fetch(url, { redirect: 'error', signal: controller.signal }), controller.signal))(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MARKET_PROVIDER_TIMEOUT')); }, this.timeoutMs); }),
      ]);
      if (!Array.isArray(pairs) || pairs.length > 1000) throw new Error('MARKET_PROVIDER_SCHEMA');
      const matches = pairs.map(pair => pairContext(pair, chain, ca)).filter(Boolean)
        .sort((a, b) => (b.market.liquidityUsd ?? -1) - (a.market.liquidityUsd ?? -1)
          || (b.market.volumeUsd.h24 ?? -1) - (a.market.volumeUsd.h24 ?? -1));
      result.sourcedAt = this.now();
      if (matches.length) return { ...result, status: 'ok', ...matches[0] };
      return { ...result, status: 'no-data', reason: 'NO_VALID_EXACT_BASE_TOKEN_MARKET' };
    } catch {
      return { ...result, sourcedAt: this.now(), reason: controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE' };
    } finally { clearTimeout(timer); }
  }
}
