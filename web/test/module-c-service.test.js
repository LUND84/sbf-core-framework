import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ModuleC } from '../server/module-c/service.js';
import { PaymentStore } from '../server/module-c/store.js';
import { readModuleCConfig, parseUnits, formatUnits } from '../server/module-c/policies.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { moduleCClientIp } from '../server/module-c/routes.js';

const recipient = '0x1111111111111111111111111111111111111111';
const ca = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const walletProof = { payer: recipient, signature: 'service-fixture-wallet-signature' };
const signed = (service, id, txHash) => service.verify(id, txHash, walletProof);
const verifyWallet = (order, txHash, proof) => {
  assert.deepEqual(proof, walletProof); return recipient;
};
const input = extra => ({ chain: 'ethereum', tokenChain: 'bsc', ca, amount: '20', message: 'Tell us about this token', ...extra });
test('payment rate limit trusts only an explicitly configured local reverse proxy', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.2' } };
  assert.equal(moduleCClientIp(request, true), '203.0.113.2');
  assert.equal(moduleCClientIp(request, false), '127.0.0.1');
  assert.equal(moduleCClientIp({ ...request, socket: { remoteAddress: '203.0.113.9' } }, true), '203.0.113.9');
});
class Broker extends EventEmitter {
  constructor() { super(); this.accepted = []; this.ready = false; this.pending = []; this.history = []; }
  submit(text, metadata) {
    if (!this.ready) throw Object.assign(new Error('offline'), { statusCode: 503 });
    this.accepted.push({ text, ...metadata }); this.pending.push(metadata);
    this.emit('chat', { ...metadata, status: 'queued', role: 'user' });
    return { id: metadata.id, position: 1 };
  }
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sbf-module-c-'));
  const dataFile = join(directory, 'orders.json');
  const config = readModuleCConfig({ MODULE_C_ENABLED: '1', MODULE_C_ETHEREUM_RECIPIENT: recipient, MODULE_C_DATA_FILE: dataFile });
  let at = 1792400000000, attempts = 0;
  const broker = new Broker();
  const service = new ModuleC(config, broker, { now: () => at, timers: false,
    verifyWallet,
    marketContext: async (chain, ca) => ({ chain, ca, status: 'unavailable' }), metadata: async () => ({}), verify: async order => {
      attempts++; return { state: 'confirmed', amountAtomic: order.amountAtomic, paidAt: at, payer: recipient, txHash: hash };
    }, ...options });
  const resources = [service];
  t.after(async () => { for (const resource of resources) await resource.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, resources, config, broker, directory, dataFile, get at() { return at; }, get attempts() { return attempts; }, advance(ms) { at += ms; } };
}

test('order creation enforces configured tier prices, CA chain and trusted-only metadata', async t => {
  const f = fixture(t);
  assert.throws(() => f.service.create(input({ amount: '19.99' })), /AMOUNT_MUST_MATCH_PRICING_TIER/);
  assert.throws(() => f.service.create(input({ amount: '20.001' })), /PRECISION/);
  assert.throws(() => f.service.create(input({ source: 'paid-message' })), /INVALID_ORDER/);
  assert.throws(() => f.service.create(input({ tokenChain: 'solana' })), /INVALID_ADDRESS/);
  assert.throws(() => f.service.create(input({ chain: 'tron' })), /UNAVAILABLE/);
  const one = f.service.create(input()), two = f.service.create(input());
  assert.notEqual(one.id, two.id); assert.equal(one.payAmount, two.payAmount);
  assert.equal(parseUnits(one.payAmount, 6), 20000000n);
  assert.equal(one.state, 'awaiting_payment');
  assert.equal(one.tokenChain, 'bsc'); assert.equal(one.ca, ca);
  assert.equal(one.id.length, 64); assert.equal(f.service.board().entries.length, 0);
  assert.equal(formatUnits(parseUnits('12345.000001', 18), 18), '12345.000001');
});

test('only confirmed funds enter the board and durable FIFO outbox; expired board does not drop response', async t => {
  const f = fixture(t), one = f.service.create(input()), two = f.service.create(input({ amount: '50' }));
  await signed(f.service, one.id, hash);
  f.advance(1000); await signed(f.service, two.id, '0x' + 'b'.repeat(64));
  assert.equal(f.broker.accepted.length, 0);
  assert.equal(f.service.get(one.id).interactionState, 'waiting');
  const board = f.service.board();
  assert.deepEqual(board.entries.map(o => o.amount), ['50', '20']);
  assert.equal(board.entries[1].expiresAt - board.entries[1].startsAt, 30000);
  assert.equal(board.entries[0].expiresAt - board.entries[0].startsAt, 120000);
  assert.equal(board.entries[1].ca, ca);
  assert.notEqual(board.entries[1].id, one.id);
  f.advance(60001); assert.equal(f.service.board().entries.length, 1);
  f.broker.ready = true; f.service.drain();
  assert.equal(f.broker.accepted.length, 2);
  assert.equal(f.broker.accepted[0].source, 'paid-message');
  assert.match(f.broker.accepted[0].text, new RegExp(ca));
  assert.equal(f.service.get(one.id).interactionState, 'queued');
  await signed(f.service, one.id, hash); f.service.drain();
  assert.equal(f.broker.accepted.length, 2); assert.equal(f.attempts, 2);
  f.broker.emit('chat', { id: f.broker.accepted[0].id, status: 'done', role: 'assistant' });
  assert.equal(f.service.get(one.id).interactionState, 'done');
});

test('transaction binding persists pending confirmations, retries canonical EVM hash and rejects replay', async t => {
  let count = 0, captured;
  const f = fixture(t, { verify: async (order, txHash) => {
    captured = txHash;
    return ++count === 1 ? { state: 'pending' } : { state: 'confirmed', amountAtomic: order.amountAtomic,
      paidAt: order.createdAt, payer: recipient };
  } });
  const order = f.service.create(input());
  await signed(f.service, order.id, hash.toUpperCase().replace('0X', '0x'));
  assert.equal(f.service.get(order.id).state, 'confirming');
  assert.equal(f.service.board().entries.length, 0);
  f.service.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(captured, hash); assert.equal(f.service.get(order.id).state, 'paid');
  const second = f.service.create(input());
  await assert.rejects(signed(f.service, second.id, hash), /TRANSACTION_ALREADY_USED/);
});

test('concurrent checks call the verifier once; a wrong hash can be corrected', async t => {
  let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { verify: async order => { count++; await gate;
    return { state: 'confirmed', amountAtomic: order.amountAtomic, paidAt: order.createdAt, payer: recipient }; } });
  const order = f.service.create(input());
  const first = signed(f.service, order.id, hash), second = signed(f.service, order.id, hash);
  release(); await Promise.all([first, second]); assert.equal(count, 1);
  f.service.verifyPayment = async () => { throw Object.assign(new Error('PAYMENT_INVALID_TX_HASH'), { statusCode: 400 }); };
  const other = f.service.create(input());
  await assert.rejects(signed(f.service, other.id, 'wrong'), /INVALID_TX_HASH/);
  assert.equal(f.service.get(other.id).state, 'awaiting_payment'); assert.equal(f.service.get(other.id).txHash, undefined);
});

test('restart preserves payments and exposes uncertain dispatched work for deliberate recovery', async t => {
  const f = fixture(t); f.broker.ready = true;
  const one = f.service.create(input()); await signed(f.service, one.id, hash); await f.service.close();
  const nextBroker = new Broker();
  const next = new ModuleC(f.config, nextBroker, { now: () => f.at, timers: false }); f.resources.push(next);
  assert.equal(next.get(one.id).state, 'paid'); assert.equal(next.get(one.id).interactionState, 'needs_review');
  assert.equal(next.review().length, 1); next.drain(); assert.equal(nextBroker.accepted.length, 0);
  nextBroker.ready = true; next.resolve(one.id, 'retry'); assert.equal(nextBroker.accepted.length, 1);
  assert.notEqual(nextBroker.accepted[0].id, f.broker.accepted[0].id);
  nextBroker.emit('chat', { id: f.broker.accepted[0].id, status: 'error' });
  assert.equal(next.get(one.id).interactionState, 'queued');
  nextBroker.emit('chat', { id: nextBroker.accepted[0].id, status: 'done' });
  assert.equal(next.get(one.id).interactionState, 'done');
  assert.throws(() => next.resolve(one.id, 'retry'), /ORDER_NOT_IN_REVIEW/);
});

test('uncertain submit exception never causes automatic duplicate paid delivery', async t => {
  const f = fixture(t); let count = 0;
  f.broker.submit = () => { count++; throw new Error('accepted then observer failed'); };
  const one = f.service.create(input()); await signed(f.service, one.id, hash);
  assert.equal(f.service.get(one.id).interactionState, 'needs_review');
  f.service.drain(); assert.equal(count, 1);
});

test('automatic confirmation rotates past eight stuck transactions', async t => {
  const checked = [];
  const f = fixture(t, { verify: async (o, h) => { checked.push(h); return { state: 'pending' }; } });
  for (let i = 0; i < 10; i++) {
    const o = f.service.create(input()); await signed(f.service, o.id, '0x' + String(i).padStart(64, '0'));
  }
  checked.length = 0; f.service.tick(); await new Promise(resolve => setImmediate(resolve));
  f.advance(5000); f.service.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(new Set(checked).size, 10);
});

test('single writer lock rejects concurrent owner and safely recovers a terminated process', async t => {
  const f = fixture(t);
  assert.throws(() => new PaymentStore(f.dataFile), /STORE_LOCKED/);
  await f.service.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {PaymentStore} from ${JSON.stringify(new URL('../server/module-c/store.js', import.meta.url).href)}; new PaymentStore(process.argv[1]);` , f.dataFile], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(existsSync(f.dataFile + '.lock'), true);
  const recovered = new PaymentStore(f.dataFile); recovered.close();
  assert.equal(existsSync(f.dataFile + '.lock'), false);
  writeFileSync(f.dataFile, '{invalid');
  assert.throws(() => new PaymentStore(f.dataFile), /STORE_INVALID/);
  assert.equal(readFileSync(f.dataFile, 'utf8'), '{invalid');
});

test('closed service and store cannot overwrite a successor owner or create new payments', async t => {
  const f = fixture(t), originalOrder = f.service.create(input()); await f.service.close();
  const successor = new ModuleC(f.config, new Broker(), { timers: false }); f.resources.push(successor);
  const newOrder = successor.create(input());
  assert.throws(() => f.service.create(input()), /MODULE_C_CLOSED/);
  assert.throws(() => f.service.resolve(originalOrder.id, 'retry'), /MODULE_C_CLOSED/);
  await assert.rejects(signed(f.service, originalOrder.id, hash), /MODULE_C_CLOSED/);
  assert.throws(() => f.service.store.put({ id: 'f'.repeat(64) }), /STORE_CLOSED/);
  assert.equal(JSON.parse(readFileSync(f.dataFile, 'utf8')).orders.some(o => o.id === newOrder.id), true);
});

test('payment made inside its window can be reported after the order expires', async t => {
  const f = fixture(t, { verify: async o => ({ state: 'confirmed', amountAtomic: o.amountAtomic,
    paidAt: o.expiresAt - 1000, payer: recipient }) });
  const order = f.service.create(input()); f.advance(f.config.orderTtlMs + 1000);
  assert.equal(f.service.get(order.id).state, 'expired');
  const result = await signed(f.service, order.id, hash);
  assert.equal(result.state, 'paid'); assert.equal(f.service.board().entries.length, 1);
});

test('pending hash on a wrong order cannot steal or permanently reserve the rightful payment', async t => {
  let rightful;
  const f = fixture(t, { verify: async o => o.id !== rightful ? { state: 'pending' }
    : { state: 'confirmed', amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient } });
  const wrong = f.service.create(input()), right = f.service.create(input()); rightful = right.id;
  await signed(f.service, wrong.id, hash);
  assert.equal((await signed(f.service, right.id, hash)).state, 'paid');
  await assert.rejects(signed(f.service, wrong.id, hash), /TRANSACTION_ALREADY_USED/);
  assert.equal(f.service.get(wrong.id).txHash, undefined);
  const another = f.service.create(input()); await signed(f.service, another.id, '0x' + 'b'.repeat(64));
  f.service.verifyPayment = async () => { throw Object.assign(new Error('PAYMENT_AMOUNT_MISMATCH'), { statusCode: 400 }); };
  await assert.rejects(signed(f.service, another.id, '0x' + 'b'.repeat(64)), /AMOUNT_MISMATCH/);
  assert.equal(f.service.get(another.id).txHash, undefined);
  assert.equal(f.service.get(another.id).state, 'awaiting_payment');
});

test('three display slots defer busy placements without consuming their purchased tier duration', async t => {
  const f = fixture(t), orders = [];
  for (let i = 0; i < 4; i++) {
    const order = f.service.create(input());
    orders.push(await signed(f.service, order.id, '0x' + String(i).padStart(64, '0')));
  }
  assert.equal(f.service.board().entries.length, 3);
  assert.equal(orders[3].startsAt, f.at + 30000);
  assert.equal(orders[3].boardExpiresAt - orders[3].startsAt, 30000);
  f.advance(30000); assert.equal(f.service.board().entries.length, 1);
  assert.equal(f.service.board().entries[0].id, orders[3].id.slice(0, 16));
});

test('HTTP payment API enforces origin, viewer and operator permissions; public board never leaks order capability', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sbf-module-c-http-'));
  const app = createApp(readConfig({ MODULE_C_ENABLED: '1', MODULE_C_ETHEREUM_RECIPIENT: recipient,
    MODULE_C_DATA_FILE: join(directory, 'orders.json'), DEMO_ACCESS_CODE: 'test-access', WORKER_TOKEN: 'test-worker' }),
  { moduleCOptions: { timers: false, verifyWallet, marketContext: async (chain, ca) => ({ chain, ca, status: 'unavailable' }), metadata: async () => ({}), verify: async o => ({ state: 'confirmed',
    amountAtomic: o.amountAtomic, paidAt: o.createdAt, payer: recipient }) } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/module-c/orders', input())).status, 401);
  const login = await post('/api/login', { code: 'test-access' }), cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/module-c/orders', input(), { Cookie: cookie, Origin: 'https://evil.invalid' })).status, 403);
  const created = await post('/api/module-c/orders', input(), { Cookie: cookie }); assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal((await fetch(base + '/api/module-c/orders/' + order.id)).status, 401);
  assert.equal((await post(`/api/module-c/orders/${order.id}/verify`, { txHash: hash, walletProof }, { Cookie: cookie })).status, 200);
  const board = await (await fetch(base + '/api/module-c/board')).json();
  assert.equal(board.entries.length, 1); assert.equal(board.entries[0].id.length, 16);
  assert.equal(JSON.stringify(board).includes(order.id), false);
  assert.equal((await fetch(base + '/api/module-c/review', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(base + '/api/module-c/review', { headers: { Authorization: 'Bearer test-worker' } })).status, 200);
  assert.equal((await fetch(base + '/api/module-c/review', { headers: { Authorization: 'Bearer test-worker', 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
  assert.equal((await post('/api/interrupt', {}, { Cookie: cookie })).status, 403);
});
