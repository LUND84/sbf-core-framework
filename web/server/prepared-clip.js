import { EncodedClip, mediaError, readQuantizedReply } from './local-fmp4.js';

function need(value, code) { if (!value) throw mediaError(code); }
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const own = (data) => Uint8Array.from(data);

// Only the owned validator thread calls this after strict admission. Reason: no HTTP/WS object may bypass EncodedClip's sample/NAL/timestamp validation through this descriptor lane.
export function preparedDescriptor(normalized) {
  need(normalized.clip instanceof EncodedClip, 'PREPARED_STRICT_CLIP_REQUIRED');
  const clip = normalized.clip, parsed = readQuantizedReply(normalized.bytes);
  return { version: 1, init: own(parsed.init), durationSeconds: clip.durationSeconds,
    byteLength: clip.byteLength, fragmentCount: clip.fragmentCount, contentHash: clip.contentHash,
    signature: clip.signature, compatibilitySignature: clip.compatibilitySignature, mime: clip.mime,
    tracks: clip.tracks, durationTicks: [...clip.durationTicks],
    parts: parsed.parts.map((part) => ({ data: own(part.data), sequenceOffset: part.sequenceOffset,
      rows: part.rows.map(({ id, timescale, dts, ticks, tfdtOffset }) => ({ id, timescale, dts, ticks, tfdtOffset })) })) };
}

export class PreparedClip {
  #init; #parts; #starts; #durationTicks;
  constructor(value) {
    need(value?.version === 1 && value.init instanceof Uint8Array && value.init.length > 16
      && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.length <= 240
      && value.fragmentCount === value.parts.length && digest(value.contentHash)
      && digest(value.signature) && digest(value.compatibilitySignature)
      && typeof value.mime === 'string' && value.mime.length < 128
      && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds <= 120,
    'PREPARED_DESCRIPTOR_INVALID');
    need(Array.isArray(value.tracks) && value.tracks.length === 2 && value.tracks.every((track) =>
      Number.isSafeInteger(track.id) && track.id > 0 && Number.isSafeInteger(track.timescale) && track.timescale > 0
      && ['vide', 'soun'].includes(track.handler)), 'PREPARED_TRACKS_INVALID');
    this.#starts = new Map(); let total = value.init.length;
    for (const part of value.parts) {
      need(part.data instanceof Uint8Array && part.data.length > 16 && Number.isSafeInteger(part.sequenceOffset)
        && part.sequenceOffset >= 0 && part.sequenceOffset + 4 <= part.data.length
        && Array.isArray(part.rows) && part.rows.length === 2, 'PREPARED_PART_INVALID');
      total += part.data.length;
      for (const row of part.rows) {
        need(value.tracks.some((track) => track.id === row.id && track.timescale === row.timescale)
          && typeof row.dts === 'bigint' && row.dts >= 0n && typeof row.ticks === 'bigint' && row.ticks > 0n
          && Number.isSafeInteger(row.tfdtOffset) && row.tfdtOffset >= 0 && row.tfdtOffset + 8 <= part.data.length,
        'PREPARED_ROW_INVALID');
        if (!this.#starts.has(row.id)) this.#starts.set(row.id, row.dts);
      }
    }
    need(total === value.byteLength && total <= 64 * 1024 * 1024
      && Array.isArray(value.durationTicks) && value.durationTicks.length === 2, 'PREPARED_SIZE_INVALID');
    this.#durationTicks = new Map(value.durationTicks);
    need(value.tracks.every((track) => typeof this.#durationTicks.get(track.id) === 'bigint'
      && this.#durationTicks.get(track.id) > 0n), 'PREPARED_DURATION_INVALID');
    // Hydration is bounded metadata work and zero-copy ownership transfer. Reason: repeating full sample validation on the main event loop would defeat the worker isolation.
    this.#init = Buffer.from(value.init.buffer, value.init.byteOffset, value.init.byteLength);
    this.#parts = value.parts.map((part) => ({ ...part,
      data: Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength) }));
    for (const key of ['durationSeconds', 'byteLength', 'fragmentCount', 'contentHash', 'signature', 'compatibilitySignature', 'mime']) this[key] = value[key];
    this.tracks = Object.freeze(value.tracks.map((track) => Object.freeze({ ...track }))); Object.freeze(this);
  }
  get init() { return Buffer.from(this.#init); }
  get durationTicks() { return new Map(this.#durationTicks); }
  rewrite(index, sequence, bases) {
    need(Number.isInteger(sequence) && sequence >= 1 && sequence <= 0xffffffff, 'STREAM_SEQUENCE_RANGE');
    const part = this.#parts[index]; need(part, 'CLIP_FRAGMENT_INDEX');
    const data = Buffer.from(part.data); data.writeUInt32BE(sequence, part.sequenceOffset);
    let startSeconds = 0, endSeconds = 0;
    for (const row of part.rows) {
      const base = bases.get(row.id); need(typeof base === 'bigint' && base >= 0n, 'STREAM_TRACK_BASE');
      const start = base + row.dts - this.#starts.get(row.id);
      need(start + row.ticks <= 0xffffffffffffffffn, 'STREAM_TIME_RANGE');
      data.writeBigUInt64BE(start, row.tfdtOffset);
      startSeconds = Math.max(startSeconds, Number(start) / row.timescale);
      endSeconds = Math.max(endSeconds, Number(start + row.ticks) / row.timescale);
    }
    return { data, startSeconds, endSeconds };
  }
}
export const isPlayableClip = (value) => value instanceof EncodedClip || value instanceof PreparedClip;
