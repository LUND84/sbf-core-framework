const MAX_BYTES = 8 * 1024 ** 2;
const TYPES = new Set(['ftyp', 'moov', 'moof', 'mdat']);

// Transport assembly only. Reason: WebSocket chunk boundaries are unrelated to complete MSE append units.
export class Fmp4ChunkAssembler {
  constructor({ maxBytes = MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > MAX_BYTES) {
      throw new Error('Invalid fMP4 assembly bound');
    }
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.storage = new Uint8Array(0);
    this.headOffset = 0;
    this.queuedBytes = 0;
    this.pending = null;
    this.initialized = false;
    this.failed = false;
  }

  push(value) {
    if (this.failed) throw new Error('fMP4 assembler requires reset after failure');
    try {
      const data = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (!(data instanceof Uint8Array)) throw new Error('fMP4 chunks must be byte arrays');
      if (!data.byteLength) return [];
      // Bound retained incomplete data, including the first box of a pair.
      // Reason: a missing mdat or malicious declared size must not retain unbounded transport data.
      if (this.queuedBytes + (this.pending?.byteLength || 0) + data.byteLength > this.maxBytes) {
        throw new Error('fMP4 assembly exceeds its byte bound');
      }
      this.reserve(this.queuedBytes + data.byteLength);
      this.storage.set(data, this.headOffset + this.queuedBytes);
      this.queuedBytes += data.byteLength;
      const result = [];
      while (this.queuedBytes >= 8) {
        const header = this.peek(Math.min(16, this.queuedBytes));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let size = view.getUint32(0);
        const type = String.fromCharCode(...header.subarray(4, 8));
        const width = size === 1 ? 16 : 8;
        if (!TYPES.has(type)) throw new Error(`Unsupported fMP4 box: ${type}`);
        if (size === 0 || (size !== 1 && size < width)) throw new Error('Invalid fMP4 box length');
        if (width === 16) {
          if (header.byteLength < 16) break;
          const extended = view.getBigUint64(8);
          if (extended < 16n || extended > BigInt(this.maxBytes)) throw new Error('Invalid extended fMP4 length');
          size = Number(extended);
        }
        if (size + (this.pending?.byteLength || 0) > this.maxBytes) throw new Error('fMP4 segment exceeds its byte bound');
        this.requireOrder(type);
        if (this.queuedBytes < size) break;
        if (type === 'ftyp' || type === 'moof') {
          this.pending = new Uint8Array(size);
          this.takeInto(this.pending);
        } else {
          const segment = new Uint8Array(this.pending.byteLength + size);
          segment.set(this.pending);
          this.takeInto(segment, this.pending.byteLength);
          this.pending = null;
          if (type === 'moov') this.initialized = true;
          result.push(segment.buffer);
        }
      }
      return result;
    } catch (error) {
      this.reset();
      this.failed = true;
      throw error;
    }
  }

  requireOrder(type) {
    const expected = this.initialized ? (this.pending ? 'mdat' : 'moof') : (this.pending ? 'moov' : 'ftyp');
    if (type !== expected) throw new Error(`Unexpected fMP4 box ${type}; expected ${expected}`);
  }

  peek(length) {
    return this.storage.subarray(this.headOffset, this.headOffset + length);
  }

  reserve(length) {
    // Geometric storage also bounds chunk bookkeeping. Reason: millions of one-byte chunks must not create millions of objects.
    if (length > this.storage.byteLength) {
      const size = Math.min(this.maxBytes, Math.max(length, this.storage.byteLength * 2, 16384));
      const storage = new Uint8Array(size);
      storage.set(this.peek(this.queuedBytes)); this.storage = storage; this.headOffset = 0;
    } else if (this.headOffset + length > this.storage.byteLength) {
      this.storage.copyWithin(0, this.headOffset, this.headOffset + this.queuedBytes); this.headOffset = 0;
    }
  }

  takeInto(target, offset = 0) {
    const count = target.byteLength - offset;
    target.set(this.peek(count), offset);
    this.headOffset += count; this.queuedBytes -= count;
    if (!this.queuedBytes) this.headOffset = 0;
  }

  finish() {
    if (this.failed || this.queuedBytes || this.pending || !this.initialized) {
      throw new Error('fMP4 transport ended before a complete segment');
    }
  }
}
