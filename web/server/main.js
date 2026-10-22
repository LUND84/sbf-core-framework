import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { loadIdlePlaylist } from './idle-playlist.js';
import { loadStreamIdlePlaylist } from './stream-idle-playlist.js';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);
const config = readConfig();
// Load and hash every local clip before listening. Reason: an enabled but incompatible playlist must fail closed instead of exposing a black preview.
const idlePlaylist = config.idlePlaylistManifest
  ? await (config.replyMediaMode === 'streamed-replies-v1' ? loadStreamIdlePlaylist : loadIdlePlaylist)(
    config.idlePlaylistManifest, config.idlePlaylistManifestSha256) : null;
const app = createApp(config, { idlePlaylist });
app.server.listen(config.port, config.host, () => {
  console.log(`SBF demo listening on ${config.host}:${app.server.address().port}`);
  console.log(`Viewer access: ${config.accessCode ? 'protected' : 'local development'}; GPU worker: ${config.workerToken ? 'token configured' : 'disabled'}`);
});
app.broker.on('workerError', (message) => console.error(`GPU service: ${message}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref();
  await app.close();
  process.exit(0);
});
