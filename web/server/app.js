import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Broker } from './broker.js';
import { createAuth, RateLimiter } from './auth.js';
import { PlaybackReports } from './playback-reports.js';
import { createWebRtcProxy } from './webrtc-proxy.js';
import { PlatformChat } from './platform-chat.js';
import { createModuleCRoutes } from './module-c/routes.js';
import { readModuleCConfig } from './module-c/policies.js';

const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createApp(config, options = {}) {
  const broker = new Broker(config, options);
  const auth = createAuth(config);
  const platformChat = new PlatformChat(broker, config, auth, options.platformChatOptions);
  const moduleCRoutes = createModuleCRoutes(config.moduleC || readModuleCConfig({}), broker, auth,
    { json, readJson, ...options.moduleCOptions });
  const webRtcProxy = createWebRtcProxy(auth, options.webRtcProxy);
  const playbackReports = new PlaybackReports();
  const loginLimiter = new RateLimiter(10, 60000);
  const chatLimiter = new RateLimiter(20, 60000);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false });

  const server = createServer(async (request, response) => {
    applyHeaders(response);
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (await moduleCRoutes.handle(request, response, path)) return;
      if (path === '/api/platform-chat') {
        platformChat.authorize(request);
        if (request.url !== '/api/platform-chat') return json(response, 400, { error: 'PLATFORM_PATH_INVALID' });
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST'); return json(response, 405, { error: 'PLATFORM_METHOD_INVALID' });
        }
        const result = platformChat.submit(await readJson(request));
        return json(response, result.statusCode, result.receipt);
      }
      if (path.startsWith('/api/webrtc') || request.url.startsWith('/api/webrtc')) {
        if (!config.webRtcTrialEnabled) return json(response, 404, { error: 'Not found' });
        return await webRtcProxy.handle(request, response);
      }
      if (path.startsWith('/webrtc-trial/') && !config.webRtcTrialEnabled) {
        return json(response, 404, { error: 'Not found' });
      }
      if (request.method === 'GET' && path === '/api/playback-report') {
        // Operator reads require the worker bearer, never the shared viewer cookie. Reason: one viewer must not inspect other tabs' reports.
        if (!auth.worker(request)) return json(response, 401, { error: '需要运维验证。' });
        return json(response, 200, playbackReports.snapshot());
      }
      if (request.method === 'GET' && path === '/api/status') return json(response, 200, broker.status());
      if (request.method === 'GET' && path === '/api/auth') return json(response, 200,
        { authenticated: auth.viewer(request), authRequired: Boolean(config.accessCode) });
      if (request.method === 'GET' && path === '/api/media') {
        if (!auth.viewer(request)) return json(response, 401, { error: '请输入演示访问码。' });
        return broker.attachHttpViewer(response);
      }
      if (request.method === 'GET' && path === '/healthz') return json(response, 200, { ok: true });
      if (request.method === 'POST' && path.startsWith('/api/')) {
        if (!auth.origin(request)) return json(response, 403, { error: '请求来源不被允许。' });
        const ip = request.socket.remoteAddress || 'unknown';
        if (path === '/api/login') {
          if (!loginLimiter.allow(ip)) return json(response, 429, { error: '尝试次数过多，请稍后再试。' });
          const body = await readJson(request);
          const cookie = auth.login(body.code, auth.isSecure(request));
          if (!cookie) return json(response, 401, { error: '访问码不正确。' });
          response.setHeader('Set-Cookie', cookie);
          return json(response, 200, { ok: true });
        }
        if (!auth.viewer(request)) return json(response, 401, { error: '请输入演示访问码。' });
        if (path === '/api/playback-report') {
          playbackReports.add(await readJson(request), broker.status());
          return json(response, 202, { ok: true });
        }
        if (path === '/api/chat') {
          if (config.webChatEnabled === false) return json(response, 403, { error: 'WEB_CHAT_DISABLED' });
          if (!chatLimiter.allow(ip)) return json(response, 429, { error: '发送过快，请稍后再试。' });
          const body = await readJson(request);
          if (typeof body.text !== 'string' || !body.text.trim()
            || body.text.trim().length > config.maxTextLength) {
            return json(response, 400, { error: `请输入 1–${config.maxTextLength} 字的内容。` });
          }
          return json(response, 202, broker.submit(body.text.trim()));
        }
        if (path === '/api/interrupt') {
          if (config.moduleC?.enabled && !auth.worker(request)) return json(response, 403, { error: 'OPERATOR_AUTH_REQUIRED' });
          broker.interrupt();
          return json(response, 200, { ok: true });
        }
        if (path === '/api/autonomous') {
          if (!chatLimiter.allow(ip)) return json(response, 429, { error: '操作过快，请稍后再试。' });
          const body = await readJson(request);
          if (typeof body.enabled !== 'boolean') return json(response, 400, { error: 'enabled 必须为布尔值。' });
          return json(response, 200, broker.autonomous.setEnabled(body.enabled));
        }
        return json(response, 404, { error: '接口不存在。' });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      await serveFile(path, request, response);
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode || 500,
        { error: error.statusCode ? error.message : '服务暂时不可用。' });
      else response.destroy();
    }
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return reject(socket, 400); }
    const path = url.pathname;
    if (path === '/ws/worker') {
      if (!auth.worker(request)) return reject(socket, 401);
      sockets.handleUpgrade(request, socket, head, (ws) => broker.attachWorker(ws));
    } else if (path === '/ws/viewer') {
      if (!auth.origin(request)) return reject(socket, 403);
      if (!auth.viewer(request)) return reject(socket, 401);
      sockets.handleUpgrade(request, socket, head, (ws) => broker.attachViewer(ws,
        { chunks: url.searchParams.get('chunks') === '1' }));
    } else reject(socket, 404);
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15000);
  heartbeat.unref();
  sockets.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
  });
  // handleUpgrade callbacks do not emit connection automatically.
  const upgrade = sockets.handleUpgrade.bind(sockets);
  sockets.handleUpgrade = (request, socket, head, callback) => upgrade(request, socket, head, (ws) => {
    sockets.emit('connection', ws, request);
    callback(ws);
  });

  return {
    server, broker, platformChat, moduleC: moduleCRoutes.moduleC,
    async close() {
      clearInterval(heartbeat);
      playbackReports.close();
      platformChat.close();
      await moduleCRoutes.close();
      webRtcProxy.close();
      broker.close();
      await new Promise((resolveClose) => server.close(resolveClose));
      sockets.close();
    },
  };
}

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw Object.assign(new Error('请求内容过长。'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('请求 JSON 格式无效。'), { statusCode: 400 }); }
}

async function serveFile(path, request, response) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return json(response, 400, { error: 'Invalid path' }); }
  const file = resolve(publicDirectory, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!file.startsWith(publicDirectory + sep) || !types[extname(file)]) return json(response, 404, { error: 'Not found' });
  try {
    if (!(await stat(file)).isFile()) return json(response, 404, { error: 'Not found' });
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': bytes.length,
      'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { json(response, 404, { error: 'Not found' }); }
}

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}

function applyHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}
