// Structural test media only; not decodable artwork. Reason: metadata/pacing tests must not synthesize speech or claim visual validation.
export function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64BE(value); return b; }
export function box(type, ...parts) {
  const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]);
}
function full(type, version, flags, ...parts) { return box(type, u32(version * 0x1000000 + flags), ...parts); }
function descriptor(tag, data) { return Buffer.concat([Buffer.from([tag, data.length]), data]); }
function track(id, handler, timescale, extra) {
  const tkhd = Buffer.alloc(80); tkhd.writeUInt32BE(id, 8);
  const mdhd = Buffer.alloc(20); mdhd.writeUInt32BE(timescale, 8);
  const hdlr = Buffer.alloc(24); hdlr.write(handler, 4);
  const entry = Buffer.alloc(handler === 'vide' ? 78 : 28); entry.writeUInt16BE(1, 6);
  let config, type;
  if (handler === 'vide') {
    entry.writeUInt16BE(1920, 24); entry.writeUInt16BE(1080, 26); type = 'avc1';
    config = box('avcC', Buffer.from([1, 77, 0, 42, 255, 225, 0, 4, 0x67, 77, 0, 42, 1, 0, 2, 0x68, extra]));
  } else {
    entry.writeUInt16BE(2, 16); entry.writeUInt32BE(48000 * 65536, 24); type = 'mp4a';
    const header = Buffer.alloc(13); header[0] = 0x40; header[1] = 0x15;
    config = full('esds', 0, 0, descriptor(3, Buffer.concat([Buffer.from([0, 1, 0]),
      descriptor(4, Buffer.concat([header, descriptor(5, Buffer.from([0x11, 0x90]))])), descriptor(6, Buffer.from([2]))])));
  }
  return box('trak', full('tkhd', 0, 3, tkhd), box('mdia', full('mdhd', 0, 0, mdhd), full('hdlr', 0, 0, hdlr),
    box('minf', box('stbl', full('stsd', 0, 0, u32(1), box(type, entry, config))))));
}
function init(extra) {
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isomiso6')),
    box('moov', full('mvhd', 0, 0, Buffer.alloc(96)), track(1, 'vide', 90000, extra), track(2, 'soun', 48000, 0),
      box('mvex', ...[1, 2].map((id) => full('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0)))))]);
}
function part({ marker, index, audioCount, audioBase, audioSkew, dtsGap, cto, firstIdr, videoCount }) {
  const video = Array.from({ length: videoCount }, (_, i) => Buffer.concat([u32(2), Buffer.from([i === 0 && firstIdr ? 0x65 : 0x61, marker])]));
  const audio = Array.from({ length: audioCount }, () => Buffer.from([0x21, marker]));
  function make(offset) {
    function traf(id, samples, start, duration, dataOffset) {
      const runs = samples.map((sample, i) => Buffer.concat([u32(duration), u32(sample.length),
        u32(id === 1 && !(i === 0 && firstIdr) ? 0x01010000 : 0x02000000), ...(cto ? [u32(cto)] : [])]));
      return box('traf', full('tfhd', 0, 0x020000, u32(id)), full('tfdt', 1, 0, u64(start)),
        full('trun', 0, 0x701 | (cto ? 0x800 : 0), u32(samples.length), u32(dataOffset), ...runs));
    }
    return box('moof', full('mfhd', 0, 0, u32(71 + index)),
      traf(1, video, BigInt(index * videoCount * 3000 + (index ? dtsGap : 0)), 3000, offset),
      traf(2, audio, BigInt(audioBase + audioSkew), 1024, offset + video.reduce((n, v) => n + v.length, 0)));
  }
  const moof = make(0), actual = make(moof.length + 8);
  return Buffer.concat([actual, box('mdat', ...video, ...audio)]);
}
export function clipBytes({ marker = 1, parts = 2, audioCount = 25, audioSkew = 0, dtsGap = 0,
  cto = 0, firstIdr = true, extra = 0, videoCount = 16, audioCounts = null } = {}) {
  return Buffer.concat([init(extra), ...Array.from({ length: parts }, (_, index) =>
    part({ marker, index, audioCount: audioCounts?.[index] ?? audioCount,
      audioBase: (audioCounts ? audioCounts.slice(0, index).reduce((a, b) => a + b, 0) : index * audioCount) * 1024,
      audioSkew, dtsGap, cto, firstIdr, videoCount }))]);
}
// Independent field reads for expected outputs, without calling the production parser.
export function fragmentFields(bytes) {
  const positions = []; let from = 0;
  while ((from = bytes.indexOf(Buffer.from('tfdt'), from)) !== -1) { positions.push(bytes.readBigUInt64BE(from + 8)); from++; }
  const mfhd = bytes.indexOf(Buffer.from('mfhd')), mdat = bytes.indexOf(Buffer.from('mdat'));
  return { sequence: bytes.readUInt32BE(mfhd + 8), dts: positions, payload: bytes.subarray(mdat + 4) };
}
