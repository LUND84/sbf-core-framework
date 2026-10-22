import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { loadEncodedClip, mediaError } from './local-fmp4.js';

function need(value, code) { if (!value) throw mediaError(code); }
export async function loadIdlePlaylist(filename, expectedSha = '') {
  need(typeof filename === 'string' && filename.length > 0, 'IDLE_MANIFEST_PATH');
  const stat = await lstat(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536, 'IDLE_MANIFEST_BOUND');
  const bytes = await readFile(filename), sha256 = createHash('sha256').update(bytes).digest('hex');
  need(!expectedSha || expectedSha === sha256, 'IDLE_MANIFEST_SHA');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw mediaError('IDLE_MANIFEST_JSON'); }
  need(manifest.schema === 'sbf-sealed-idle-v1' && manifest.status === 'sealed_clock_verified_visual_pending'
    && Array.isArray(manifest.clips) && manifest.clips.length === 3, 'IDLE_MANIFEST_SCHEMA');
  // Resolve only manifest-local filenames and verify payload hashes independently. Reason: metadata cannot authorize traversal or self-certify unknown media bytes.
  const root = dirname(await realpath(filename)), clips = [];
  for (const row of manifest.clips) {
    need(typeof row.file === 'string' && !isAbsolute(row.file) && /^[A-Za-z0-9_-]+\.mp4$/.test(row.file)
      && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes), 'IDLE_MANIFEST_MEMBER');
    const clip = await loadEncodedClip(row.file, { root });
    need(clip.contentHash === row.sha256 && clip.byteLength === row.bytes && clip.durationSeconds === 8
      && clip.fragmentCount === 16 && clip.signature === row.decoder_signature && clip.mime === row.mime, 'IDLE_MEMBER_MISMATCH');
    clips.push(clip);
  }
  need(new Set(clips.map((v) => v.contentHash)).size === 3 && clips.every((v) => v.signature === clips[0].signature), 'IDLE_PLAYLIST_INCOMPATIBLE');
  return { clips, manifestSha256: sha256 };
}
