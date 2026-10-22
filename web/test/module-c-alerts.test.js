import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleC } from '../server/module-c/service.js';
import { PaymentStore } from '../server/module-c/store.js';
import { DEFAULT_TIERS } from '../server/module-c/pricing.js';
import { parseUnits, readModuleCConfig } from '../server/module-c/policies.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

const recipient = '0x1111111111111111111111111111111111111111';
const walletProof = { payer: recipient, signature: 'alerts-fixture-wallet-signature' };
const signed = (service, id, txHash) => service.verify(id, txHash, walletProof);
const verifyWallet = (order, txHash, proof) => {
  assert.deepEqual(proof, walletProof); return recipient;
};
const ca = '0x2222222222222222222222222222222222222222';
const durations = [4000, 5000, 6000, 7000, 8000, 10000, 12000];
const tx = n => '0x' + n.toString(16).padStart(64, '0');
const input = extra => ({ chain: 'ethereum', tokenChain: 'bsc', ca, amount: '20',
  name: 'Paid viewer', message: 'A distinct private order message', ...extra });
class Broker extends EventEmitter {
  constructor() { super(); this.accepted = []; this.ready = false; }
  submit(text, metadata) {
    if (!this.ready) throw Object.assign(new Error('offline'), { statusCode: 503 });
    this.accepted.push({ text, ...metadata }); return { id: metadata.id };
  }
}
function fixture(t, { verify, metadata = async () => ({}), storeFactory } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sbf-module-c-alerts-'));
  const dataFile = join(directory, 'orders.json');
  const config = readModuleCConfig({ MODULE_C_ENABLED: '1', MODULE_C_ETHEREUM_RECIPIENT: recipient, MODULE_C_DATA_FILE: dataFile });
  const broker = new Broker(), resources = [];
  let at = 1792500000000, verifications = 0;
  const defaultVerify = async o => { verifications++; return {
    state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient }; };
  const start = (store, nextBroker = broker) => {
    const service = new ModuleC(config, nextBroker, { now: () => at, timers: false,
      store, verifyWallet, marketContext: async (chain, ca) => ({ chain, ca, status: 'unavailable' }), verify: verify || defaultVerify, metadata });
    resources.push(service); return service;
  };
  const service = start(storeFactory?.(dataFile));
  t.after(async () => {
    try { for (const resource of resources) await resource.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { service, broker, config, dataFile, directory, start, get at() { return at; },
    get verifications() { return verifications; }, advance(ms) { at += ms; } };
}
const snapshot = order => structuredClone(order.alert);
const unavailable = error => error.statusCode === 503 && error.message === 'MODULE_C_STORE_UNAVAILABLE';

test('only confirmed funds atomically commit a paid order, placement rights and its immutable alert', async t => {
  let confirmed = false;
  const f = fixture(t, { verify: async o => confirmed ? {
    state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient } : { state: 'pending' } });
  const order = f.service.create(input());
  assert.deepEqual(f.service.board().alerts, []);
  await signed(f.service, order.id, tx(1));
  assert.equal(f.service.get(order.id).state, 'confirming'); assert.deepEqual(f.service.board().alerts, []);
  const committed = [], put = f.service.store.put.bind(f.service.store);
  f.service.store.put = value => { committed.push(structuredClone(value)); return put(value); };
  confirmed = true; await signed(f.service, order.id, tx(1));
  const paidCommit = committed.find(o => o.state === 'paid');
  assert.deepEqual(paidCommit.alert, { version: 1, tierIndex: 1, startsAt: f.at + 1500, expiresAt: f.at + 5500 });
  assert.equal(paidCommit.boardExpiresAt - paidCommit.startsAt, 30000);
  const diskOrder = JSON.parse(readFileSync(f.dataFile, 'utf8')).orders[0];
  assert.equal(diskOrder.state, 'paid'); assert.deepEqual(diskOrder.alert, paidCommit.alert);
  assert.equal(f.service.board().alerts[0].id, order.id.slice(0, 16));
});

test('all seven immutable order tiers choose fixed alert durations independent of configured prices', async t => {
  const f = fixture(t), tiers = structuredClone(DEFAULT_TIERS);
  tiers.forEach((tier, i) => { tier.price = `0.0${i + 1}`; tier.durationSeconds = 1; });
  f.service.pricing.update({ expectedRevision: 1, tiers });
  let startsAt = f.at + 1500;
  for (let i = 0; i < 7; i++) {
    const order = f.service.create(input({ amount: tiers[i].price, tierId: tiers[i].id, pricingRevision: 2 }));
    await signed(f.service, order.id, tx(i + 1));
    assert.deepEqual(f.service.get(order.id).alert,
      { version: 1, tierIndex: i + 1, startsAt, expiresAt: startsAt + durations[i] });
    startsAt += durations[i];
  }
  f.advance(2000);
  assert.equal(f.service.board().entries.length, 1);
  assert.ok(f.service.board().alerts.length > 0);
  assert.equal(f.service.get(f.service.store.all()[0].id).boardExpiresAt < f.at, true);
  assert.equal(f.service.board().alerts[0].tierIndex, 1);
});

test('legacy unpaid orders use fixed historical thresholds while historical paid orders never gain alerts', async t => {
  const f = fixture(t);
  for (const [i, amount] of ['20', '49.99', '50', '100', '200', '500', '1000', '10000', '100000'].entries()) {
    const created = f.service.create(input()), old = f.service.get(created.id);
    delete old.tierId; delete old.pricingRevision; delete old.paymentMode;
    Object.assign(old, { amount, amountAtomic: String(parseUnits(amount, 6) + 1n), payAmount: amount, durationMs: 60000 });
    f.service.store.put(old); await signed(f.service, old.id, tx(i + 1));
    assert.equal(f.service.get(old.id).alert.tierIndex, [1, 1, 2, 3, 4, 5, 6, 7, 7][i]);
  }
  const historical = f.service.create(input()), old = f.service.get(historical.id);
  Object.assign(old, { state: 'paid', interactionState: 'done', startsAt: f.at, boardExpiresAt: f.at + 60000 });
  delete old.tierId; delete old.alert; f.service.store.put(old);
  const before = readFileSync(f.dataFile, 'utf8');
  await signed(f.service, old.id, tx(100));
  assert.equal(f.service.get(old.id).alert, undefined);
  assert.equal(readFileSync(f.dataFile, 'utf8'), before);
  assert.equal(f.service.board().alerts.some(a => a.id === old.id.slice(0, 16)), false);
});

test('concurrent confirmations serialize alerts by durable completion rather than creation or board slots', async t => {
  const releases = new Map();
  const f = fixture(t, { verify: o => new Promise(resolve => releases.set(o.id, () => resolve({
    state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient }))) });
  const orders = [f.service.create(input()), f.service.create(input({ amount: '50' })),
    f.service.create(input({ amount: '100' })), f.service.create(input())];
  const checks = orders.map((order, i) => signed(f.service, order.id, tx(i + 1)));
  await new Promise(resolve => setImmediate(resolve));
  const completion = [2, 0, 3, 1];
  let tail = f.at + 1500;
  for (const index of completion) {
    releases.get(orders[index].id)(); await checks[index];
    const actual = f.service.get(orders[index].id), tier = [1, 2, 3, 1][index];
    assert.equal(actual.alert.startsAt, tail); tail += durations[tier - 1];
    assert.equal(actual.alert.expiresAt, tail);
  }
  assert.deepEqual(f.service.board().alerts.map(a => a.id), completion.map(i => orders[i].id.slice(0, 16)));
  const fourth = f.service.get(orders[1].id);
  assert.equal(fourth.startsAt, f.at + 30000);
  assert.ok(fourth.alert.startsAt < fourth.startsAt);
});

test('polling publishes at most eight unexpired events in the next thirty seconds without mutating them', async t => {
  const f = fixture(t), orders = [];
  for (let i = 0; i < 10; i++) {
    const order = f.service.create(input()); orders.push(order);
    await signed(f.service, order.id, tx(i + 1));
  }
  let board = f.service.board();
  assert.equal(board.alerts.length, 8);
  assert.ok(board.alerts.every(a => a.startsAt <= f.at + 30000));
  f.advance(5499); board = f.service.board();
  assert.equal(board.alerts.length, 8); assert.equal(board.alerts[0].id, orders[0].id.slice(0, 16));
  const saved = snapshot(f.service.get(orders[0].id));
  board.alerts[0].tierIndex = 7; board.alerts[0].expiresAt += 100000;
  assert.deepEqual(snapshot(f.service.get(orders[0].id)), saved);
  f.advance(1); assert.equal(f.service.board().alerts[0].id, orders[1].id.slice(0, 16));
  f.advance(100000); assert.deepEqual(f.service.board().alerts, []);
  await signed(f.service, orders[0].id, tx(1)); assert.deepEqual(f.service.board().alerts, []);
});

test('reverify, review retry, metadata refresh and admin repricing preserve the same alert window', async t => {
  let resolveMetadata;
  const f = fixture(t, { metadata: () => new Promise(resolve => { resolveMetadata = resolve; }) });
  const order = f.service.create(input()); await signed(f.service, order.id, tx(1));
  const saved = snapshot(f.service.get(order.id));
  f.advance(1000); await signed(f.service, order.id, tx(2));
  f.broker.emit('chat', { id: f.service.requestId(f.service.get(order.id)), status: 'error' });
  f.service.resolve(order.id, 'retry');
  const tiers = structuredClone(DEFAULT_TIERS); tiers[0].price = '21'; tiers[0].durationSeconds = 67;
  f.service.pricing.update({ expectedRevision: 1, tiers });
  resolveMetadata({ logo: 'https://logo.invalid/logo.png', symbol: 'EXAMPLE' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshot(f.service.get(order.id)), saved);
  const event = f.service.board().alerts[0];
  assert.equal(event.logoUrl, `/api/module-c/logo/${order.id.slice(0, 16)}`); assert.equal(event.symbol, 'EXAMPLE');
  assert.equal(f.verifications, 1); assert.equal(event.amount, '20'); assert.equal(event.tierIndex, 1);
});

test('restart preserves active windows and expired events stay expired without migration of old paid records', async t => {
  const f = fixture(t), order = f.service.create(input());
  await signed(f.service, order.id, tx(1)); const saved = snapshot(f.service.get(order.id));
  await f.service.close(); const next = f.start(undefined, new Broker());
  assert.deepEqual(snapshot(next.get(order.id)), saved);
  await signed(next, order.id, tx(1)); assert.deepEqual(snapshot(next.get(order.id)), saved);
  assert.equal(f.verifications, 1);
  f.advance(6000); assert.deepEqual(next.board().alerts, []);
  await next.close(); const last = f.start(undefined, new Broker());
  assert.deepEqual(last.board().alerts, []); assert.deepEqual(snapshot(last.get(order.id)), saved);
});

test('untrusted checkout fields and payment-proof alert data cannot select an alert grade or time', async t => {
  const f = fixture(t, { verify: async o => ({ state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt,
    payer: recipient, alert: { version: 1, tierIndex: 7, startsAt: 0, expiresAt: 9999999999999 } }) });
  for (const extra of [{ alert: { tierIndex: 7 } }, { tierIndex: 7 }, { alertStartsAt: 0 }, { alertDurationMs: 999999 }]) {
    assert.throws(() => f.service.create(input(extra)), /INVALID_ORDER/);
  }
  assert.throws(() => f.service.create(input({ tierId: 'tier-7', pricingRevision: 1 })), /ORDER_PRICE_MISMATCH/);
  const order = f.service.create(input()); await signed(f.service, order.id, tx(1));
  assert.deepEqual(snapshot(f.service.get(order.id)),
    { version: 1, tierIndex: 1, startsAt: f.at + 1500, expiresAt: f.at + 5500 });
});

test('invalid immutable tier snapshots and legacy amounts below every threshold fail without paid admission', async t => {
  const f = fixture(t);
  for (const tierId of ['tier-8', 'tier-01', null]) {
    const order = f.service.create(input()), invalid = f.service.get(order.id);
    invalid.tierId = tierId; f.service.store.put(invalid);
    await assert.rejects(signed(f.service, order.id, tx(1)), error =>
      error.statusCode === 503 && error.message === 'INVALID_ORDER_TIER_SNAPSHOT');
    assert.equal(f.service.get(order.id).state, 'confirming'); assert.deepEqual(f.service.board().alerts, []);
  }
  const order = f.service.create(input()), invalid = f.service.get(order.id);
  delete invalid.tierId; invalid.amount = '19.99'; f.service.store.put(invalid);
  await assert.rejects(signed(f.service, order.id, tx(2)), /INVALID_ORDER_TIER_SNAPSHOT/);
  assert.equal(f.service.get(order.id).alert, undefined); assert.deepEqual(f.service.board().alerts, []);
});

test('failure before paid persistence publishes no alert and does not reserve an invisible schedule', async t => {
  const f = fixture(t), order = f.service.create(input()), put = f.service.store.put.bind(f.service.store);
  f.service.store.put = value => {
    if (value.state === 'paid') { assert.deepEqual(f.service.board().alerts, []); throw new Error('injected-before-write'); }
    return put(value);
  };
  await assert.rejects(signed(f.service, order.id, tx(1)), /injected-before-write/);
  assert.equal(f.service.get(order.id).state, 'confirming'); assert.deepEqual(f.service.board().alerts, []);
  assert.equal(JSON.parse(readFileSync(f.dataFile, 'utf8')).orders[0].alert, undefined);
  f.service.store.put = put; await signed(f.service, order.id, tx(1));
  assert.equal(f.service.get(order.id).alert.startsAt, f.at + 1500);
});

test('real rename followed by directory-fsync failure fails closed and restart honors the already saved alert', async t => {
  let failDirectory = false;
  const f = fixture(t, { storeFactory: path => new PaymentStore(path, { fsyncDirectory: () => {
    if (failDirectory) throw new Error('injected-directory-fsync');
  } }) });
  const order = f.service.create(input()), put = f.service.store.put.bind(f.service.store);
  f.service.store.put = value => { if (value.state === 'paid') failDirectory = true; return put(value); };
  await assert.rejects(signed(f.service, order.id, tx(1)), unavailable);
  const bytes = readFileSync(f.dataFile, 'utf8'), diskOrder = JSON.parse(bytes).orders[0];
  assert.equal(diskOrder.state, 'paid'); assert.equal(diskOrder.alert.tierIndex, 1);
  for (const action of [() => f.service.store.all(), () => f.service.store.get(order.id),
    () => f.service.store.put({ ...diskOrder, state: 'awaiting_payment' }), () => f.service.board()]) assert.throws(action, unavailable);
  assert.doesNotThrow(() => { f.service.drain(); f.service.tick(); f.service.onChat({ id: 'irrelevant', status: 'done' }); });
  assert.equal(f.broker.accepted.length, 0); assert.equal(readFileSync(f.dataFile, 'utf8'), bytes);
  await f.service.close(); assert.equal(existsSync(f.dataFile + '.lock'), false);
  const next = f.start(undefined, new Broker());
  assert.equal(next.get(order.id).state, 'paid'); assert.deepEqual(snapshot(next.get(order.id)), diskOrder.alert);
  await signed(next, order.id, tx(1)); assert.equal(f.verifications, 1);
  assert.deepEqual(snapshot(next.get(order.id)), diskOrder.alert);
});

test('pre-rename write failure leaves the writer usable and preserves the old ledger', t => {
  const f = fixture(t), store = f.service.store, before = readFileSync(f.dataFile, 'utf8');
  const blocked = join(f.directory, 'blocked'); mkdirSync(blocked); store.path = blocked;
  assert.throws(() => store.put({ id: 'a'.repeat(64), state: 'awaiting_payment' }));
  assert.equal(store.unavailable, false); assert.deepEqual(store.all(), []);
  assert.equal(readFileSync(f.dataFile, 'utf8'), before);
  store.path = f.dataFile;
  assert.equal(f.service.create(input()).state, 'awaiting_payment');
});

test('public board HTTP adds only the alert whitelist and polling never exposes private capabilities', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sbf-module-c-alert-http-'));
  const app = createApp(readConfig({ MODULE_C_ENABLED: '1', MODULE_C_ETHEREUM_RECIPIENT: recipient,
    MODULE_C_DATA_FILE: join(directory, 'orders.json'), DEMO_ACCESS_CODE: 'private-code', WORKER_TOKEN: 'private-worker' }),
  { moduleCOptions: { timers: false, verifyWallet, marketContext: async (chain, ca) => ({ chain, ca, status: 'unavailable' }), metadata: async () => ({}), verify: async o => ({
    state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient }) } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const order = app.moduleC.create(input()); await signed(app.moduleC, order.id, tx(1));
  await new Promise(resolve => setImmediate(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, bytes = readFileSync(app.moduleC.store.path, 'utf8');
  const board = await (await fetch(base + '/api/module-c/board')).json();
  assert.deepEqual(Object.keys(board).sort(), ['alerts', 'entries', 'serverTime']);
  const event = board.alerts[0];
  assert.deepEqual(Object.keys(event).sort(), ['amount', 'ca', 'chain', 'expiresAt', 'id', 'logoUrl', 'name', 'startsAt', 'tierIndex', 'tokenChain', 'version']);
  assert.equal(event.id, order.id.slice(0, 16)); assert.equal(event.id.length, 16);
  const raw = JSON.stringify(board.alerts);
  assert.equal(raw.includes(order.id), false); assert.equal(raw.includes(tx(1)), false);
  for (const key of ['payer', 'recipient', 'amountAtomic', 'message', 'deliveryAttempt', 'paidAt', 'pricingRevision']) {
    assert.equal(Object.hasOwn(event, key), false);
  }
  await fetch(base + '/api/module-c/board');
  assert.equal(readFileSync(app.moduleC.store.path, 'utf8'), bytes);
});
