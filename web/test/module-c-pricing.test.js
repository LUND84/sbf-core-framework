import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_TIERS, PricingStore } from '../server/module-c/pricing.js';
import { ModuleC } from '../server/module-c/service.js';
import { PaymentStore } from '../server/module-c/store.js';
import { parseUnits, readModuleCConfig } from '../server/module-c/policies.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { moduleCAdminSecureTransport } from '../server/module-c/routes.js';

const recipient = '0x1111111111111111111111111111111111111111';
const walletProof = { payer: recipient, signature: 'pricing-fixture-wallet-signature' };
const signed = (service, id, txHash) => service.verify(id, txHash, walletProof);
const verifyWallet = (order, txHash, proof) => {
  assert.deepEqual(proof, walletProof); return recipient;
};
const ca = '0x2222222222222222222222222222222222222222';
const adminToken = 'pricing-admin-separate-secret-20261019';
const input = extra => ({ chain: 'ethereum', ca, amount: '20', message: 'Discuss this token', ...extra });
const freshTiers = () => structuredClone(DEFAULT_TIERS);
const revisionError = error => error.statusCode === 409 && error.message === 'PRICING_REVISION_CONFLICT';
const cleanupResources = new WeakMap();
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'sbf-module-c-pricing-'));
  const resources = []; cleanupResources.set(t, resources);
  t.after(async () => {
    try { for (const resource of resources) await resource.close(); }
    finally { rmSync(path, { recursive: true, force: true }); }
  }); return path;
}
function pricing(t) {
  const path = join(directory(t), 'pricing.json'), store = new PricingStore(path);
  cleanupResources.get(t).push(store); return { path, store };
}
class Broker extends EventEmitter {
  constructor() { super(); this.accepted = []; }
  submit(text, metadata) { this.accepted.push({ text, ...metadata }); return { id: metadata.id }; }
}
function fixture(t) {
  const path = directory(t), config = readModuleCConfig({ MODULE_C_ENABLED: '1',
    MODULE_C_ETHEREUM_RECIPIENT: recipient, MODULE_C_DATA_FILE: join(path, 'orders.json') });
  const resources = [], broker = new Broker();
  const start = () => {
    const service = new ModuleC(config, broker, { timers: false, verifyWallet, marketContext: async (chain, ca) => ({ chain, ca, status: 'unavailable' }), metadata: async () => ({}),
      now: () => 1792400000000, verify: async o => ({ state: 'confirmed', amountAtomic: o.amountAtomic,
        paidAt: o.createdAt, payer: recipient }) });
    resources.push(service); return service;
  };
  cleanupResources.get(t).push({ close: async () => { for (const service of resources) await service.close(); } });
  return { path, config, broker, start };
}

test('seven default tiers are durable, isolated from callers and reloaded after restart', t => {
  const { path, store } = pricing(t);
  assert.deepEqual(store.get(), { revision: 1, tiers: freshTiers() });
  const copy = store.get(); copy.tiers[0].price = '1';
  assert.equal(store.get().tiers[0].price, '20');
  const tiers = freshTiers(); tiers[0].price = '20.25'; tiers[0].durationSeconds = 37;
  assert.equal(store.update({ expectedRevision: 1, tiers }).revision, 2);
  tiers[0].durationSeconds = 99; store.close();
  const restarted = new PricingStore(path); cleanupResources.get(t).push(restarted);
  assert.deepEqual(restarted.get().tiers[0], { id: 'tier-1', price: '20.25', durationSeconds: 37 });
  assert.equal(restarted.get().revision, 2);
  assert.deepEqual(readdirSync(join(path, '..')).sort(), ['pricing.json', 'pricing.json.lock']);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('CAS rejects stale writes and unknown schema without changing durable pricing', t => {
  const { path, store } = pricing(t), tiers = freshTiers();
  store.update({ expectedRevision: 1, tiers }); const saved = readFileSync(path, 'utf8');
  assert.throws(() => store.update({ expectedRevision: 1, tiers }), revisionError);
  for (const body of [{ revision: 2, tiers }, { expectedRevision: 2, tiers, extra: true },
    { expectedRevision: 2 }, { expectedRevision: '2', tiers }, { expectedRevision: 2.5, tiers }, null, []]) {
    assert.throws(() => store.update(body), /INVALID_PRICING_UPDATE/);
    assert.equal(readFileSync(path, 'utf8'), saved); assert.equal(store.get().revision, 2);
  }
});

test('price and duration boundaries are validated before any pricing write', t => {
  const { path, store } = pricing(t), saved = readFileSync(path, 'utf8');
  const mutations = [tiers => tiers.pop(), tiers => tiers.push(tiers[0]), tiers => { tiers[0].id = 'tier-2'; },
    tiers => { tiers[0].extra = true; }, tiers => { delete tiers[0].durationSeconds; },
    ...['0', '0.001', '100000.01', '-1', '1e2', ' 20', 20].map(price => tiers => { tiers[0].price = price; }),
    tiers => { tiers[1].price = '20'; }, tiers => { tiers[1].price = '19.99'; },
    ...[0, -1, 1.5, '30', 31536001, Number.NaN].map(seconds => tiers => { tiers[0].durationSeconds = seconds; })];
  for (const mutate of mutations) {
    const tiers = freshTiers(); mutate(tiers);
    assert.throws(() => store.update({ expectedRevision: 1, tiers }));
    assert.equal(readFileSync(path, 'utf8'), saved); assert.equal(store.get().revision, 1);
  }
  const tiers = freshTiers(); tiers[0] = { id: 'tier-1', price: '0.01', durationSeconds: 1 };
  tiers[6] = { id: 'tier-7', price: '100000.00', durationSeconds: 31536000 };
  const result = store.update({ expectedRevision: 1, tiers });
  assert.equal(result.tiers[0].price, '0.01'); assert.equal(result.tiers[6].price, '100000');
});

test('corrupt pricing rejects startup, preserves bytes and releases owned locks', t => {
  const path = join(directory(t), 'pricing.json');
  for (const value of ['{broken', JSON.stringify({ version: 1, revision: 0, tiers: freshTiers() }),
    JSON.stringify({ version: 1, revision: 1, tiers: freshTiers().slice(1) })]) {
    writeFileSync(path, value);
    assert.throws(() => new PricingStore(path), /MODULE_C_PRICING_INVALID/);
    assert.equal(readFileSync(path, 'utf8'), value); assert.equal(existsSync(path + '.lock'), false);
  }
});

test('pricing has one writer and recovers only an exited owner', t => {
  const { path, store } = pricing(t);
  assert.throws(() => new PricingStore(path), /MODULE_C_PRICING_LOCKED/); store.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {PricingStore} from ${JSON.stringify(new URL('../server/module-c/pricing.js', import.meta.url).href)}; new PricingStore(process.argv[1]);`, path], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(existsSync(path + '.lock'), true);
  const recovered = new PricingStore(path); recovered.close();
  assert.equal(existsSync(path + '.lock'), false);
});

test('failed atomic replacement keeps previous pricing and removes incomplete temporary files', t => {
  const { path, store } = pricing(t), saved = readFileSync(path, 'utf8'), blocked = join(path, '..', 'blocked');
  mkdirSync(blocked); store.path = blocked;
  assert.throws(() => store.update({ expectedRevision: 1, tiers: freshTiers() }), /MODULE_C_PRICING_WRITE_FAILED/);
  assert.equal(store.get().revision, 1); assert.equal(readFileSync(path, 'utf8'), saved);
  assert.equal(readdirSync(join(path, '..')).some(name => name.endsWith('.tmp')), false); store.path = path;
});

test('configuration separates pricing from the ledger and rejects reused worker credentials', t => {
  const path = directory(t), dataFile = join(path, 'orders.json');
  const config = readModuleCConfig({ MODULE_C_DATA_FILE: dataFile });
  assert.equal(config.pricingDataFile, join(path, 'pricing.json')); assert.equal(config.adminToken, '');
  assert.throws(() => readModuleCConfig({ MODULE_C_DATA_FILE: dataFile, MODULE_C_PRICING_DATA_FILE: dataFile }), /MUST_BE_SEPARATE/);
  assert.throws(() => readModuleCConfig({ MODULE_C_PRICING_DATA_FILE: 'relative.json' }), /ABSOLUTE_PRICING/);
  assert.throws(() => readModuleCConfig({ MODULE_C_DATA_FILE: dataFile, MODULE_C_PRICING_DATA_FILE: join(path, 'other', 'pricing.json') }), /SHARE_STATE_DIRECTORY/);
  for (const value of ['a', 'a'.repeat(31), 'a'.repeat(513), 'a'.repeat(31) + ' ', '密'.repeat(32)]) {
    assert.throws(() => readModuleCConfig({ MODULE_C_DATA_FILE: dataFile, MODULE_C_ADMIN_TOKEN: value }), /ADMIN_TOKEN/);
  }
  for (const value of ['a'.repeat(32), 'a'.repeat(512)]) {
    assert.equal(readModuleCConfig({ MODULE_C_DATA_FILE: dataFile, MODULE_C_ADMIN_TOKEN: value }).adminToken, value);
  }
  const shared = 'same'.repeat(16);
  assert.throws(() => readModuleCConfig({ MODULE_C_DATA_FILE: dataFile, MODULE_C_ADMIN_TOKEN: shared, WORKER_TOKEN: shared }), /ADMIN_TOKEN/);
});

test('a pricing startup error releases the payment writer instead of stranding the ledger', t => {
  const f = fixture(t); writeFileSync(f.config.pricingDataFile, '{invalid');
  assert.throws(() => f.start(), /MODULE_C_PRICING_INVALID/);
  const store = new PaymentStore(f.config.dataFile); store.close();
});

test('all seven orders use tier snapshots and authoritative nonlinear duration', t => {
  const f = fixture(t), service = f.start();
  const config = service.publicConfig();
  assert.equal(config.minAmount, '20'); assert.equal(config.secondsPer20, 30);
  assert.deepEqual(config.pricing, { revision: 1, tiers: freshTiers() });
  for (const tier of DEFAULT_TIERS) {
    const order = service.create(input({ tierId: tier.id, pricingRevision: 1, amount: tier.price }));
    assert.equal(order.tierId, tier.id); assert.equal(order.pricingRevision, 1);
    assert.equal(order.amount, tier.price); assert.equal(order.durationMs, tier.durationSeconds * 1000);
    assert.equal(service.get(order.id).durationMs, tier.durationSeconds * 1000);
    assert.equal(parseUnits(order.payAmount, 6), parseUnits(tier.price, 6));
  }
});

test('new checkout rejects stale revisions, wrong prices and incomplete pricing tuples', t => {
  const service = fixture(t).start(), base = { tierId: 'tier-1', pricingRevision: 1 };
  assert.throws(() => service.create(input({ ...base, pricingRevision: 2 })), revisionError);
  assert.throws(() => service.create(input({ ...base, amount: '50' })), /ORDER_PRICE_MISMATCH/);
  assert.throws(() => service.create(input({ ...base, tierId: 'tier-8' })), /INVALID_PRICING_TIER/);
  for (const extra of [{ tierId: 'tier-1' }, { pricingRevision: 1 }, { ...base, pricingRevision: '1' }]) {
    assert.throws(() => service.create(input(extra)), /INVALID_ORDER_PRICING/);
  }
  assert.throws(() => service.create(input({ amount: '40' })), /AMOUNT_MUST_MATCH_PRICING_TIER/);
  const legacy = service.create(input({ amount: '20.00' }));
  assert.equal(legacy.tierId, 'tier-1'); assert.equal(legacy.durationMs, 30000);
  assert.equal(service.store.all().length, 1);
});

test('admin transport trusts TLS or direct loopback and rejects forwarded HTTPS spoofing', () => {
  const request = (remoteAddress, headers = {}, encrypted = false) => ({ socket: { remoteAddress, encrypted }, headers });
  assert.equal(moduleCAdminSecureTransport(request('203.0.113.1', {}, true), false), true);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1'), false), true);
  assert.equal(moduleCAdminSecureTransport(request('::1'), false), true);
  assert.equal(moduleCAdminSecureTransport(request('203.0.113.1', { 'x-forwarded-proto': 'https' }), true), false);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1', { 'x-forwarded-proto': 'https' }), false), false);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1', { 'x-forwarded-proto': 'http' }), true), false);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1', { 'x-forwarded-proto': 'https,http' }), true), false);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1', { forwarded: 'proto=https' }), true), false);
  assert.equal(moduleCAdminSecureTransport(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' }), true), true);
});

test('pricing edits preserve awaiting, paid and pre-tier legacy rights across restart', async t => {
  const f = fixture(t), service = f.start();
  const pending = service.create(input()), paid = service.create(input({ amount: '50' }));
  await signed(service, paid.id, '0x' + 'a'.repeat(64));
  const confirming = service.create(input({ tierId: 'tier-3', pricingRevision: 1, amount: '100' }));
  service.verifyPayment = async () => ({ state: 'pending' });
  await signed(service, confirming.id, '0x' + 'c'.repeat(64));
  const legacy = service.get(pending.id); delete legacy.tierId; delete legacy.pricingRevision; delete legacy.paymentMode;
  legacy.durationMs = 60000; service.store.put(legacy);
  const tiers = freshTiers(); tiers[0].price = '21.25'; tiers[0].durationSeconds = 99; tiers[1].durationSeconds = 250;
  tiers[2].durationSeconds = 600;
  service.pricing.update({ expectedRevision: 1, tiers });
  const config = service.publicConfig(); assert.equal(config.minAmount, '21.25'); assert.equal(config.secondsPer20, 99);
  assert.throws(() => service.create(input()), /AMOUNT_MUST_MATCH_PRICING_TIER/);
  const next = service.create(input({ tierId: 'tier-1', pricingRevision: 2, amount: '21.25' }));
  assert.equal(next.durationMs, 99000); assert.equal(service.view(service.get(paid.id)).durationMs, 120000);
  await service.close(); const restarted = f.start();
  const checked = await signed(restarted, pending.id, '0x' + 'b'.repeat(64));
  assert.equal(checked.amount, '20'); assert.equal(checked.durationMs, 60000);
  assert.equal(checked.boardExpiresAt - checked.startsAt, 60000);
  assert.equal(restarted.get(paid.id).durationMs, 120000);
  assert.equal(restarted.get(confirming.id).state, 'confirming');
  const confirmed = await signed(restarted, confirming.id, '0x' + 'c'.repeat(64));
  assert.equal(confirmed.pricingRevision, 1); assert.equal(confirmed.durationMs, 300000);
  assert.equal(confirmed.boardExpiresAt - confirmed.startsAt, 300000);
  assert.equal(restarted.get(next.id).durationMs, 99000); assert.equal(restarted.publicConfig().pricing.revision, 2);
});

async function http(t, token = adminToken, trustProxy = false) {
  const path = directory(t), app = createApp(readConfig({ MODULE_C_ENABLED: '1', MODULE_C_ADMIN_TOKEN: token,
    MODULE_C_ETHEREUM_RECIPIENT: recipient, MODULE_C_DATA_FILE: join(path, 'orders.json'),
    DEMO_ACCESS_CODE: 'test-access', WORKER_TOKEN: 'test-worker', TRUST_PROXY: String(trustProxy) }), { moduleCOptions: { timers: false } });
  cleanupResources.get(t).push(app); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`, route = '/api/module-c/admin/pricing';
  const admin = { Authorization: `Bearer ${adminToken}` };
  const put = (body, headers = admin) => fetch(base + route, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, base, route, admin, put };
}

test('admin pricing uses its own bearer and cannot grant viewer/worker or review capabilities', async t => {
  const f = await http(t), body = { expectedRevision: 1, tiers: freshTiers() };
  const login = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'test-access' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const headers of [{}, { Authorization: 'Bearer test-worker' }, { Cookie: cookie },
    { Authorization: 'Bearer wrong', Cookie: cookie }]) {
    assert.equal((await fetch(f.base + f.route, { headers })).status, 401);
    assert.equal((await f.put(body, headers)).status, 401);
  }
  assert.equal((await fetch(f.base + '/api/module-c/review', { headers: f.admin })).status, 401);
  assert.equal((await fetch(f.base + '/api/module-c/review', { headers: {
    Authorization: 'Bearer test-worker', 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
  const resolve = await fetch(f.base + '/api/module-c/orders/' + 'a'.repeat(64) + '/resolve', {
    method: 'POST', headers: { ...f.admin, 'Content-Type': 'application/json' }, body: '{"action":"retry"}' });
  assert.equal(resolve.status, 401);
  assert.equal((await fetch(f.base + f.route, { headers: f.admin })).status, 200);
  assert.equal((await fetch(f.base + f.route, { headers: { ...f.admin, 'X-Forwarded-Proto': 'https' } })).status, 403);
  const publicBody = await (await fetch(f.base + '/api/module-c/config')).text();
  assert.equal(publicBody.includes(adminToken), false); assert.equal(publicBody.includes('test-worker'), false);
  assert.equal(publicBody.includes('pricingDataFile'), false);
});

test('admin PUT enforces exact schema, CAS, methods and durable public configuration', async t => {
  const f = await http(t), tiers = freshTiers(); tiers[0].price = '22'; tiers[0].durationSeconds = 45;
  for (const method of ['POST', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal((await fetch(f.base + f.route, { method, headers: f.admin })).status, 405);
  }
  for (const body of [{ revision: 1, tiers }, { expectedRevision: 1, tiers, extra: 1 },
    { expectedRevision: 1, tiers: tiers.slice(1) }]) assert.equal((await f.put(body)).status, 400);
  const responses = await Promise.all([f.put({ expectedRevision: 1, tiers }), f.put({ expectedRevision: 1, tiers })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const conflict = await responses.find(r => r.status === 409).json(); assert.equal(conflict.error, 'PRICING_REVISION_CONFLICT');
  const config = await (await fetch(f.base + '/api/module-c/config')).json();
  assert.equal(config.pricing.revision, 2); assert.equal(config.pricing.tiers[0].price, '22');
  assert.equal(config.secondsPer20, 45); assert.equal(config.minAmount, '22');
  assert.equal(JSON.parse(readFileSync(f.app.moduleC.pricing.path, 'utf8')).revision, 2);
});

test('without admin token management is disabled while authenticated checkout remains available', async t => {
  const f = await http(t, '');
  assert.equal((await fetch(f.base + f.route, { headers: f.admin })).status, 503);
  assert.equal((await f.put({ expectedRevision: 1, tiers: freshTiers() })).status, 503);
  const login = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'test-access' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await fetch(f.base + '/api/module-c/orders', { method: 'POST', headers: {
    Origin: f.base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input({ tierId: 'tier-1', pricingRevision: 1 })) });
  assert.equal(created.status, 201); assert.equal((await created.json()).durationMs, 30000);
});

test('admin routes accept only the configured loopback HTTPS proxy and retain review loopback rules', async t => {
  const f = await http(t, adminToken, true);
  const headers = { ...f.admin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.1' };
  assert.equal((await fetch(f.base + f.route, { headers })).status, 200);
  assert.equal((await fetch(f.base + f.route, { headers: { ...headers, 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await fetch(f.base + '/api/module-c/review', { headers: {
    ...headers, Authorization: 'Bearer test-worker' } })).status, 403);
});

test('fractional tier pricing creates exact listed amounts on all four stablecoin decimals', t => {
  const path = directory(t), config = readModuleCConfig({ MODULE_C_ENABLED: '1', MODULE_C_DATA_FILE: join(path, 'orders.json'),
    MODULE_C_ETHEREUM_RECIPIENT: recipient, MODULE_C_BSC_RECIPIENT: recipient,
    MODULE_C_SOLANA_RECIPIENT: 'AV5gwfXZ2624mHG6wyobuccFJdb9S2aAfRPtChcMrZDP',
    MODULE_C_TRON_RECIPIENT: 'TL61BfTThTutHu6cPEFFUPbq1ZPuBDmG22' });
  const service = new ModuleC(config, new Broker(), { timers: false }); cleanupResources.get(t).push(service);
  const tiers = freshTiers(); tiers[0].price = '0.01'; tiers[0].durationSeconds = 1;
  service.pricing.update({ expectedRevision: 1, tiers });
  for (const chain of ['solana', 'tron', 'ethereum', 'bsc']) {
    const order = service.create(input({ chain, tokenChain: 'ethereum', amount: '0.01', tierId: 'tier-1', pricingRevision: 2 }));
    const decimals = config.chains[chain].decimals, amount = parseUnits(order.payAmount, decimals);
    assert.equal(order.durationMs, 1000); assert.equal(amount, parseUnits('0.01', decimals));
    assert.equal(order.paymentMode, 'exact-wallet-v1');
    if (chain === 'bsc') assert.equal(amount % 1000000000000n, 0n);
  }
});
