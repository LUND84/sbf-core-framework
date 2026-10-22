import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Broker } from '../server/broker.js';
import { readConfig } from '../server/config.js';

function box(kind, body) {
  const value = Buffer.from(body), header = Buffer.alloc(8);
  header.writeUInt32BE(value.length + 8); header.write(kind, 4);
  return Buffer.concat([header, value]);
}

test('broker diagnostics count source arrivals, cache eviction and viewer backpressure separately', () => {
  const broker = new Broker({ ...readConfig({}), maxCachedMediaBytes: 50, maxClientBufferedBytes: 100 });
  const reset = (epoch) => broker.receiveWorker({ type: 'stream.reset', epoch, mime: 'video/mp4' });
  const init = Buffer.concat([box('ftyp', 'isom'), box('moov', 'test')]);
  const fragment = Buffer.concat([box('moof', 'one'), box('mdat', 'sample')]);
  reset('first'); broker.receiveMedia(init); broker.receiveMedia(fragment); broker.receiveMedia(fragment);
  let media = broker.status().media;
  assert.equal(media.init_bytes, init.length);
  assert.equal(media.fragments.count, 2);
  assert.equal(media.fragments.bytes, fragment.length * 2);
  assert.equal(media.cache.fragments, 2);
  const viewer = Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0,
    send() {},
    close(code) { this.closedWith = code; this.readyState = 3; this.emit('close'); },
  });
  broker.attachViewer(viewer);
  assert.equal(broker.status().media.fragments.count, 2, 'cache replay must not count as a producer arrival');
  viewer.bufferedAmount = 101;
  assert.equal(broker.send(viewer, { type: 'status' }), false);
  media = broker.status().media;
  assert.equal(viewer.closedWith, 1013);
  assert.equal(media.viewers.pending_high_water_bytes, 101);
  assert.equal(media.viewers.backpressure_closes, 1);
  broker.receiveMedia(Buffer.concat([box('moof', 'large'), box('mdat', 'x'.repeat(60))]));
  media = broker.status().media;
  assert.equal(media.fragments.count, 3);
  assert.equal(media.cache.fragments, 0, 'oversized cache eviction remains observable despite ready=true');
  assert.equal(broker.stream.ready, true);
  reset('second');
  media = broker.status().media;
  assert.equal(media.fragments.count, 0);
  assert.equal(media.fragments.last_age_ms, null);
  assert.equal(media.viewers.backpressure_closes, 0);
});
