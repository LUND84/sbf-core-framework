import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { FragmentStream } from './stream-fragments.js';
import { mediaError } from './local-fmp4.js';

const LIMIT = 64 * 1024 * 1024, sha = data => createHash('sha256').update(data).digest('hex');
function need(value, code) { if (!value) throw mediaError(code); }
async function readBounded(filename, limit) {
  const before = await lstat(filename); need(before.isFile() && !before.isSymbolicLink(), 'STREAM_IDLE_FILE_LINK');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); need(stat.isFile() && stat.size > 0 && stat.size <= limit, 'STREAM_IDLE_FILE_BOUND');
    // Read only the admitted size and reject mutation. Reason: an actively replaced or growing file cannot bypass the startup memory/hash contract.
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const result = await handle.read(data, offset, data.length - offset, offset); need(result.bytesRead > 0, 'STREAM_IDLE_FILE_CHANGED'); offset += result.bytesRead; }
    const after = await handle.stat();
    need(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'STREAM_IDLE_FILE_CHANGED'); return data;
  } finally { await handle.close(); }
}
function topBoxes(data) {
  const items = []; let offset = 0;
  while (offset < data.length) {
    need(items.length < 64 && offset + 8 <= data.length, 'STREAM_IDLE_BOX_BOUND');
    let size = data.readUInt32BE(offset), header = 8;
    if (size === 1) { need(offset + 16 <= data.length, 'STREAM_IDLE_BOX_BOUND'); const large = data.readBigUInt64BE(offset + 8); need(large <= BigInt(Number.MAX_SAFE_INTEGER), 'STREAM_IDLE_BOX_BOUND'); size = Number(large); header = 16; }
    need(size >= header && offset + size <= data.length, 'STREAM_IDLE_BOX_BOUND');
    items.push({ type: data.toString('ascii', offset + 4, offset + 8), start: offset, end: offset + size }); offset += size;
  }
  return items;
}
export async function loadStreamIdlePlaylist(filename, expectedSha = '') {
  need(typeof filename === 'string' && filename.length > 0 && (!expectedSha || /^[a-f0-9]{64}$/.test(expectedSha)), 'STREAM_IDLE_MANIFEST_PATH');
  const manifestBytes = await readBounded(filename, 65536), manifestSha256 = sha(manifestBytes);
  need(!expectedSha || manifestSha256 === expectedSha, 'STREAM_IDLE_MANIFEST_SHA');
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch { throw mediaError('STREAM_IDLE_MANIFEST_JSON'); }
  // This is a separate opt-in schema, not a relaxed old sealed schema. Reason: GOP16 blocks and the old GOP15/8-second sealing protocol have different clock/queue contracts.
  need(manifest.schema === 'sbf-stream-idle-v1' && manifest.status === 'stream_clock_verified_visual_pending'
    && Array.isArray(manifest.clips) && manifest.clips.length === 3, 'STREAM_IDLE_MANIFEST_SCHEMA');
  const root = dirname(await realpath(filename)), idleClips = [], receipts = [], hashes = new Set(); let init = null, mime = null, compatibilitySignature = null;
  for (const row of manifest.clips) {
    need(row && typeof row.file === 'string' && !isAbsolute(row.file) && /^[A-Za-z0-9_-]+\.mp4$/.test(row.file)
      && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes > 16 && row.bytes <= LIMIT
      && typeof row.mime === 'string' && row.mime.length < 128 && /^[a-f0-9]{64}$/.test(row.compatibility_signature)
      && row.blocks === 15, 'STREAM_IDLE_MEMBER');
    const path = resolve(root, row.file); need(path.startsWith(root + sep) && await realpath(path) === path, 'STREAM_IDLE_FILE_LINK');
    const data = await readBounded(path, LIMIT); need(data.length === row.bytes && sha(data) === row.sha256, 'STREAM_IDLE_MEMBER_SHA');
    need(!hashes.has(row.sha256), 'STREAM_IDLE_DUPLICATE'); hashes.add(row.sha256);
    const boxes = topBoxes(data);
    need(boxes.length === 32 && boxes[0].type === 'ftyp' && boxes[1].type === 'moov'
      && boxes.slice(2).every((box, index) => box.type === (index % 2 === 0 ? 'moof' : 'mdat')), 'STREAM_IDLE_FILE_LAYOUT');
    const sourceInit = data.subarray(0, boxes[1].end), stream = new FragmentStream({ init: sourceInit, mime: row.mime, compatibilitySignature: row.compatibility_signature });
    const blocks = [];
    for (let index = 2; index < boxes.length; index += 2) blocks.push(...stream.push(data.subarray(boxes[index].start, boxes[index + 1].end)));
    const receipt = stream.finish(), canonical = stream.init;
    need(blocks.length === 15 && receipt.video_samples === 240 && receipt.audio_samples === 375
      && receipt.source_included_sha256 === row.sha256, 'STREAM_IDLE_CLOCK');
    need(init === null || (sha(canonical) === sha(init) && row.mime === mime && row.compatibility_signature === compatibilitySignature), 'STREAM_IDLE_INCOMPATIBLE');
    init ??= canonical; mime ??= row.mime; compatibilitySignature ??= row.compatibility_signature; idleClips.push(blocks); receipts.push(receipt);
  }
  return { mode: 'streamed-replies-v1', init, mime, idleClips, compatibilitySignature, manifestSha256, receipts };
}
