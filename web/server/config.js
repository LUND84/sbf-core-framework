import { randomBytes } from 'node:crypto';
import { readModuleCConfig } from './module-c/policies.js';

function integer(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const workerToken = env.WORKER_TOKEN ?? '';
  const accessCode = env.DEMO_ACCESS_CODE ?? '';
  const replyMediaMode = env.REPLY_MEDIA_MODE || 'sealed-replies';
  const xBroadcastId = env.X_BROADCAST_ID || '';
  if (xBroadcastId && !/^[A-Za-z0-9]{1,64}$/.test(xBroadcastId)) throw new Error('Invalid X_BROADCAST_ID');
  if (env.WEB_CHAT_ENABLED !== undefined && !['1', '0', 'true', 'false'].includes(env.WEB_CHAT_ENABLED)) {
    throw new Error('Invalid WEB_CHAT_ENABLED');
  }
  if (!['sealed-replies', 'streamed-replies-v1'].includes(replyMediaMode)) throw new Error('Invalid REPLY_MEDIA_MODE');
  if (replyMediaMode === 'streamed-replies-v1' && !env.IDLE_PLAYLIST_MANIFEST) throw new Error('Streaming requires a local idle playlist');
  // Five-character viewer codes are supported at the user's request. Reason: viewer-code policy must permit the explicitly selected code without changing worker authentication.
  if (production && (workerToken.length < 24 || accessCode.length < 5)) {
    throw new Error('Production requires WORKER_TOKEN (24+ characters) and DEMO_ACCESS_CODE (5+ characters)');
  }
  return {
    moduleC: readModuleCConfig(env),
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 8080, 0, 65535),
    production,
    workerToken,
    accessCode,
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    publicOrigin: env.PUBLIC_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === 'true',
    // Trial stays off until the isolated transport passes. Reason: a diagnostic route must not replace the established MSE audience path by default.
    webRtcTrialEnabled: env.WEBRTC_TRIAL_ENABLED === '1',
    maxViewers: integer(env, 'MAX_VIEWERS', 12, 1, 100),
    maxQueue: integer(env, 'MAX_QUEUE', 8, 1, 100),
    chatTimeoutMs: integer(env, 'CHAT_TIMEOUT_MS', 120000, 100, 600000),
    // This gap follows complete playback, never token generation.
    // Reason: background crypto narration must yield between bounded video turns.
    autonomousGapMs: integer(env, 'AUTONOMOUS_GAP_MS', 1000, 0, 60000),
    // Enable only beside the independently published actor-continuous stream.
    // Reason: control-only workers must be gated by actual external media progress.
    continuousActorEnabled: env.CONTINUOUS_ACTOR_ENABLED === '1',
    // Opt in only after playlist validation. Reason: existing continuous deployments must retain their current startup and media behavior.
    idlePlaylistManifest: env.IDLE_PLAYLIST_MANIFEST || '',
    idlePlaylistManifestSha256: env.IDLE_PLAYLIST_MANIFEST_SHA256 || '',
    replyMediaMode,
    replyUploadTimeoutMs: integer(env, 'REPLY_UPLOAD_TIMEOUT_MS', 60000, 100, 120000),
    maxClientBufferedBytes: 4 * 1024 * 1024,
    maxCachedMediaBytes: 6 * 1024 * 1024,
    maxTextLength: 1000,
    xBroadcastId,
    // Web input stays compatible unless a deployment explicitly selects platform-only interaction.
    // Reason: the user's X broadcast can disable website chat without changing local defaults or collector access.
    webChatEnabled: !['0', 'false'].includes(env.WEB_CHAT_ENABLED ?? 'true'),
  };
}
