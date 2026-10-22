import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePlayer } from '../public/media.js';

function box(type, body = '') {
  const payload = Buffer.from(body), header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
}

function harness() {
  const tasks = [];
  const queue = (kind, run) => tasks.push({ kind, run });
  const flush = kind => {
    let index;
    while ((index = tasks.findIndex(task => task.kind === kind)) >= 0) tasks.splice(index, 1)[0].run();
  };
  class Video extends EventTarget {
    paused = true; readyState = 4; currentTime = 0; playbackRate = 1; ranges = []; playCalls = 0; pauseCalls = 0;
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i].start,
      end: i => this.ranges[i].end }; }
    play() {
      this.playCalls += 1; this.paused = false;
      queue('play', () => this.dispatchEvent(new Event('play')));
      queue('playing', () => this.dispatchEvent(new Event('playing')));
      return Promise.resolve();
    }
    pause() {
      if (this.paused) return;
      this.paused = true; this.pauseCalls += 1;
      queue('pause', () => this.dispatchEvent(new Event('pause')));
    }
    removeAttribute() {}
    load() { this.currentTime = 0; this.ranges = []; }
  }
  const video = new Video();
  class SourceBuffer extends EventTarget {
    updating = false;
    get buffered() { return video.buffered; }
    appendBuffer(value) {
      this.updating = true;
      const bytes = Buffer.from(value), type = bytes.toString('ascii', 4, 8);
      queue('updateend', () => {
        if (type === 'moof') {
          const range = JSON.parse(bytes.toString('utf8', 8, bytes.readUInt32BE(0)));
          const last = video.ranges.at(-1);
          if (last && last.end === range.start) last.end = range.end;
          else video.ranges.push(range);
        }
        this.updating = false; this.dispatchEvent(new Event('updateend'));
      });
    }
    abort() {} remove() { throw new Error('Unexpected trim in short event regression'); }
  }
  class MediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    constructor() {
      super();
      queue('sourceopen', () => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); });
    }
    addSourceBuffer() { return new SourceBuffer(); } removeSourceBuffer() {}
  }
  globalThis.MediaSource = MediaSource;
  globalThis.window = { MediaSource, setInterval: () => 1 };
  URL.createObjectURL = () => 'blob:event-regression'; URL.revokeObjectURL = () => {};
  const player = new LivePlayer(video, () => {}, () => {});
  const array = bytes => Uint8Array.from(bytes).buffer;
  const reset = epoch => {
    player.reset({ epoch, mime: 'video/mp4; codecs="avc1.4D401F,mp4a.40.2"' });
    player.append(array(Buffer.concat([box('ftyp', 'isom'), box('moov', 'structural-fixture')])));
  };
  const append = (start, end) => {
    player.append(array(Buffer.concat([box('moof', JSON.stringify({ start, end })), box('mdat', 'fixture')])));
    flush('updateend');
  };
  reset('first'); flush('sourceopen'); flush('updateend');
  return { player, video, flush, reset, append };
}

test('an admitted exact two-second start survives one frame before the queued playing event', async () => {
  const h = harness();
  h.append(0, 0.5);
  assert.equal(h.video.playCalls, 0, 'The original two-second startup gate remains');
  h.append(0.5, 2);
  assert.equal(h.video.playCalls, 1);
  await Promise.resolve();
  h.video.currentTime += 1 / 30;
  h.flush('play'); h.flush('playing');
  assert.equal(h.video.paused, false, 'Consuming one frame must not revoke the accepted reserve');
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.player.state, 'playing');
});

test('timeupdate before the queued playing event does not restart buffer accumulation', async () => {
  const h = harness();
  h.append(0, 2);
  await Promise.resolve();
  h.video.currentTime += 1 / 30;
  h.video.dispatchEvent(new Event('timeupdate'));
  h.flush('play'); h.flush('playing');
  assert.equal(h.video.paused, false);
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.player.state, 'playing');
});

test('loadeddata queued after an admitted start cannot impose the startup reserve a second time', async () => {
  const h = harness();
  h.append(0, 2);
  await Promise.resolve();
  h.video.currentTime += 1 / 30;
  h.video.dispatchEvent(new Event('loadeddata'));
  h.flush('play'); h.flush('playing');
  assert.equal(h.video.paused, false);
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.player.state, 'playing');
});

test('rebuffer still stops below half a second and resumes from two seconds without a second pause', async () => {
  const h = harness();
  h.append(0, 2); h.flush('play'); h.flush('playing');
  await Promise.resolve();
  h.video.currentTime = 1.6;
  h.video.dispatchEvent(new Event('timeupdate'));
  // Hot native notifications merge in one microtask. Reason: preserve the same real low-water assertion after the bounded owner has run.
  await Promise.resolve();
  assert.equal(h.video.paused, true);
  assert.equal(h.video.pauseCalls, 1);
  assert.equal(h.player.bufferingMode, 'rebuffer');
  h.flush('pause');
  h.append(2, 3.6);
  h.video.currentTime += 1 / 30;
  h.flush('play'); h.flush('playing');
  assert.equal(h.video.paused, false);
  assert.equal(h.video.pauseCalls, 1, 'Resuming may not immediately pause again');
  assert.equal(h.player.state, 'playing');
});

test('clear pause arriving after reset but before sourceopen is internal to the replaced epoch', async () => {
  const h = harness();
  h.append(0, 2); h.flush('play'); h.flush('playing');
  await Promise.resolve();
  h.reset('second');
  h.flush('pause');
  assert.equal(Boolean(h.player.playBlocked), false, 'An old reset task is not a manual pause');
  h.append(10, 12);
  h.flush('sourceopen'); h.flush('updateend');
  h.flush('play'); h.flush('playing');
  assert.equal(h.video.currentTime, 10);
  assert.equal(h.video.paused, false);
  assert.equal(h.player.state, 'playing');
});

test('a real manual pause after epoch recovery stays paused through new fragments and queued events', async () => {
  const h = harness();
  h.append(0, 2); h.flush('play'); h.flush('playing');
  await Promise.resolve();
  h.reset('second'); h.flush('pause');
  h.append(10, 12); h.flush('sourceopen'); h.flush('updateend');
  h.flush('play'); h.flush('playing');
  await Promise.resolve();
  assert.equal(h.video.paused, false);
  const played = h.video.playCalls;
  h.video.pause();
  // An updateend can precede the user's pause event. Reason: the player must inspect paused synchronously as well.
  h.append(12, 12.5);
  h.video.dispatchEvent(new Event('timeupdate')); h.player.maintain(); h.flush('pause');
  assert.equal(h.video.playCalls, played);
  assert.equal(h.player.state, 'paused');
  assert.equal(h.player.playBlocked, true);
  h.player.goLive(); h.flush('play'); h.flush('playing');
  assert.equal(h.video.paused, false, 'Only an explicit return-to-live resumes the manual pause');
  assert.equal(h.player.playBlocked, false);
});
