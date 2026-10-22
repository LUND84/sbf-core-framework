import { RateLimiter } from '../auth.js';
import { fail } from './policies.js';
import { ModuleC } from './service.js';
import { TokenMetadata } from './metadata.js';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export function moduleCAdminSecureTransport(request, trustProxy) {
  if (request.socket.encrypted === true) return true;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  if (!loopback) return false;
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']
    .some(k => Object.hasOwn(request.headers, k));
  if (!forwarded) return true;
  return trustProxy === true && !Object.hasOwn(request.headers, 'forwarded')
    && request.headers['x-forwarded-proto'] === 'https';
}

export function moduleCClientIp(request, trustProxy) {
  const direct = request.socket.remoteAddress || 'unknown';
  if (!trustProxy || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct)) return direct;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 2048) return direct;
  const client = forwarded.split(',').at(-1).trim();
  return isIP(client) ? client : direct;
}

export function createModuleCRoutes(config, broker, auth, { json, readJson, ...options }) {
  const metadata = options.tokenMetadata || new TokenMetadata(options);
  const moduleC = new ModuleC(config, broker, { ...options, metadata: options.metadata || ((chain, ca) => metadata.lookup(chain, ca)) });
  const createLimiter = new RateLimiter(20, 60 * 60 * 1000);
  const verifyLimiter = new RateLimiter(30, 60 * 1000);
  const logoCache = new Map();
  const logoInflight = new Map();
  const operator = request => {
    if (!auth.worker(request)) fail('OPERATOR_AUTH_REQUIRED', 401);
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
      || ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'].some(k => Object.hasOwn(request.headers, k))) {
      fail('OPERATOR_DIRECT_LOOPBACK_REQUIRED', 403);
    }
  };
  const pricingAdmin = request => {
    if (!config.adminToken) fail('PRICING_ADMIN_DISABLED', 503);
    const actual = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    const expected = Buffer.from(`Bearer ${config.adminToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('PRICING_ADMIN_AUTH_REQUIRED', 401);
    if (!moduleCAdminSecureTransport(request, config.trustProxy)) fail('PRICING_ADMIN_SECURE_TRANSPORT_REQUIRED', 403);
  };
  return { moduleC,
    async handle(request, response, path) {
      if (!path.startsWith('/api/module-c/')) return false;
      if (request.url !== path) fail('MODULE_C_QUERY_NOT_ALLOWED');
      if (path === '/api/module-c/admin/pricing') {
        pricingAdmin(request);
        if (request.method === 'GET') json(response, 200, moduleC.pricing.get());
        else if (request.method === 'PUT') json(response, 200, moduleC.pricing.update(await readJson(request)));
        else fail('PRICING_ADMIN_METHOD_NOT_ALLOWED', 405);
      } else if (request.method === 'GET' && path === '/api/module-c/config') json(response, 200, moduleC.publicConfig());
      else if (request.method === 'GET' && path === '/api/module-c/board') json(response, 200, moduleC.board());
      else if (request.method === 'GET' && path === '/api/module-c/review') {
        operator(request); json(response, 200, { orders: moduleC.review() });
      } else if (request.method === 'GET' && /^\/api\/module-c\/logo\/[a-f0-9]{16}$/.test(path)) {
        const id = path.split('/').pop();
        const order = moduleC.store?.all().find(o => o.state === 'paid' && o.id.startsWith(id));
        if (!order?.token?.logo) fail('LOGO_NOT_FOUND', 404);
        let logo = logoCache.get(id);
        if (!logo) {
          if (!logoInflight.has(id)) logoInflight.set(id, metadata.image(order.token.logo).finally(() => logoInflight.delete(id)));
          try { logo = await logoInflight.get(id); } catch { fail('LOGO_UNAVAILABLE', 404); }
          if (logoCache.size >= 128) logoCache.delete(logoCache.keys().next().value);
          logoCache.set(id, logo);
        }
        response.writeHead(200, { 'Content-Type': logo.type, 'Content-Length': logo.buffer.length,
          'Cache-Control': 'public, max-age=300' }); response.end(logo.buffer);
      } else if (/^\/api\/module-c\/orders\/[a-f0-9]{64}\/resolve$/.test(path) && request.method === 'POST') {
        operator(request); const body = await readJson(request);
        json(response, 200, moduleC.resolve(path.split('/')[4], body.action));
      } else {
        if (!auth.viewer(request)) fail('请输入演播室访问码。', 401);
        const orderPath = /^\/api\/module-c\/orders\/([a-f0-9]{64})(\/(?:verify|proof-message))?$/.exec(path);
        if (request.method === 'GET' && orderPath && !orderPath[2]) json(response, 200, moduleC.view(moduleC.get(orderPath[1])));
        else if (request.method === 'POST') {
          if (!auth.origin(request)) fail('请求来源不被允许。', 403);
          const ip = moduleCClientIp(request, config.trustProxy);
          if (path === '/api/module-c/orders') {
            if (!createLimiter.allow(ip)) fail('创建订单过快，请稍后再试。', 429);
            json(response, 201, moduleC.create(await readJson(request)));
          } else if (orderPath?.[2]) {
            if (!verifyLimiter.allow(ip)) fail('核验过于频繁，请稍后再试。', 429);
            const body = await readJson(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)
              || Object.keys(body).some(key => !['txHash', 'walletProof'].includes(key))) fail('INVALID_WALLET_PROOF');
            json(response, 200, orderPath[2] === '/proof-message' ? moduleC.proofMessage(orderPath[1], body.txHash)
              : await moduleC.verify(orderPath[1], body.txHash, body.walletProof));
          } else fail('MODULE_C_NOT_FOUND', 404);
        } else fail('MODULE_C_NOT_FOUND', 404);
      }
      return true;
    },
    close: () => moduleC.close(),
  };
}
