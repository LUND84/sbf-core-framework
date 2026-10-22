import { createHash } from 'node:crypto';
import { EncodedClip, mediaError, readQuantizedReply } from './local-fmp4.js';

const MAX_BYTES = 64 * 1024 ** 2;
const abs = (value) => value < 0n ? -value : value;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function need(value, code) { if (!value) throw mediaError(code); }
function identity(input, options) {
  need(Buffer.isBuffer(input) && input.length > 0 && input.length <= MAX_BYTES, 'CLIP_BYTE_LIMIT');
  need(typeof options.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(options.requestId), 'REPLY_REQUEST_ID');
  need(typeof options.sourceEpoch === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(options.sourceEpoch), 'REPLY_SOURCE_EPOCH');
  need(options.silent === undefined || options.silent === false, 'REPLY_SILENCE_OVERRIDE_FORBIDDEN');
  need(options.width === 1920 && options.height === 1080 && options.fps === 30, 'REPLY_DECLARED_VIDEO_SPEC');
  need(options.bytes === input.length, 'REPLY_UPLOAD_SIZE_MISMATCH');
  const hash = sha(input);
  need(typeof options.sha256 === 'string' && /^[a-f0-9]{64}$/.test(options.sha256) && options.sha256 === hash, 'REPLY_UPLOAD_SHA_MISMATCH');
  return hash;
}
export function normalizeSealedReply(input, options = {}) {
  const sourceHash = identity(input, options), parsed = readQuantizedReply(input);
  need(!parsed.hasTrailer, 'REPLY_UNSUPPORTED_TRAILER');
  need(options.mime === parsed.metadata.mime, 'REPLY_DECLARED_MIME_MISMATCH');
  const video = parsed.metadata.ordered.find((v) => v.handler === 'vide');
  const audio = parsed.metadata.ordered.find((v) => v.handler === 'soun');
  const counts = new Map(), starts = new Map(), ends = new Map(), clocks = new Map();
  for (const part of parsed.parts) for (const row of part.rows) {
    if (row.handler === 'vide') need(row.firstSync, 'REPLY_FRAGMENT_MUST_START_IDR');
    if (!starts.has(row.id)) starts.set(row.id, row.dts);
    else need(ends.get(row.id) === row.dts, 'CLIP_DTS_GAP');
    ends.set(row.id, row.dts + row.ticks); counts.set(row.id, (counts.get(row.id) ?? 0) + row.count);
  }
  const blocks = counts.get(video.id) / 240, seconds = blocks * 8;
  // No sample can be added or removed to reach this join. Reason: a spoken reply must retain every encoded frame and AAC access unit, including pre-roll and its entire tail.
  need(Number.isInteger(blocks) && blocks >= 1 && blocks <= 15 && counts.get(audio.id) === blocks * 375, 'REPLY_SAMPLE_COUNTS');
  const scale = BigInt(video.timescale), boundaryLimit = 1024n * scale;
  const skew = (points) => points.get(audio.id) * scale - points.get(video.id) * 48000n;
  need(abs(skew(starts)) <= boundaryLimit && abs(skew(ends)) <= boundaryLimit, 'REPLY_BOUNDARY_SKEW');
  for (const track of parsed.metadata.ordered) {
    const expected = BigInt(seconds * track.timescale);
    // Endpoints alone are insufficient; this span gate is followed by every-prefix checks below.
    // Reason: balanced but large interior shifts can preserve total duration while changing speech timing.
    need(abs(ends.get(track.id) - starts.get(track.id) - expected) * 1000n <= BigInt(track.timescale), 'REPLY_SOURCE_SPAN');
    clocks.set(track.id, { id: track.id, handler: track.handler, timescale: track.timescale,
      samples: 0, originalTicks: 0n, maxPrefix: 0n, maxSample: 0 });
  }
  for (const part of parsed.parts) for (const row of part.rows) {
    const clock = clocks.get(row.id);
    for (const duration of row.sampleDurationTicks) {
      clock.samples++; clock.originalTicks += BigInt(duration);
      const error = abs(clock.originalTicks - BigInt(clock.samples) * BigInt(row.canonicalDuration));
      // Reject cumulative drift at every boundary, not just clip ends. Reason: normalization must remove bounded RTMP quantization rather than stretch an unknown spoken interval.
      need(error * 1000n <= BigInt(row.timescale), 'REPLY_SOURCE_PREFIX_DRIFT');
      if (error > clock.maxPrefix) clock.maxPrefix = error;
      clock.maxSample = Math.max(clock.maxSample, Math.abs(duration - row.canonicalDuration));
    }
  }
  let correctionCount = 0; const fieldsChanged = {}, payloads = [];
  function change(buffer, offset, width, value, field) {
    const before = width === 8 ? buffer.readBigUInt64BE(offset) : BigInt(buffer.readUInt32BE(offset));
    const next = BigInt(value); if (before === next) return;
    if (width === 8) buffer.writeBigUInt64BE(next, offset); else buffer.writeUInt32BE(Number(next), offset);
    correctionCount++; fieldsChanged[field] = (fieldsChanged[field] ?? 0) + 1;
  }
  const init = Buffer.from(parsed.init);
  for (const track of parsed.metadata.ordered) change(init, parsed.metadata.trexDurationOffsets.get(track.id), 4,
    track.handler === 'vide' ? 3000 : 1024, 'trex.default_sample_duration');
  const next = new Map([[video.id, 0n], [audio.id, 0n]]), parts = [];
  for (let index = 0; index < parsed.parts.length; index++) {
    const part = parsed.parts[index], bytes = Buffer.from(part.data);
    change(bytes, part.sequenceOffset, 4, index + 1, 'mfhd.sequence_number');
    for (const row of part.rows) {
      for (const field of row.durationFields) change(bytes, field.offset, 4, row.canonicalDuration, field.field);
      change(bytes, row.tfdtOffset, 8, next.get(row.id), 'tfdt.base_media_decode_time');
      next.set(row.id, next.get(row.id) + BigInt(row.count) * BigInt(row.canonicalDuration));
    }
    const original = part.data.subarray(part.mdatPayloadOffset), normalized = bytes.subarray(part.mdatPayloadOffset);
    need(original.equals(normalized), 'REPLY_PAYLOAD_CHANGED');
    payloads.push({ fragment: index + 1, bytes: original.length, sha256: sha(original) }); parts.push(bytes);
  }
  const bytes = Buffer.concat([init, ...parts]); need(bytes.length === input.length, 'REPLY_LENGTH_CHANGED');
  // Reuse the original strict playback gate after all header edits. Reason: the rounding reader cannot authorize queue admission or relax canonical media clocks.
  const clip = new EncodedClip(bytes, { maxBytes: MAX_BYTES, maxDurationSeconds: 120 });
  need(clip.durationSeconds === seconds, 'REPLY_STRICT_DURATION');
  const skewMs = (value) => Number(value) / video.timescale / 48000 * 1000;
  return { bytes, clip, receipt: {
    status: 'sealed_reply_normalized_strict', request_id: options.requestId, source_epoch: options.sourceEpoch,
    source_sha256: sourceHash, normalized_sha256: sha(bytes), bytes: bytes.length, mime: clip.mime,
    width: 1920, height: 1080, fps: 30, silent_declared: false, subjective_speech_sync: 'not_verified',
    video_samples: counts.get(video.id), audio_access_units: counts.get(audio.id), duration_seconds: seconds, blocks,
    samples_added: 0, samples_removed: 0, mdat_unchanged: true, mdat_payloads: payloads,
    original_track_offsets: parsed.metadata.ordered.map((track) => ({ track_id: track.id, handler: track.handler,
      timescale: track.timescale, first_tfdt_ticks: starts.get(track.id).toString(), end_dts_ticks: ends.get(track.id).toString() })),
    source_start_audio_minus_video_ms: skewMs(skew(starts)), source_end_audio_minus_video_ms: skewMs(skew(ends)),
    normalized_audio_minus_video_ms: 0, timestamp_zeroing_relative_offset_limit_ms: 1024 / 48,
    track_clock_corrections: [...clocks.values()].map((clock) => ({ track_id: clock.id, handler: clock.handler,
      max_sample_quantization_correction_ms: clock.maxSample / clock.timescale * 1000,
      max_prefix_quantization_correction_ms: Number(clock.maxPrefix) / clock.timescale * 1000 })),
    metadata_corrections_count: correctionCount, metadata_corrections_by_field: fieldsChanged,
    limitations: [
      'No audio decoding, silence assertion, video decoding, pixel operation, re-encoding, trimming, repeated frame or invented sample.',
      'Each source sample and every cumulative per-track timestamp correction are bounded to one millisecond.',
      'Both tracks start at zero after normalization; this removes at most one AAC access-unit (21.333333ms) of original relative offset, recorded above.',
      'This bounded container synchronization budget is not a subjective spoken lipsync pass; the voice and visible mouth still require user review.',
      'Request and epoch identities are supplied by authenticated upload admission; this pure module cannot authenticate their external provenance.'
    ] } };
}
