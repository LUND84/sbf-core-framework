import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { get } from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';
import { Fmp4ChunkAssembler } from '../public/fmp4-chunks.js';

function box(type, body = '') {
  const payload = Buffer.from(body), header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
}
const init = Buffer.concat([box('ftyp', 'isom'), box('moov', 'init')]);
const media = (index, size = 1000) => Buffer.concat([box('moof', `frame${index}`), box('mdat', Buffer.alloc(size, index))]);

async function until(check) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error('Local HTTP media fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, overrides = {}) {
  const app = createApp({ ...readConfig({ WORKER_TOKEN: 'http-fixture-worker-token' }), ...overrides });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const worker = new WebSocket(base.replace('http:', 'ws:') + '/ws/worker',
    { headers: { Authorization: 'Bearer http-fixture-worker-token' } });
  await once(worker, 'open');
  const reset = epoch => worker.send(JSON.stringify({ type: 'stream.reset', epoch, mime: 'video/mp4' }));
  reset('first'); worker.send(init); worker.send(media(1));
  await until(() => app.broker.stream.ready);
  return { app, base, worker, reset };
}

function stream(base, cookie = '') {
  return new Promise((resolve, reject) => {
    const request = get(base + '/api/media', { agent: false, headers: cookie ? { Cookie: cookie } : {} }, response => {
      const chunks = [], errors = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', error => errors.push(error.code));
      resolve({ request, response, chunks, errors, bytes: () => Buffer.concat(chunks) });
    });
    request.on('error', reject);
  });
}

test('authenticated HTTP receives full init/cache/live bytes only and ends on epoch reset', async t => {
  const f = await fixture(t, { accessCode: 'fixture-access-code' });
  const login = await fetch(f.base + '/api/login', { method: 'POST', headers:
    { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'fixture-access-code' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0]; await login.text();
  const h = await stream(f.base, cookie);
  assert.equal(h.response.statusCode, 200);
  assert.equal(h.response.headers['content-type'], 'video/mp4');
  assert.equal(h.response.headers['cache-control'], 'no-store');
  assert.equal(h.response.headers['x-sbf-epoch'], 'first');
  const prefix = Buffer.concat([init, media(1)]);
  await until(() => h.bytes().length === prefix.length);
  assert.deepEqual(h.bytes(), prefix, 'Cached media arrives before new worker data');
  f.app.broker.chatEvent({ role: 'system', text: 'LOCAL_CONTROL_MUST_NOT_ENTER_MEDIA', status: 'queued' });
  f.worker.send(media(2, 50000));
  const expected = [init, media(1), media(2, 50000)], bytes = Buffer.concat(expected);
  await until(() => h.bytes().length === bytes.length);
  assert.deepEqual(h.bytes(), bytes);
  const assembler = new Fmp4ChunkAssembler();
  assert.deepEqual(h.chunks.flatMap(chunk => assembler.push(chunk).map(value => Buffer.from(value))), expected);
  const ended = once(h.response, 'end'); f.reset('second'); await ended;
  assert.equal(f.app.broker.httpViewers.size, 0);
  assert.deepEqual(h.bytes(), bytes, 'New epoch metadata/init cannot enter the old response');
  f.worker.send(init); f.worker.send(media(3));
  await until(() => f.app.broker.stream.ready);
  const second = await stream(f.base, cookie);
  assert.equal(second.response.headers['x-sbf-epoch'], 'second');
  await until(() => second.bytes().length === init.length + media(3).length);
  assert.deepEqual(second.bytes(), Buffer.concat([init, media(3)]));
  second.response.destroy(); second.request.destroy();
});

test('missing or invalid viewer cookie is rejected and not admitted to HTTP media', async t => {
  const f = await fixture(t, { accessCode: 'fixture-access-code' });
  for (const cookie of ['', 'sbf_demo=invalid']) {
    const h = await stream(f.base, cookie);
    assert.equal(h.response.statusCode, 401);
    await until(() => h.response.complete);
    assert.equal(f.app.broker.httpViewers.size, 0);
    assert.equal(h.response.headers['x-sbf-epoch'], undefined);
  }
});

test('worker disconnect ends HTTP media and client close removes its viewer membership', async t => {
  const f = await fixture(t), h = await stream(f.base);
  await until(() => h.bytes().length > 0);
  assert.equal(f.app.broker.status().viewers, 1);
  h.response.destroy(); h.request.destroy();
  await until(() => f.app.broker.httpViewers.size === 0);
  const next = await stream(f.base);
  const ended = once(next.response, 'end'); f.worker.close(); await ended;
  assert.equal(f.app.broker.httpViewers.size, 0);
  const unavailable = await stream(f.base);
  assert.equal(unavailable.response.statusCode, 503);
});

test('HTTP and WebSocket viewers share one capacity budget in both directions', async t => {
  const f = await fixture(t, { maxViewers: 1 }), h = await stream(f.base);
  const deniedHttp = await stream(f.base); assert.equal(deniedHttp.response.statusCode, 503);
  const wsUrl = f.base.replace('http:', 'ws:') + '/ws/viewer';
  const deniedWs = new WebSocket(wsUrl, { headers: { Origin: f.base } });
  const [code] = await once(deniedWs, 'close'); assert.equal(code, 1013);
  assert.equal(f.app.broker.status().viewers, 1);
  h.response.destroy(); h.request.destroy(); await until(() => f.app.broker.status().viewers === 0);
  const viewer = new WebSocket(wsUrl, { headers: { Origin: f.base } });
  await once(viewer, 'open'); await until(() => f.app.broker.status().viewers === 1);
  const deniedAgain = await stream(f.base); assert.equal(deniedAgain.response.statusCode, 503);
  viewer.close(); await once(viewer, 'close');
  await until(() => f.app.broker.status().viewers === 0);
});

test('real HTTP stream destroys on bounded writable admission instead of retaining an oversized frame', async t => {
  const f = await fixture(t, { maxClientBufferedBytes: 2048 }), h = await stream(f.base);
  await until(() => h.bytes().length === init.length + media(1).length);
  f.worker.send(media(2, 4096));
  await until(() => h.response.destroyed);
  await until(() => f.app.broker.httpViewers.size === 0);
  assert.equal(f.app.broker.status().media.viewers.backpressure_closes, 1);
  assert.deepEqual(h.bytes(), Buffer.concat([init, media(1)]));
});

test('existing queued HTTP bytes count towards backpressure and error paths clean up', () => {
  class Response extends EventEmitter {
    writableLength = 0; destroyed = false; writableEnded = false;
    writeHead() {} flushHeaders() {}
    write() { if (this.throwWrite) throw new Error('fixture write failed'); }
    end() { this.writableEnded = true; this.emit('close'); }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const broker = new Broker({ ...readConfig({}), maxClientBufferedBytes: 100 });
  broker.receiveWorker({ type: 'stream.reset', epoch: 'fixture', mime: 'video/mp4' }); broker.receiveMedia(init);
  const h = new Response(); broker.attachHttpViewer(h); h.writableLength = 90;
  broker.receiveMedia(media(1, 1));
  assert.equal(h.destroyed, true); assert.equal(broker.httpViewers.size, 0);
  assert.equal(broker.status().media.viewers.backpressure_closes, 1);
  const errored = new Response(); broker.attachHttpViewer(errored); errored.emit('error', new Error('fixture disconnect'));
  assert.equal(errored.destroyed, true); assert.equal(broker.httpViewers.size, 0);
  const failedWrite = new Response(); failedWrite.throwWrite = true; broker.attachHttpViewer(failedWrite);
  assert.equal(failedWrite.destroyed, true); assert.equal(broker.httpViewers.size, 0);
  const ceiling = new Broker({ ...readConfig({}), maxClientBufferedBytes: 16 * 1024 ** 2 });
  ceiling.receiveWorker({ type: 'stream.reset', epoch: 'ceiling', mime: 'video/mp4' }); ceiling.receiveMedia(init);
  const capped = new Response(); ceiling.attachHttpViewer(capped); capped.writableLength = 8 * 1024 ** 2 - 1;
  assert.equal(ceiling.sendHttpMedia(capped, Buffer.from([1, 2])), false);
  assert.equal(capped.destroyed, true, 'The hard eight-MiB ceiling also applies above a larger configured limit');
});
