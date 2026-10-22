import { createHash } from 'node:crypto';
import { EncodedClip, mediaError, readQuantizedReply } from './local-fmp4.js';

const HARD_BYTES = 64 * 1024 * 1024, PART_BYTES = 8 * 1024 * 1024;
const VIDEO_SAMPLES = 16, AUDIO_SAMPLES = 25, VIDEO_TICKS = 48000n, AUDIO_TICKS = 25600n;
const abs = value => value < 0n ? -value : value;
const sha = data => createHash('sha256').update(data).digest('hex');
function need(value, code) { if (!value) throw mediaError(code); }
function uint(data, offset, end = data.length) { need(offset >= 0 && offset + 4 <= end, 'STREAM_TRUNCATED'); return data.readUInt32BE(offset); }
function boxes(data, start = 0, end = data.length) {
  const result = [];
  while (start < end) {
    need(result.length < 4096 && start + 8 <= end, 'STREAM_BOX_BOUND');
    let size = uint(data, start, end), header = 8;
    if (size === 1) {
      need(start + 16 <= end, 'STREAM_BOX_BOUND'); const large = data.readBigUInt64BE(start + 8);
      need(large <= BigInt(Number.MAX_SAFE_INTEGER), 'STREAM_BOX_BOUND'); size = Number(large); header = 16;
    }
    need(size >= header && start + size <= end, 'STREAM_BOX_BOUND');
    result.push({ type: data.toString('ascii', start + 4, start + 8), start, body: start + header, end: start + size }); start += size;
  }
  return result;
}
const children = (data, box) => boxes(data, box.body, box.end);
function one(items, type) { const found = items.filter(item => item.type === type); need(found.length === 1, 'STREAM_REQUIRED_' + type.toUpperCase()); return found[0]; }
function parameters(configuration) {
  const bytes = Buffer.from(configuration, 'hex'), result = { sps: [], pps: [] }; let cursor = 6;
  for (const [kind, count] of [['sps', bytes[5] & 31], ['pps', null]]) {
    const total = count ?? bytes[cursor++]; need(Number.isInteger(total) && total > 0 && total <= 31, 'STREAM_AVCC');
    for (let i = 0; i < total; i++) {
      need(cursor + 2 <= bytes.length, 'STREAM_AVCC'); const size = bytes.readUInt16BE(cursor); cursor += 2;
      need(size > 0 && cursor + size <= bytes.length, 'STREAM_AVCC'); result[kind].push(bytes.subarray(cursor, cursor + size)); cursor += size;
    }
  }
  need(cursor === bytes.length, 'STREAM_AVCC'); return result;
}
function sliceType(nal) {
  // Read only a bounded RBSP header, not pixels or a full H.264 decoder.
  // Reason: CTO=0 alone does not prove absence of B slices, and a large sample must not create unbounded header work.
  const rbsp = []; let zeros = 0;
  for (let i = 1; i < nal.length && rbsp.length < 64; i++) {
    const value = nal[i];
    if (zeros >= 2 && value === 3) { need(i + 1 < nal.length && nal[i + 1] <= 3, 'STREAM_H264_ESCAPE'); zeros = 0; continue; }
    rbsp.push(value); zeros = value === 0 ? zeros + 1 : 0;
  }
  let bit = 0;
  function read() { need(bit < rbsp.length * 8, 'STREAM_H264_SLICE_HEADER'); const value = (rbsp[bit >> 3] >> (7 - (bit & 7))) & 1; bit++; return value; }
  function ue() { let width = 0; while (!read()) need(++width <= 31, 'STREAM_H264_SLICE_HEADER'); let value = 1; for (let i = 0; i < width; i++) value = value * 2 + read(); return value - 1; }
  ue(); const type = ue(); need(type <= 9, 'STREAM_H264_SLICE_HEADER'); return type % 5;
}
function inspectVideo(data, configs) {
  let cursor = 0, units = 0, idr = false, nonIdr = false, vcl = 0;
  while (cursor < data.length) {
    need(++units <= 4096 && cursor + 4 <= data.length, 'STREAM_NAL_BOUND'); const size = uint(data, cursor); cursor += 4;
    need(size > 0 && cursor + size <= data.length, 'STREAM_NAL_BOUND');
    const nal = data.subarray(cursor, cursor + size), type = nal[0] & 31; cursor += size;
    need(!(nal[0] & 0x80) && [1, 5, 6, 7, 8, 9, 12].includes(type), 'STREAM_NAL_TYPE');
    if (type === 7 || type === 8) need(configs[type === 7 ? 'sps' : 'pps'].some(value => value.equals(nal)), 'STREAM_PARAMETER_CHANGE');
    if (type === 1 || type === 5) {
      const kind = sliceType(nal); need(kind !== 1, 'STREAM_B_SLICE_UNSUPPORTED');
      need([0, 2].includes(kind) && (type !== 5 || kind === 2), 'STREAM_SLICE_UNSUPPORTED');
      vcl++; if (type === 5) idr = true; else nonIdr = true;
    }
  }
  need(vcl > 0 && !(idr && nonIdr), 'STREAM_VCL_REQUIRED'); return idr;
}
function parsePart(data, metadata, configs) {
  const top = boxes(data); need(top.length === 2 && top[0].type === 'moof' && top[1].type === 'mdat', 'STREAM_FRAGMENT_ORDER');
  const [moof, mdat] = top, contents = children(data, moof), mfhd = one(contents, 'mfhd');
  need(contents.length === 3 && uint(data, mfhd.body, mfhd.end) === 0 && mfhd.end - mfhd.body === 8, 'STREAM_MFHD');
  const sequence = uint(data, mfhd.body + 4, mfhd.end); need(sequence > 0, 'STREAM_SEQUENCE_RANGE');
  const rows = [], ranges = [];
  for (const traf of contents.filter(item => item.type === 'traf')) {
    const fields = children(data, traf), tfhd = one(fields, 'tfhd'), tfdt = one(fields, 'tfdt'), trun = one(fields, 'trun');
    need(fields.length === 3, 'STREAM_TRAF_FIELDS');
    const flags = uint(data, tfhd.body, tfhd.end) & 0xffffff, id = uint(data, tfhd.body + 4, tfhd.end), track = metadata.tracks.get(id);
    need(data[tfhd.body] === 0 && track && !rows.some(row => row.id === id) && (flags & 0x020000) && !(flags & ~0x02003a), 'STREAM_TFHD');
    let cursor = tfhd.body + 8, duration = track.defaults.duration, size = track.defaults.size, sampleFlags = track.defaults.flags;
    if (flags & 2) { need(uint(data, cursor, tfhd.end) === 1, 'STREAM_SAMPLE_DESCRIPTION'); cursor += 4; }
    if (flags & 8) { duration = uint(data, cursor, tfhd.end); cursor += 4; }
    if (flags & 16) { size = uint(data, cursor, tfhd.end); cursor += 4; }
    if (flags & 32) { sampleFlags = uint(data, cursor, tfhd.end); cursor += 4; }
    need(cursor === tfhd.end, 'STREAM_TFHD_LENGTH');
    need(uint(data, tfdt.body, tfdt.end) === 0x1000000 && tfdt.end - tfdt.body === 12, 'STREAM_TFDT_REQUIRES_V1');
    const dts = data.readBigUInt64BE(tfdt.body + 4), runFlags = uint(data, trun.body, trun.end) & 0xffffff;
    const count = uint(data, trun.body + 4, trun.end);
    need([0, 1].includes(data[trun.body]) && (runFlags & 1) && !(runFlags & ~0xf05)
      && !((runFlags & 4) && (runFlags & 0x400)), 'STREAM_TRUN');
    if (track.handler === 'vide') need(count === VIDEO_SAMPLES, 'STREAM_GOP16_REQUIRED');
    else need(count >= 24 && count <= 26, 'STREAM_AAC_FRAGMENT_COUNT');
    cursor = trun.body + 8; uint(data, cursor, trun.end); let offset = moof.start + data.readInt32BE(cursor); cursor += 4;
    let firstFlags = sampleFlags; if (runFlags & 4) { firstFlags = uint(data, cursor, trun.end); cursor += 4; }
    const samples = []; let ticks = 0n;
    for (let index = 0; index < count; index++) {
      let sampleDuration = duration, sampleSize = size, sf = index === 0 ? firstFlags : sampleFlags;
      if (runFlags & 0x100) { sampleDuration = uint(data, cursor, trun.end); cursor += 4; }
      if (runFlags & 0x200) { sampleSize = uint(data, cursor, trun.end); cursor += 4; }
      if (runFlags & 0x400) { sf = uint(data, cursor, trun.end); cursor += 4; }
      if (runFlags & 0x800) { need(uint(data, cursor, trun.end) === 0, 'MP4_REORDER_UNSUPPORTED'); cursor += 4; }
      need(sampleSize > 0 && offset >= mdat.body && offset + sampleSize <= mdat.end, 'STREAM_SAMPLE_DATA');
      const canonical = track.handler === 'vide' ? 3000 : 1024, quantum = track.timescale / 1000;
      need(sampleDuration > 0 && Math.abs(sampleDuration - canonical) <= quantum
        && [canonical, Math.floor(canonical / quantum) * quantum, Math.ceil(canonical / quantum) * quantum]
          .some(value => Math.abs(sampleDuration - value) <= 1), 'MP4_REPLY_CLOCK_QUANTIZATION');
      const sample = { data: Buffer.from(data.subarray(offset, offset + sampleSize)), duration: sampleDuration, flags: sf, dts: dts + ticks };
      if (track.handler === 'vide') {
        const isIdr = inspectVideo(sample.data, configs);
        need(index === 0 ? isIdr && !(sf & 0x10000) : !isIdr && Boolean(sf & 0x10000), 'STREAM_GOP16_IDR_REQUIRED');
      }
      samples.push(sample); ranges.push([offset, offset + sampleSize]); ticks += BigInt(sampleDuration); offset += sampleSize;
    }
    need(cursor === trun.end, 'STREAM_TRUN_LENGTH'); rows.push({ ...track, dts, ticks, samples });
  }
  need(rows.length === 2 && new Set(rows.map(row => row.id)).size === 2, 'STREAM_TWO_TRACKS');
  ranges.sort((a, b) => a[0] - b[0]);
  need(ranges[0][0] === mdat.body && ranges.at(-1)[1] === mdat.end
    && ranges.every((range, i) => i === 0 || ranges[i - 1][1] === range[0]), 'STREAM_MDAT_COVERAGE');
  return { sequence, rows };
}
const u32 = value => { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result; };
const u64 = value => { const result = Buffer.alloc(8); result.writeBigUInt64BE(value); return result; };
function box(type, ...parts) { const payload = Buffer.concat(parts); return Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload]); }
const full = (type, version, flags, ...parts) => box(type, u32(version * 0x1000000 + flags), ...parts);
function writePart(video, audio, metadata, index) {
  const first = metadata.ordered.find(track => track.handler === 'vide'), second = metadata.ordered.find(track => track.handler === 'soun');
  const videoBytes = video.reduce((total, sample) => total + sample.data.length, 0);
  function moof(offset) {
    function traf(track, samples, start, canonical, dataOffset) {
      return box('traf', full('tfhd', 0, 0x020000, u32(track.id)), full('tfdt', 1, 0, u64(start)),
        full('trun', 0, 0x701, u32(samples.length), u32(dataOffset), ...samples.map(sample =>
          Buffer.concat([u32(canonical), u32(sample.data.length), u32(sample.flags)]))));
    }
    return box('moof', full('mfhd', 0, 0, u32(index + 1)),
      traf(first, video, BigInt(index) * VIDEO_TICKS, 3000, offset),
      traf(second, audio, BigInt(index) * AUDIO_TICKS, 1024, offset + videoBytes));
  }
  const header = moof(0); return Buffer.concat([moof(header.length + 8), box('mdat', ...video.map(sample => sample.data), ...audio.map(sample => sample.data))]);
}
function hashSamples(digest, samples) { for (const sample of samples) digest.update(u32(sample.data.length)).update(sample.data); }

export class StreamBlock {
  #clip; #data; #relative;
  constructor(init, data, index, metadata, video, audio, sourceClocks = null) {
    const rawStartSkew = audio[0].dts * 90000n - video[0].dts * 48000n;
    const rawEndSkew = (audio.at(-1).dts + BigInt(audio.at(-1).duration)) * 90000n
      - (video.at(-1).dts + BigInt(video.at(-1).duration)) * 48000n;
    let startSkew = rawStartSkew, endSkew = rawEndSkew; const correction = {};
    if (sourceClocks) {
      // Remove only globally proven timestamp quantization, retaining the same fixed AV-origin offset.
      // Reason: raw RTMP millisecond video edges can oscillate by 0.667ms around a valid 21ms offset; measuring that rounding twice falsely rejects sample-preserving remux. Unknown/mixed clocks still use the raw guard.
      for (const [handler, values, count, canonical, factor, sign] of [
        ['vide', video, 16, 3000, 48000n, 1n], ['soun', audio, 25, 1024, 90000n, -1n]]) {
        const track = metadata.ordered.find(value => value.handler === handler), origin = sourceClocks.get(track.id).first;
        const start = values[0].dts - (origin + BigInt(index * count * canonical));
        const end = values.at(-1).dts + BigInt(values.at(-1).duration) - (origin + BigInt((index + 1) * count * canonical));
        need(abs(start) * 1000n <= BigInt(track.timescale) && abs(end) * 1000n <= BigInt(track.timescale), 'STREAM_SOURCE_PREFIX_DRIFT');
        startSkew += sign * start * factor; endSkew += sign * end * factor;
        correction[handler] = { start_ms: Number(start) / track.timescale * 1000, end_ms: Number(end) / track.timescale * 1000 };
      }
    }
    // Keep the joint AV gate at every newly playable boundary, not only at request start/end.
    // Reason: the existing one-AAC-unit synchronization budget is unchanged; only coherent source-clock rounding is measured in its canonical basis rather than counted as extra AV drift.
    need(abs(startSkew) <= 1024n * 90000n && abs(endSkew) <= 1024n * 90000n, 'STREAM_BLOCK_BOUNDARY_SKEW');
    // The original strict parser is a second gate per complete block, not per whole utterance.
    // Reason: streaming must retain the canonical decoder/sample contract without waiting for final speech.
    this.#clip = new EncodedClip(Buffer.concat([init, data]), { maxDurationSeconds: 1 }); this.#data = Buffer.from(data);
    this.#relative = new Map(metadata.ordered.map(track => [track.id, BigInt(index) * (track.handler === 'vide' ? VIDEO_TICKS : AUDIO_TICKS)]));
    this.index = index; this.durationSeconds = this.#clip.durationSeconds; this.mime = this.#clip.mime;
    this.compatibilitySignature = this.#clip.compatibilitySignature; this.tracks = this.#clip.tracks;
    this.receipt = Object.freeze({ video_samples: 16, audio_samples: 25,
      source_start_audio_minus_video_ms: Number(rawStartSkew) / 90000 / 48000 * 1000,
      source_end_audio_minus_video_ms: Number(rawEndSkew) / 90000 / 48000 * 1000,
      normalized_source_start_audio_minus_video_ms: Number(startSkew) / 90000 / 48000 * 1000,
      normalized_source_end_audio_minus_video_ms: Number(endSkew) / 90000 / 48000 * 1000,
      boundary_clock_basis: sourceClocks ? 'proven_source_clock_to_canonical' : 'raw_unknown_clock',
      boundary_prefix_correction_ms: Object.freeze(correction),
      video_sample_sha256: Object.freeze(video.map(sample => sha(sample.data))), audio_sample_sha256: Object.freeze(audio.map(sample => sha(sample.data))) });
    Object.freeze(this);
  }
  get data() { return Buffer.from(this.#data); }
  get init() { return this.#clip.init; }
  get byteLength() { return this.#data.length; }
  get relativeStartTicks() { return new Map(this.#relative); }
  rewrite(sequence, utteranceBases) {
    const starts = new Map(this.tracks.map(track => {
      const base = utteranceBases?.get(track.id); need(typeof base === 'bigint' && base >= 0n, 'STREAM_TRACK_BASE');
      return [track.id, base + this.#relative.get(track.id)];
    }));
    return this.#clip.rewrite(0, sequence, starts);
  }
}

export class FragmentStream {
  #sourceInit; #init; #metadata = null; #configs; #video = []; #audio = []; #pendingBytes = 0;
  #sourceSequence = null; #clocks = new Map(); #blocks = 0; #inputBytes; #parts = 0; #failed = null; #finished = null;
  #firstSequence = null; #sourceHash = createHash('sha256');
  #inputHash = { video: createHash('sha256'), audio: createHash('sha256') };
  #outputHash = { video: createHash('sha256'), audio: createHash('sha256') };
  #outputCounts = { video: 0, audio: 0 }; #startSkew = null; #compatibility = null; #boundaryClockProven = null;
  constructor({ init, mime, compatibilitySignature = null, maxPendingBytes = 16 * 1024 * 1024,
    maxBytes = HARD_BYTES, maxFragments = 225 } = {}) {
    need(Buffer.isBuffer(init) && init.length > 16 && init.length <= 1024 * 1024, 'STREAM_INIT_LIMIT');
    need(typeof mime === 'string' && mime.length < 128 && (compatibilitySignature === null || /^[a-f0-9]{64}$/.test(compatibilitySignature)), 'STREAM_CONTRACT');
    need(Number.isSafeInteger(maxPendingBytes) && maxPendingBytes > 0 && maxPendingBytes <= 16 * 1024 * 1024
      && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= HARD_BYTES
      && Number.isSafeInteger(maxFragments) && maxFragments > 0 && maxFragments <= 225, 'STREAM_LIMIT_OPTIONS');
    this.#sourceInit = Buffer.from(init); this.#inputBytes = init.length;
    this.#sourceHash.update(this.#sourceInit);
    this.mime = mime; this.expectedCompatibilitySignature = compatibilitySignature;
    this.maxPendingBytes = maxPendingBytes; this.maxBytes = maxBytes; this.maxFragments = maxFragments;
    Object.freeze(this);
  }
  #fail(error) {
    this.#failed = /^\w{1,64}$/.test(error?.code || '') ? error.code : 'STREAM_FAILED';
    this.#video = []; this.#audio = []; this.#pendingBytes = 0; throw mediaError(this.#failed);
  }
  push(data) {
    need(!this.#failed && !this.#finished, 'STREAM_CLOSED');
    try {
      need(Buffer.isBuffer(data) && data.length > 16 && data.length <= PART_BYTES
        && this.#inputBytes + data.length <= this.maxBytes && this.#parts < this.maxFragments, 'STREAM_INPUT_LIMIT');
      if (!this.#metadata) {
        // Reuse the production init/codec parser once on the first actual fragment.
        // Reason: a second independent implementation of ESDS/avcC identity would drift from the already strict clip contract.
        const parsed = readQuantizedReply(Buffer.concat([this.#sourceInit, data]));
        need(!parsed.hasTrailer && parsed.parts.length === 1 && parsed.metadata.mime === this.mime, 'STREAM_INIT_CONTRACT');
        this.#metadata = parsed.metadata; this.#init = Buffer.from(this.#sourceInit);
        for (const track of this.#metadata.ordered) {
          this.#init.writeUInt32BE(track.handler === 'vide' ? 3000 : 1024, this.#metadata.trexDurationOffsets.get(track.id));
          this.#clocks.set(track.id, { first: null, end: null, samples: 0, ticks: 0n, maxPrefix: 0n,
            canonical: true, phases: [0, 1, 2], model: null });
        }
        this.#configs = parameters(this.#metadata.ordered.find(track => track.handler === 'vide').configuration);
      }
      const part = parsePart(data, this.#metadata, this.#configs);
      need(this.#sourceSequence === null || part.sequence === this.#sourceSequence + 1, 'STREAM_SOURCE_SEQUENCE_GAP');
      for (const row of part.rows) {
        const clock = this.#clocks.get(row.id), canonical = row.handler === 'vide' ? 3000 : 1024;
        need(clock.end === null || row.dts === clock.end, 'STREAM_SOURCE_DTS_GAP');
        if (clock.first === null) clock.first = row.dts;
        for (const sample of row.samples) {
          const floor = row.handler === 'vide' ? 2970 : 1008, ceil = row.handler === 'vide' ? 3060 : 1056;
          const pattern = [floor, floor, ceil], index = clock.samples;
          clock.phases = clock.phases.filter(phase => sample.duration === pattern[(index + phase) % 3]);
          clock.canonical &&= sample.duration === canonical;
          clock.samples++; clock.ticks += BigInt(sample.duration);
          const error = abs(clock.ticks - BigInt(clock.samples * canonical));
          // The prefix budget is global across all fragments, never reset per short block.
          // Reason: individually plausible millisecond rounding must not accumulate long-running speech drift.
          need(error * 1000n <= BigInt(row.timescale), 'STREAM_SOURCE_PREFIX_DRIFT');
          if (error > clock.maxPrefix) clock.maxPrefix = error;
        }
        if (clock.model === 'canonical') need(clock.canonical, 'STREAM_SOURCE_CLOCK_FAMILY_CHANGED');
        if (clock.model === 'rtmp_ms_period3') need(clock.phases.length > 0, 'STREAM_SOURCE_CLOCK_FAMILY_CHANGED');
        clock.end = row.dts + row.ticks;
        const name = row.handler === 'vide' ? 'video' : 'audio'; hashSamples(this.#inputHash[name], row.samples);
        if (name === 'video') this.#video.push(...row.samples); else this.#audio.push(...row.samples);
        this.#pendingBytes += row.samples.reduce((total, sample) => total + sample.data.length, 0);
      }
      const video = this.#metadata.ordered.find(track => track.handler === 'vide'), audio = this.#metadata.ordered.find(track => track.handler === 'soun');
      const skew = this.#clocks.get(audio.id).first * 90000n - this.#clocks.get(video.id).first * 48000n;
      need(abs(skew) <= 1024n * 90000n, 'STREAM_SOURCE_START_SKEW'); this.#startSkew = Number(skew) / 90000 / 48000 * 1000;
      // Hold only bounded encoded samples while audio packet grouping catches up.
      // Reason: 24/26 AAC interleaving is not permission to manufacture a 25th sample or grow an unbounded speech queue.
      need(this.#pendingBytes <= this.maxPendingBytes && this.#video.length <= 64 && this.#audio.length <= 100, 'STREAM_PENDING_LIMIT');
      this.#firstSequence ??= part.sequence; this.#sourceSequence = part.sequence;
      this.#inputBytes += data.length; this.#parts++; this.#sourceHash.update(data);
      const result = [];
      while (this.#video.length >= VIDEO_SAMPLES && this.#audio.length >= AUDIO_SAMPLES) {
        if (this.#boundaryClockProven === null) {
          // Bind one clock model for this whole request, not separately at each fragment.
          // Reason: canonical or coherent three-phase RTMP rounding has a provable correction; arbitrary mixed durations must retain the original raw joint guard and cannot borrow a new phase to hide drift.
          this.#boundaryClockProven = this.#metadata.ordered.every(track => {
            const clock = this.#clocks.get(track.id);
            return clock.canonical || (clock.phases.length > 0 && clock.first % BigInt(track.timescale / 1000) === 0n);
          });
          if (this.#boundaryClockProven) for (const clock of this.#clocks.values()) clock.model = clock.canonical ? 'canonical' : 'rtmp_ms_period3';
        }
        const v = this.#video.splice(0, VIDEO_SAMPLES), a = this.#audio.splice(0, AUDIO_SAMPLES);
        const block = new StreamBlock(this.#init, writePart(v, a, this.#metadata, this.#blocks), this.#blocks, this.#metadata, v, a,
          this.#boundaryClockProven ? this.#clocks : null);
        need(this.expectedCompatibilitySignature === null || block.compatibilitySignature === this.expectedCompatibilitySignature, 'STREAM_DECODER_INCOMPATIBLE');
        need(this.#compatibility === null || block.compatibilitySignature === this.#compatibility, 'STREAM_DECODER_INCOMPATIBLE');
        this.#compatibility = block.compatibilitySignature;
        hashSamples(this.#outputHash.video, v); hashSamples(this.#outputHash.audio, a);
        this.#outputCounts.video += v.length; this.#outputCounts.audio += a.length;
        this.#pendingBytes -= [...v, ...a].reduce((total, sample) => total + sample.data.length, 0);
        this.#blocks++; result.push(block);
      }
      return result;
    } catch (error) { return this.#fail(error); }
  }
  get init() { need(this.#metadata && !this.#failed, 'STREAM_NOT_READY'); return Buffer.from(this.#init); }
  finish() {
    need(!this.#failed && !this.#finished, 'STREAM_CLOSED');
    try {
      need(this.#blocks > 0 && this.#video.length === 0 && this.#audio.length === 0, 'STREAM_INCOMPLETE_TAIL');
      const input = {}, output = {}, prefix = {};
      for (const name of ['video', 'audio']) {
        input[name] = this.#inputHash[name].digest('hex'); output[name] = this.#outputHash[name].digest('hex');
        need(input[name] === output[name], 'STREAM_SAMPLE_PAYLOAD_CHANGED');
        const track = this.#metadata.ordered.find(track => track.handler === (name === 'video' ? 'vide' : 'soun'));
        prefix[name] = Number(this.#clocks.get(track.id).maxPrefix) / track.timescale * 1000;
      }
      this.#finished = Object.freeze({ status: 'strict_stream_blocks_verified_not_playback_acceptance', blocks: this.#blocks,
        video_samples: this.#outputCounts.video, audio_samples: this.#outputCounts.audio, input_bytes: this.#inputBytes,
        sample_bytes_unchanged: true, per_track_order_unchanged: true, original_mdat_container_unchanged: false,
        input_sample_sha256: Object.freeze(input), output_sample_sha256: Object.freeze(output), max_prefix_correction_ms: Object.freeze(prefix),
        sample_digest_algorithm: 'sha256(concat(uint32_be_sample_length,sample_bytes))_per_track',
        source_included_sha256: this.#sourceHash.digest('hex'), source_init_sha256: sha(this.#sourceInit), canonical_init_sha256: sha(this.#init),
        source_sequence_first: this.#firstSequence, source_sequence_last: this.#sourceSequence,
        source_track_clocks: Object.freeze(this.#metadata.ordered.map(track => Object.freeze({ id: track.id, handler: track.handler,
          timescale: track.timescale, first_dts_ticks: this.#clocks.get(track.id).first.toString(), end_dts_ticks: this.#clocks.get(track.id).end.toString() }))),
        source_start_audio_minus_video_ms: this.#startSkew, constant_start_offset_removed_once: true,
        boundary_audio_tick_limit: 1024, boundary_clock_proven: this.#boundaryClockProven,
        source_clock_models: Object.freeze(this.#metadata.ordered.map(track => Object.freeze({ handler: track.handler,
          model: this.#clocks.get(track.id).model || 'mixed_raw_guard' }))),
        subjective_lipsync: 'not_verified', compatibility_signature: this.#compatibility });
      return this.#finished;
    } catch (error) { return this.#fail(error); }
  }
  snapshot() {
    return { source_fragments: this.#parts, blocks: this.#blocks, input_bytes: this.#inputBytes,
      pending_bytes: this.#pendingBytes, pending_video_samples: this.#video.length, pending_audio_samples: this.#audio.length,
      failed_code: this.#failed, finished: Boolean(this.#finished) };
  }
}
