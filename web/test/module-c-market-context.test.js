import test from 'node:test';
import assert from 'node:assert/strict';
import { PaidMarketContext } from '../server/module-c/market-context.js';

const ca = '0x' + '2'.repeat(40), pool = '0x' + '3'.repeat(40);
const pair = (overrides = {}) => ({ chainId: 'bsc', pairAddress: pool, dexId: 'pancakeswap',
  baseToken: { address: ca, name: 'Fixture Token', symbol: 'FXT' }, priceUsd: '0.00125',
  liquidity: { usd: 30000 }, volume: { h24: 4000, h1: 200 }, priceChange: { h24: -5.5, h1: 2 },
  txns: { h24: { buys: 20, sells: 8 } }, pairCreatedAt: 1700000000000, ...overrides });

test('fixed official endpoint binds chain and exact base CA and selects one highest-liquidity pair', async () => {
  let calls = 0;
  const context = new PaidMarketContext({ now: () => 1792500000000, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, `https://api.dexscreener.com/tokens/v1/bsc/${ca}`);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json([
      pair({ chainId: 'ethereum', liquidity: { usd: 1e12 } }),
      pair({ baseToken: { address: pool }, quoteToken: { address: ca }, liquidity: { usd: 1e12 } }),
      pair({ baseToken: { address: ca.slice(0, -1) + '4' }, liquidity: { usd: 1e12 } }),
      pair({ liquidity: { usd: 20 }, priceUsd: '99' }), pair(),
    ]);
  } });
  const value = await context.lookup('bsc', ca.toUpperCase().replace('0X', '0x'));
  assert.equal(calls, 1); assert.equal(value.status, 'ok'); assert.equal(value.ca, ca);
  assert.equal(value.market.priceUsd, 0.00125); assert.equal(value.market.liquidityUsd, 30000);
  assert.equal(value.market.priceChangePercent.h24, -5.5); assert.equal(value.market.volumeUsd.h24, 4000);
  assert.deepEqual(value.market.transactions.h24, { buys: 20, sells: 8 });
  assert.equal(value.market.priceChangePercent.h6, null); assert.equal(value.sourcedAt, 1792500000000);
  assert.equal(value.source.provider, 'DexScreener'); assert.equal(value.source.nativeOnChain, false);
  assert.equal(value.source.timestampKind, 'retrieval-time'); assert.equal(value.source.observationTimestampAvailable, false);
});

test('all four existing chains remain independently queryable and same CA on another chain never shares cache', async () => {
  const addresses = { ethereum: ca, bsc: ca, solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' };
  const urls = [];
  const context = new PaidMarketContext({ fetchImpl: async url => {
    urls.push(url); const chain = url.split('/')[5];
    return Response.json([pair({ chainId: chain, pairAddress: addresses[chain], baseToken: { address: addresses[chain] } })]);
  } });
  for (const [chain, address] of Object.entries(addresses)) {
    const result = await context.lookup(chain, address);
    assert.equal(result.status, 'ok'); assert.equal(result.chain, chain); assert.equal(result.ca, address);
  }
  assert.equal(urls.length, 4);
});

test('malformed numeric fields stay null instead of becoming prices, volumes or trading facts', async () => {
  const context = new PaidMarketContext({ fetchImpl: async () => Response.json([pair({ priceUsd: 'Infinity',
    liquidity: { usd: -5 }, volume: { h24: '9000', h1: null, m5: false },
    priceChange: { h24: '20%', h1: -1.2 }, txns: { h24: { buys: 1.5, sells: -1 } },
    baseToken: { address: ca, symbol: '<FXT>\u0000', name: 'Fixture\nName' },
  })]) });
  const value = await context.lookup('bsc', ca);
  assert.equal(value.status, 'ok'); assert.equal(value.market.priceUsd, null);
  assert.equal(value.market.liquidityUsd, null); assert.equal(value.market.volumeUsd.h24, null);
  assert.equal(value.market.priceChangePercent.h24, null); assert.equal(value.market.priceChangePercent.h1, -1.2);
  assert.deepEqual(value.market.transactions.h24, { buys: null, sells: null });
  assert.equal(value.token.symbol, 'FXT'); assert.equal(value.token.name, 'FixtureName');
});

test('empty, quote-only and wholly invalid metrics clearly report no data without user-supplied facts', async () => {
  for (const rows of [[], [pair({ baseToken: { address: pool }, quoteToken: { address: ca } })],
    [pair({ priceUsd: 'NaN', liquidity: null, volume: null, priceChange: null, txns: null })]]) {
    const context = new PaidMarketContext({ fetchImpl: async () => Response.json(rows) });
    const value = await context.lookup('bsc', ca, { priceUsd: 999, prediction: 'will rise' });
    assert.equal(value.status, 'no-data'); assert.equal(value.market, null);
    assert.equal(value.reason, 'NO_VALID_EXACT_BASE_TOKEN_MARKET'); assert.equal(JSON.stringify(value).includes('will rise'), false);
  }
});

test('provider errors invalid JSON HTML and both declared and streamed oversized bodies fail closed', async () => {
  const responses = [() => Response.json({ error: 'private provider body' }, { status: 503 }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    () => new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } })];
  for (const response of responses) {
    const value = await new PaidMarketContext({ fetchImpl: async () => response() }).lookup('bsc', ca);
    assert.equal(value.status, 'unavailable'); assert.equal(value.market, null);
    assert.equal(JSON.stringify(value).includes('private'), false);
  }
});

test('overall timeout bounds a provider ignoring abort and invalid chain or CA performs no request', async () => {
  let calls = 0;
  const context = new PaidMarketContext({ timeoutMs: 20, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  const value = await context.lookup('bsc', ca);
  assert.equal(value.status, 'unavailable'); assert.equal(value.reason, 'PROVIDER_TIMEOUT');
  for (const args of [['unsupported', ca], ['bsc', 'https://private.invalid/secret']]) {
    const result = await context.lookup(...args); assert.equal(result.status, 'invalid-input');
    assert.equal(result.source, null); assert.equal(result.ca, null);
  }
  assert.equal(calls, 1);
});

test('cache is short lived canonical scoped deduplicated and immune to caller mutation', async () => {
  let now = 1000, calls = 0;
  const context = new PaidMarketContext({ now: () => now, cacheTtlMs: 30, fetchImpl: async () => {
    calls++; await new Promise(resolve => setImmediate(resolve)); return Response.json([pair()]);
  } });
  const [one, two] = await Promise.all([context.lookup('bsc', ca), context.lookup('bsc', ca)]);
  assert.equal(calls, 1); one.market.priceUsd = 999; assert.equal(two.market.priceUsd, 0.00125);
  assert.equal((await context.lookup('bsc', ca)).market.priceUsd, 0.00125); assert.equal(calls, 1);
  now += 31; assert.equal((await context.lookup('bsc', ca)).status, 'ok'); assert.equal(calls, 2);
  assert.throws(() => new PaidMarketContext({ cacheTtlMs: 30001 }), /INVALID_MARKET_OPTIONS/);
});
