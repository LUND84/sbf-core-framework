import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_BOXES = 4096;
const DEFAULT_LIMIT = 64 * 1024 * 1024;
export function mediaError(code) { return Object.assign(new Error(code), { code }); }
function need(value, code) { if (!value) throw mediaError(code); }
function uint(b, p, end) { need(p >= 0 && p + 4 <= end, 'MP4_TRUNCATED'); return b.readUInt32BE(p); }
function full(b, box) { return uint(b, box.body, box.end); }

function boxes(b, start = 0, end = b.length) {
  const result = [];
  while (start < end) {
    need(result.length < MAX_BOXES && start + 8 <= end, 'MP4_BOX_BOUND');
    let size = uint(b, start, end), header = 8;
    if (size === 1) {
      need(start + 16 <= end, 'MP4_TRUNCATED');
      const large = b.readBigUInt64BE(start + 8);
      need(large <= BigInt(Number.MAX_SAFE_INTEGER), 'MP4_BOX_BOUND');
      size = Number(large); header = 16;
    }
    // Bounded complete clips only. Reason: size=0 and partial boxes cannot be validated before admission to the local queue.
    need(size >= header && start + size <= end, 'MP4_BOX_BOUND');
    result.push({ type: b.toString('ascii', start + 4, start + 8), start, body: start + header, end: start + size });
    start += size;
  }
  return result;
}
function children(b, box) { return boxes(b, box.body, box.end); }
function one(items, type) {
  const found = items.filter((item) => item.type === type);
  need(found.length === 1, 'MP4_REQUIRED_' + type.toUpperCase());
  return found[0];
}
function version0(b, box) { need(b[box.body] === 0, 'MP4_VERSION'); }
function sameTime(a, aScale, c, cScale) { return a * BigInt(cScale) === c * BigInt(aScale); }

function descriptors(b, start, end) {
  const items = [];
  while (start < end) {
    need(items.length < 32, 'MP4_ESDS_BOUND');
    const tag = b[start++]; let length = 0, done = false;
    for (let i = 0; i < 4; i++) {
      need(start < end, 'MP4_ESDS_TRUNCATED');
      const byte = b[start++]; length = length * 128 + (byte & 127);
      if (!(byte & 128)) { done = true; break; }
    }
    need(done && start + length <= end, 'MP4_ESDS_BOUND');
    items.push({ tag, start, end: start + length }); start += length;
  }
  return items;
}
function aacConfig(b, esds) {
  version0(b, esds);
  const es = descriptors(b, esds.body + 4, esds.end);
  need(es.length === 1 && es[0].tag === 3 && es[0].end - es[0].start >= 3, 'MP4_ESDS_ES');
  const entry = es[0];
  // Reject dependency/URL/stream flags. Reason: a local self-contained clip must not refer to another stream or external data.
  need(b[entry.start + 2] === 0, 'MP4_ESDS_EXTERNAL');
  const decoder = descriptors(b, entry.start + 3, entry.end).find((v) => v.tag === 4);
  need(decoder && decoder.end - decoder.start >= 13 && b[decoder.start] === 0x40
    && b[decoder.start + 1] === 0x15, 'MP4_AAC_DECODER');
  const configs = descriptors(b, decoder.start + 13, decoder.end).filter((v) => v.tag === 5);
  need(configs.length === 1 && configs[0].end - configs[0].start >= 2, 'MP4_AAC_ASC');
  const p = configs[0].start, a = b[p], c = b[p + 1];
  need((a >> 3) === 2 && (((a & 7) << 1) | (c >> 7)) === 3
    && ((c >> 3) & 15) === 2 && (c & 7) === 0, 'MP4_AAC_NOT_LC_48_STEREO');
  return { raw: b.subarray(esds.body, esds.end).toString('hex'),
    audioSpecificConfig: b.subarray(configs[0].start, configs[0].end).toString('hex') };
}

function initialization(b, moov) {
  const contents = children(b, moov), tracks = new Map(), trexDurationOffsets = new Map(), audioSpecificConfigs = new Map();
  for (const trak of contents.filter((item) => item.type === 'trak')) {
    const fields = children(b, trak), tkhd = one(fields, 'tkhd');
    // Reject edits/encryption rather than silently losing priming or offsets. Reason: only one stable MSE init is emitted for every clip.
    need(!fields.some((item) => item.type === 'edts'), 'MP4_EDIT_LIST');
    need([0, 1].includes(b[tkhd.body]), 'MP4_VERSION');
    const id = uint(b, tkhd.body + (b[tkhd.body] ? 20 : 12), tkhd.end);
    const mdia = children(b, one(fields, 'mdia')), mdhd = one(mdia, 'mdhd'), hdlr = one(mdia, 'hdlr');
    need([0, 1].includes(b[mdhd.body]), 'MP4_VERSION');
    const timescale = uint(b, mdhd.body + (b[mdhd.body] ? 20 : 12), mdhd.end);
    const handler = b.toString('ascii', hdlr.body + 8, hdlr.body + 12);
    need(id > 0 && !tracks.has(id) && ['vide', 'soun'].includes(handler), 'MP4_TRACK');
    const minf = children(b, one(mdia, 'minf')), stbl = children(b, one(minf, 'stbl'));
    const stsd = one(stbl, 'stsd'); version0(b, stsd);
    need(uint(b, stsd.body + 4, stsd.end) === 1, 'MP4_SAMPLE_DESCRIPTIONS');
    const entries = boxes(b, stsd.body + 8, stsd.end);
    need(entries.length === 1, 'MP4_SAMPLE_DESCRIPTIONS');
    const entry = one(entries, handler === 'vide' ? 'avc1' : 'mp4a');
    let codec, configuration;
    if (handler === 'vide') {
      need(entry.body + 78 <= entry.end && b.readUInt16BE(entry.body + 24) === 1920
        && b.readUInt16BE(entry.body + 26) === 1080 && timescale > 0 && timescale % 30 === 0, 'MP4_VIDEO_SPEC');
      const avc = one(boxes(b, entry.body + 78, entry.end), 'avcC');
      need(avc.end - avc.body >= 7 && b[avc.body] === 1 && (b[avc.body + 4] & 3) === 3, 'MP4_AVCC');
      configuration = b.subarray(avc.body, avc.end).toString('hex');
      codec = 'avc1.' + b.subarray(avc.body + 1, avc.body + 4).toString('hex').toUpperCase();
    } else {
      need(entry.body + 28 <= entry.end && b.readUInt16BE(entry.body + 8) === 0
        && b.readUInt16BE(entry.body + 16) === 2 && b.readUInt32BE(entry.body + 24) === 48000 * 65536
        && timescale === 48000, 'MP4_AUDIO_SPEC');
      const aac = aacConfig(b, one(boxes(b, entry.body + 28, entry.end), 'esds'));
      configuration = aac.raw; audioSpecificConfigs.set(id, aac.audioSpecificConfig);
      codec = 'mp4a.40.2';
    }
    tracks.set(id, { id, timescale, handler, configuration, codec });
  }
  need(tracks.size === 2 && [...tracks.values()].filter((v) => v.handler === 'vide').length === 1, 'MP4_TWO_TRACKS');
  const trexes = children(b, one(contents, 'mvex'));
  need(trexes.length === 2 && trexes.every((v) => v.type === 'trex'), 'MP4_TREX');
  for (const box of trexes) {
    version0(b, box);
    const track = tracks.get(uint(b, box.body + 4, box.end));
    need(track && !track.defaults && box.end - box.body === 24, 'MP4_TREX');
    const description = uint(b, box.body + 8, box.end);
    need(description === 1, 'MP4_SAMPLE_DESCRIPTIONS');
    track.defaults = { duration: uint(b, box.body + 12, box.end), size: uint(b, box.body + 16, box.end),
      flags: uint(b, box.body + 20, box.end), description };
    trexDurationOffsets.set(track.id, box.body + 12);
  }
  const ordered = [...tracks.values()].sort((a, c) => a.id - c.id);
  const signature = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  // Preserve the old full-ESDS signature for asset identity; keep decoder compatibility separate.
  // Reason: speech/silence bitrate estimates may differ without changing ASC, while sealed manifests must retain their original identity hashes.
  const compatible = ordered.map((track) => track.handler === 'soun'
    ? { ...track, configuration: audioSpecificConfigs.get(track.id) } : track);
  const compatibilitySignature = createHash('sha256').update(JSON.stringify(compatible)).digest('hex');
  const mime = 'video/mp4; codecs="' + [ordered.find((v) => v.handler === 'vide').codec, 'mp4a.40.2'].join(',') + '"';
  return { tracks, ordered, signature, compatibilitySignature, mime, trexDurationOffsets };
}

function idr(b, start, end) {
  let found = false, units = 0;
  while (start < end) {
    need(++units <= 4096 && start + 4 <= end, 'MP4_NAL_BOUND');
    const size = b.readUInt32BE(start); start += 4;
    need(size > 0 && start + size <= end, 'MP4_NAL_BOUND');
    const type = b[start] & 31;
    if (type === 5) found = true;
    if (type === 1) need(!found, 'MP4_IDR_MIXED');
    start += size;
  }
  return found;
}

function fragment(b, moof, mdat, metadata, clockPolicy = 'strict') {
  const contents = children(b, moof), mfhd = one(contents, 'mfhd'); version0(b, mfhd);
  need(mfhd.end - mfhd.body === 8 && contents.length === 3, 'MP4_MFHD');
  const rows = [], ranges = [];
  for (const traf of contents.filter((v) => v.type === 'traf')) {
    const fields = children(b, traf), tfhd = one(fields, 'tfhd'), tfdt = one(fields, 'tfdt'), trun = one(fields, 'trun');
    need(fields.length === 3, 'MP4_TRAF_FIELDS');
    const flags = full(b, tfhd) & 0xffffff, id = uint(b, tfhd.body + 4, tfhd.end), track = metadata.tracks.get(id);
    need(b[tfhd.body] === 0 && track && !rows.some((v) => v.id === id)
      && (flags & 0x020000) && !(flags & ~0x02003a), 'MP4_TFHD_BASE');
    const canonical = track.handler === 'vide' ? track.timescale / 30 : 1024, durationFields = [];
    let cursor = tfhd.body + 8, duration = track.defaults.duration, size = track.defaults.size, sampleFlags = track.defaults.flags;
    if (flags & 2) { need(uint(b, cursor, tfhd.end) === 1, 'MP4_SAMPLE_DESCRIPTIONS'); cursor += 4; }
    if (flags & 8) {
      duration = uint(b, cursor, tfhd.end);
      durationFields.push({ offset: cursor - moof.start, field: 'tfhd.default_sample_duration' }); cursor += 4;
    }
    if (flags & 16) { size = uint(b, cursor, tfhd.end); cursor += 4; }
    if (flags & 32) { sampleFlags = uint(b, cursor, tfhd.end); cursor += 4; }
    need(cursor === tfhd.end, 'MP4_TFHD_LENGTH');
    // Version 1 is an intentional producer contract. Reason: in-place 64-bit tfdt rebasing supports long sessions without changing moof sizes/data offsets.
    need(b[tfdt.body] === 1 && tfdt.end - tfdt.body === 12, 'MP4_TFDT_REQUIRES_V1');
    const dts = b.readBigUInt64BE(tfdt.body + 4), runFlags = full(b, trun) & 0xffffff;
    const count = uint(b, trun.body + 4, trun.end);
    need([0, 1].includes(b[trun.body]) && (runFlags & 1) && !(runFlags & ~0xf05)
      && count > 0 && count <= 4096 && !((runFlags & 4) && (runFlags & 0x400)), 'MP4_TRUN');
    cursor = trun.body + 8;
    uint(b, cursor, trun.end); let data = moof.start + b.readInt32BE(cursor); cursor += 4;
    let firstFlags = sampleFlags;
    if (runFlags & 4) { firstFlags = uint(b, cursor, trun.end); cursor += 4; }
    let ticks = 0n, bytes = 0, firstSync = false;
    const sampleDurationTicks = clockPolicy === 'reply_rounding' ? [] : null;
    for (let i = 0; i < count; i++) {
      let sampleDuration = duration, sampleSize = size, sf = i === 0 ? firstFlags : sampleFlags;
      if (runFlags & 0x100) {
        sampleDuration = uint(b, cursor, trun.end);
        durationFields.push({ offset: cursor - moof.start, field: 'trun.sample_duration' }); cursor += 4;
      }
      if (runFlags & 0x200) { sampleSize = uint(b, cursor, trun.end); cursor += 4; }
      if (runFlags & 0x400) { sf = uint(b, cursor, trun.end); cursor += 4; }
      if (runFlags & 0x800) { need(uint(b, cursor, trun.end) === 0, 'MP4_REORDER_UNSUPPORTED'); cursor += 4; }
      need(sampleSize > 0 && data >= mdat.body && data + sampleSize <= mdat.end, 'MP4_SAMPLE_DATA');
      if (clockPolicy === 'strict') need(sampleDuration === canonical, 'MP4_SAMPLE_CLOCK');
      else if (clockPolicy === 'reply_rounding') {
        const quantum = track.timescale / 1000;
        // Only known millisecond rounding, within one millisecond. Reason: speech normalization must reject arbitrary time stretching even when endpoint counts happen to match.
        need(sampleDuration > 0 && Math.abs(sampleDuration - canonical) <= quantum
          && [canonical, Math.floor(canonical / quantum) * quantum, Math.ceil(canonical / quantum) * quantum]
            .some((value) => Math.abs(sampleDuration - value) <= 1), 'MP4_REPLY_CLOCK_QUANTIZATION');
        sampleDurationTicks.push(sampleDuration);
      } else need(sampleDuration > 0 && Math.abs(sampleDuration - canonical) <= Math.ceil(track.timescale / 1000) + 1, 'MP4_SOURCE_CLOCK_QUANTIZATION');
      if (i === 0) {
        firstSync = !(sf & 0x10000);
        if (track.handler === 'vide' && firstSync) need(idr(b, data, data + sampleSize), 'MP4_SYNC_NOT_IDR');
      }
      ticks += BigInt(sampleDuration); bytes += sampleSize; data += sampleSize;
    }
    need(cursor === trun.end, 'MP4_TRUN_LENGTH');
    ranges.push([data - bytes, data]);
    rows.push({ id, timescale: track.timescale, handler: track.handler, dts, ticks, count, firstSync,
      canonicalDuration: canonical, durationFields, tfdtOffset: tfdt.body + 4 - moof.start,
      ...(sampleDurationTicks ? { sampleDurationTicks } : {}) });
  }
  need(rows.length === 2, 'MP4_FRAGMENT_TWO_TRACKS');
  ranges.sort((a, c) => a[0] - c[0]);
  need(ranges[0][0] === mdat.body && ranges[0][1] === ranges[1][0] && ranges[1][1] === mdat.end, 'MP4_MDAT_COVERAGE');
  return { data: Buffer.from(b.subarray(moof.start, mdat.end)), rows, sourceOffset: moof.start,
    mdatPayloadOffset: mdat.body - moof.start, sequenceOffset: mfhd.body + 4 - moof.start };
}

function structure(input, { maxBytes = DEFAULT_LIMIT, clockPolicy = 'strict', maxParts = 1024 } = {}) {
  need(Buffer.isBuffer(input) && input.length > 0 && input.length <= maxBytes, 'CLIP_BYTE_LIMIT');
  const b = Buffer.from(input), top = boxes(b);
  need(top[0]?.type === 'ftyp' && top[1]?.type === 'moov', 'MP4_INIT_ORDER');
  const metadata = initialization(b, top[1]), parts = [];
  let at = 2;
  while (at < top.length && top[at].type === 'moof') {
    need(top[at + 1]?.type === 'mdat' && parts.length < maxParts, 'MP4_FRAGMENT_ORDER');
    parts.push(fragment(b, top[at], top[at + 1], metadata, clockPolicy)); at += 2;
  }
  need(parts.length > 0 && (at === top.length || (at + 1 === top.length && top[at].type === 'mfra')), 'MP4_TRAILING_BOX');
  return { init: Buffer.from(b.subarray(0, top[1].end)), metadata, parts, hasTrailer: at !== top.length };
}

// This reader never admits a playable clip. Reason: only the silent normalizer may inspect tightly bounded RTMP millisecond rounding before strict second-pass validation.
export function readQuantizedIdle(input) { return structure(input, { clockPolicy: 'millisecond_rounding', maxParts: 32 }); }

// Inspection is separate from playback admission. Reason: bounded speech rounding is accepted only after identity, counts, all-prefix timing and strict second-pass gates in normalizeSealedReply.
export function readQuantizedReply(input) {
  const parsed = structure(input, { clockPolicy: 'reply_rounding', maxParts: 240 });
  const video = parsed.metadata.ordered.find((track) => track.handler === 'vide');
  need(video.timescale === 90000 && video.codec.startsWith('avc1.4D'), 'MP4_REPLY_VIDEO_SPEC');
  return parsed;
}

export class EncodedClip {
  #init; #parts; #metadata; #starts; #durationTicks;
  constructor(input, { maxBytes = DEFAULT_LIMIT, maxDurationSeconds = 120, maxFragmentSeconds = 1 } = {}) {
    const parsed = structure(input, { maxBytes });
    this.#metadata = parsed.metadata; this.#init = parsed.init; this.#parts = parsed.parts;
    this.#starts = new Map(); const ends = new Map();
    for (const part of this.#parts) for (const row of part.rows) {
      need(Number(row.ticks) / row.timescale <= maxFragmentSeconds, 'CLIP_FRAGMENT_DURATION_LIMIT');
      if (!this.#starts.has(row.id)) {
        this.#starts.set(row.id, row.dts);
        if (row.handler === 'vide') need(row.firstSync, 'CLIP_MUST_START_IDR');
      } else need(ends.get(row.id) === row.dts, 'CLIP_DTS_GAP');
      ends.set(row.id, row.dts + row.ticks);
    }
    const [a, c] = this.#metadata.ordered;
    need(sameTime(this.#starts.get(a.id), a.timescale, this.#starts.get(c.id), c.timescale), 'CLIP_TRACK_START_SKEW');
    this.#durationTicks = new Map([...ends].map(([id, end]) => [id, end - this.#starts.get(id)]));
    need(sameTime(this.#durationTicks.get(a.id), a.timescale, this.#durationTicks.get(c.id), c.timescale), 'CLIP_TRACK_DURATION_SKEW');
    this.durationSeconds = Number(this.#durationTicks.get(a.id)) / a.timescale;
    need(this.durationSeconds > 0 && this.durationSeconds <= maxDurationSeconds, 'CLIP_DURATION_LIMIT');
    this.byteLength = input.length; this.fragmentCount = this.#parts.length;
    this.contentHash = createHash('sha256').update(input).digest('hex');
    this.signature = this.#metadata.signature; this.compatibilitySignature = this.#metadata.compatibilitySignature; this.mime = this.#metadata.mime;
    this.tracks = Object.freeze(this.#metadata.ordered.map((v) => Object.freeze({ id: v.id, timescale: v.timescale, handler: v.handler })));
    Object.freeze(this);
  }
  get init() { return Buffer.from(this.#init); }
  get durationTicks() { return new Map(this.#durationTicks); }
  rewrite(index, sequence, starts) {
    need(Number.isInteger(sequence) && sequence >= 1 && sequence <= 0xffffffff, 'STREAM_SEQUENCE_RANGE');
    const part = this.#parts[index]; need(part, 'CLIP_FRAGMENT_INDEX');
    const data = Buffer.from(part.data); data.writeUInt32BE(sequence, part.sequenceOffset);
    let startSeconds = 0, endSeconds = 0;
    for (const row of part.rows) {
      const base = starts.get(row.id); need(typeof base === 'bigint' && base >= 0n, 'STREAM_TRACK_BASE');
      const start = base + row.dts - this.#starts.get(row.id);
      need(start + row.ticks <= 0xffffffffffffffffn, 'STREAM_TIME_RANGE');
      data.writeBigUInt64BE(start, row.tfdtOffset);
      startSeconds = Math.max(startSeconds, Number(start) / row.timescale);
      endSeconds = Math.max(endSeconds, Number(start + row.ticks) / row.timescale);
    }
    return { data, startSeconds, endSeconds };
  }
}

export async function loadEncodedClip(filename, { root, maxBytes = DEFAULT_LIMIT, ...options } = {}) {
  need(typeof root === 'string' && typeof filename === 'string', 'CLIP_PATH_REQUIRED');
  const base = await realpath(root), file = path.resolve(base, filename);
  need(file.startsWith(base + path.sep), 'CLIP_PATH_SCOPE');
  for (let cursor = file; cursor !== base; cursor = path.dirname(cursor)) need(!(await lstat(cursor)).isSymbolicLink(), 'CLIP_PATH_LINK');
  need(await realpath(file) === file, 'CLIP_PATH_LINK');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); need(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'CLIP_BYTE_LIMIT');
    // Read a bounded admitted size, not readFile on a growing file. Reason: concurrent uploads must not bypass the memory cap.
    const data = Buffer.alloc(stat.size); let received = 0;
    while (received < data.length) {
      const { bytesRead } = await handle.read(data, received, data.length - received, received);
      need(bytesRead > 0, 'CLIP_CHANGED'); received += bytesRead;
    }
    const after = await handle.stat();
    need(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'CLIP_CHANGED');
    return new EncodedClip(data, { maxBytes, ...options });
  } finally { await handle.close(); }
}
