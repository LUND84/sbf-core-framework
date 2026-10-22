import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

function box(type, body = '') {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, bytes]);
}
const init = Buffer.concat([box('ftyp', 'isom'), box('moov', 'test')]);
const fragment = (value) => Buffer.concat([box('moof', String(value)), box('mdat', 'sample')]);

async function fixture(t, extra = {}) {
  const app = createApp(readConfig({ WORKER_TOKEN: 'unit-test-worker-token-not-a-secret', ...extra }));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

async function connect(url, options) {
  const socket = new WebSocket(url, options);
  const messages = [];
  socket.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data)));
  await once(socket, 'open');
  return { socket, messages };
}

async function until(check, timeout = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for expected state');
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function readyWorker(f) {
  const worker = await connect(`${f.ws}/ws/worker`, { headers: { Authorization: 'Bearer unit-test-worker-token-not-a-secret' } });
  worker.socket.send(JSON.stringify({ type: 'worker.hello', engine: 'livetalking', mode: 'avatar', workerId: 'test' }));
  worker.socket.send(JSON.stringify({ type: 'stream.reset', epoch: 'stream-one', mime: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', width: 640, height: 360, fps: 25 }));
  worker.socket.send(init);
  worker.socket.send(fragment(1));
  await until(() => f.app.broker.status().stream.ready);
  return worker;
}

function post(f, path, body, headers = {}) {
  return fetch(f.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.base, ...headers }, body: JSON.stringify(body) });
}

test('GPU media, late viewers, queued chats and epoch changes preserve protocol order', async (t) => {
  const f = await fixture(t);
  const worker = await readyWorker(f);
  const viewer = await connect(`${f.ws}/ws/viewer`, { headers: { Origin: f.base } });
  await until(() => viewer.messages.filter(Buffer.isBuffer).length === 2);
  const resetIndex = viewer.messages.findIndex((m) => m.type === 'stream.reset');
  assert.deepEqual(viewer.messages[resetIndex + 1], init);
  assert.deepEqual(viewer.messages[resetIndex + 2], fragment(1));

  const first = await post(f, '/api/chat', { text: 'Hello Sam' });
  assert.equal(first.status, 202);
  const one = await first.json();
  const second = await (await post(f, '/api/chat', { text: 'Second question' })).json();
  await until(() => worker.messages.some((m) => m.type === 'chat.request'));
  assert.equal(worker.messages.filter((m) => m.type === 'chat.request').length, 1);
  worker.socket.send(JSON.stringify({ type: 'chat.event', id: 'wrong-id', role: 'assistant', text: 'wrong', status: 'done' }));
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(f.app.broker.current.id, one.id);
  worker.socket.send(JSON.stringify({ type: 'chat.event', id: one.id, role: 'assistant', text: 'Hello!', status: 'done' }));
  await until(() => worker.messages.filter((m) => m.type === 'chat.request').length === 2);
  assert.equal(f.app.broker.current.id, second.id);

  worker.socket.send(JSON.stringify({ type: 'stream.reset', epoch: 'stream-two', mime: 'video/mp4', width: 640, height: 360, fps: 25 }));
  await until(() => f.app.broker.stream.epoch === 'stream-two');
  assert.equal(f.app.broker.stream.ready, false);
  assert.equal(f.app.broker.init, null);
  worker.socket.close();
  await until(() => !f.app.broker.workerInfo.connected);
  assert.equal(f.app.broker.current, null);
  assert.equal(f.app.broker.pending.length, 0);
  assert.ok(f.app.broker.history.some((m) => m.id === second.id && m.status === 'error'));
});

test('viewer cookie and same-origin checks protect chat and worker uploads', async (t) => {
  const f = await fixture(t, { DEMO_ACCESS_CODE: 'unit-test-code' });
  assert.deepEqual(await (await fetch(f.base + '/api/auth')).json(), { authenticated: false, authRequired: true });
  assert.equal((await post(f, '/api/chat', { text: 'hello' })).status, 401);
  assert.equal((await post(f, '/api/login', { code: 'wrong' })).status, 401);
  assert.equal((await post(f, '/api/login', { code: 'unit-test-code' }, { Origin: 'https://outside.example' })).status, 403);
  const login = await post(f, '/api/login', { code: 'unit-test-code' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.deepEqual(await (await fetch(f.base + '/api/auth', { headers: { Cookie: cookie } })).json(),
    { authenticated: true, authRequired: true });
  assert.equal((await post(f, '/api/chat', { text: 'hello' }, { Cookie: cookie })).status, 503);
  const rejected = new WebSocket(`${f.ws}/ws/worker`);
  const error = await once(rejected, 'error');
  assert.match(error[0].message, /401/);
  const viewer = await connect(`${f.ws}/ws/viewer`, { headers: { Origin: f.base, Cookie: cookie } });
  assert.equal(viewer.socket.readyState, WebSocket.OPEN);
});

test('media error holds new chat until a fresh fragment arrives', async (t) => {
  const f = await fixture(t);
  const worker = await readyWorker(f);
  worker.socket.send(JSON.stringify({ type: 'worker.error', message: 'Media temporarily unavailable' }));
  await until(() => !f.app.broker.stream.ready);
  assert.equal(worker.socket.readyState, WebSocket.OPEN);
  assert.equal((await post(f, '/api/chat', { text: 'hello' })).status, 503);
  worker.socket.send(fragment(2));
  await until(() => f.app.broker.stream.ready);
  assert.equal((await post(f, '/api/chat', { text: 'hello' })).status, 202);
});

test('test-pattern mode cannot be mistaken for a working avatar', async (t) => {
  const f = await fixture(t);
  const worker = await readyWorker(f);
  worker.socket.send(JSON.stringify({ type: 'worker.hello', engine: 'test-pattern', mode: 'test-pattern' }));
  await until(() => f.app.broker.workerInfo.mode === 'test-pattern');
  assert.equal((await post(f, '/api/chat', { text: 'hello' })).status, 409);
});

test('interrupt clears pending chat and holds new requests until GPU acknowledgement', async (t) => {
  const f = await fixture(t);
  const worker = await readyWorker(f);
  await post(f, '/api/chat', { text: 'one' });
  await post(f, '/api/chat', { text: 'two' });
  assert.equal((await post(f, '/api/interrupt', {})).status, 200);
  assert.equal(f.app.broker.pending.length, 0);
  assert.equal(f.app.broker.current, null);
  assert.equal((await post(f, '/api/chat', { text: 'three' })).status, 409);
  worker.socket.send(JSON.stringify({ type: 'interrupt.ack' }));
  await until(() => !f.app.broker.interrupting);
  assert.equal((await post(f, '/api/chat', { text: 'four' })).status, 202);
});

test('malformed media closes a worker instead of poisoning new browser sessions', async (t) => {
  const f = await fixture(t);
  const worker = await connect(`${f.ws}/ws/worker`, { headers: { Authorization: 'Bearer unit-test-worker-token-not-a-secret' } });
  const closed = once(worker.socket, 'close');
  worker.socket.send(fragment('without-init'));
  const [code] = await closed;
  assert.equal(code, 1008);
});
