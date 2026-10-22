// Own the encoded FIFO and the sole in-flight SourceBuffer operation.
// Reason: append/remove must stay ordered, while playback policy must not manage MSE busy flags at several call sites.
export class PlaybackBuffer {
  #queue = [];
  #bytes = 0;
  #buffer = null;
  #busy = false;
  #trim = null;
  #complete;
  #error;
  #trace;
  #updateListener;
  #errorListener;
  constructor({ maxBytes = 32 * 1024 ** 2, onComplete, onError, onTrace }) {
    this.maxBytes = maxBytes; this.#complete = onComplete; this.#error = onError; this.#trace = onTrace;
  }
  get items() { return this.#queue.map(item => ({ ...item })); }
  get queuedBytes() { return this.#bytes; }
  attach(buffer) {
    this.#detach(); this.#buffer = buffer;
    this.#updateListener = () => {
      this.#busy = false;
      if (this.#trim) { this.#trace('trim-end', this.#trim); this.#trim = null; }
      this.#complete();
    };
    this.#errorListener = () => this.#error('视频片段无法解码，请重新连接。');
    buffer.addEventListener('updateend', this.#updateListener);
    buffer.addEventListener('error', this.#errorListener);
  }
  #detach() {
    if (this.#buffer) {
      this.#buffer.removeEventListener('updateend', this.#updateListener);
      this.#buffer.removeEventListener('error', this.#errorListener);
    }
    this.#buffer = null; this.#busy = false; this.#trim = null;
  }
  push(data) {
    if (this.#bytes + data.byteLength > this.maxBytes) {
      this.#queue = []; this.#bytes = 0;
      this.#error('视频缓冲积压，请重新连接以回到直播。'); return false;
    }
    this.#queue.push({ data, retries: 0 }); this.#bytes += data.byteLength; return true;
  }
  step(currentTime, retain) {
    const buffer = this.#buffer;
    if (!buffer || this.#busy || buffer.updating) return;
    // Append current media before elective history cleanup.
    // Reason: an already queued playable fragment must not wait behind removing old, unneeded history.
    const item = this.#queue.shift();
    if (!item) { this.trim(currentTime, retain); return; }
    this.#bytes -= item.data.byteLength;
    try {
      this.#busy = true; buffer.appendBuffer(item.data);
    } catch (error) {
      this.#busy = false;
      if (error.name === 'QuotaExceededError' && item.retries < 2) {
        item.retries += 1; this.#queue.unshift(item); this.#bytes += item.data.byteLength;
        return 'quota';
      }
      this.#error(`视频缓冲写入失败：${error.message}`);
    }
  }
  trim(currentTime, retain) {
    const buffer = this.#buffer;
    if (!buffer || this.#busy || buffer.updating || !buffer.buffered.length) return false;
    const start = buffer.buffered.start(0), cutoff = currentTime - retain;
    if (cutoff - start < 2) return false;
    try {
      this.#busy = true; this.#trim = { removeStart: start, removeEnd: cutoff };
      this.#trace('trim-start', this.#trim); buffer.remove(start, cutoff); return true;
    } catch {
      this.#busy = false; this.#trim = null; return false;
    }
  }
  clear() { this.#detach(); this.#queue = []; this.#bytes = 0; }
}
