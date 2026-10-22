import { request as httpRequest } from 'node:http';

const PREFIX = '/api/webrtc/sbf-trial/whep';
const UPSTREAM_PATH = '/sbf-trial/whep';
const UPSTREAM_ORIGIN = 'http://127.0.0.1:18889';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp(`^${PREFIX}(?:/(${UUID}))?$`, 'i');
const LIMIT = 128 * 1024;
const DEADLINE_MS = 8000;
const MAX_INFLIGHT = 16;
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,250}"$/;

function failure(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}

function replyError(response, status, code) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', Connection: 'close' });
  response.end(JSON.stringify({ error: code }));
}

function boundedBody(stream, signal, statusCode) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    function finish(error) {
      stream.removeListener('data', data);
      stream.removeListener('end', end);
      stream.removeListener('error', failed);
      stream.removeListener('aborted', aborted);
      signal.removeEventListener('abort', cancelled);
      if (error) { stream.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, length));
    }
    function data(chunk) {
      length += chunk.length;
      if (length > LIMIT) finish(failure(statusCode, 'WHEP_BODY_TOO_LARGE'));
      else chunks.push(chunk);
    }
    function end() { finish(); }
    function failed() { finish(failure(statusCode === 413 ? 400 : 502, 'WHEP_BODY_INCOMPLETE')); }
    function aborted() { failed(); }
    function cancelled() { finish(signal.reason); }
    const declared = stream.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMIT)) {
      finish(failure(statusCode, 'WHEP_BODY_TOO_LARGE'));
      return;
    }
    if (signal.aborted) { cancelled(); return; }
    stream.on('data', data);
    stream.once('end', end);
    stream.once('error', failed);
    stream.once('aborted', aborted);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

function requestHeaders(request, body) {
  const method = request.method;
  const headers = { Origin: UPSTREAM_ORIGIN, 'Content-Length': body.length };
  const requiredType = method === 'POST' ? 'application/sdp'
    : method === 'PATCH' ? 'application/trickle-ice-sdpfrag' : null;
  if (requiredType) {
    const type = request.headers['content-type'];
    if (typeof type !== 'string' || type.toLowerCase() !== requiredType) {
      throw failure(415, 'WHEP_CONTENT_TYPE_INVALID');
    }
    if (!body.length) throw failure(400, 'WHEP_BODY_REQUIRED');
    headers['Content-Type'] = requiredType;
  } else if (body.length) throw failure(400, 'WHEP_BODY_NOT_ALLOWED');
  if (method === 'PATCH') {
    const etag = request.headers['if-match'];
    if (etag !== '*' && !(typeof etag === 'string' && ETAG.test(etag))) {
      throw failure(400, 'WHEP_IF_MATCH_INVALID');
    }
    headers['If-Match'] = etag;
  }
  // Construct this list instead of filtering user headers. Reason: cookies, credentials,
  // forwarded hosts and arbitrary proxy headers must never reach the internal listener.
  return headers;
}

function rewriteLocation(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\\]/.test(value)) {
    throw failure(502, 'WHEP_LOCATION_INVALID');
  }
  const match = new RegExp(`^${UPSTREAM_PATH}/(${UUID})$`, 'i');
  // Accept only the exact upstream path, optionally qualified by the fixed loopback origin.
  // Reason: URL normalization and redirect resolution must not create another proxy target.
  const path = value.startsWith(`${UPSTREAM_ORIGIN}/`) ? value.slice(UPSTREAM_ORIGIN.length) : value;
  if (!match.test(path)) throw failure(502, 'WHEP_LOCATION_INVALID');
  return PREFIX + path.slice(UPSTREAM_PATH.length);
}

function responseHeaders(upstream, method, body) {
  const status = upstream.statusCode;
  if (status >= 300 && status < 400) throw failure(502, 'WHEP_REDIRECT_REJECTED');
  const expected = method === 'POST' ? status === 201 : method === 'OPTIONS'
    ? status === 200 || status === 204 : method === 'DELETE' ? status === 200 : status === 204;
  if (!expected) {
    const errorStatus = [400, 401, 403, 404, 409, 412, 415, 422, 429, 500, 503].includes(status) ? status : 502;
    throw failure(errorStatus, 'WHEP_UPSTREAM_REJECTED');
  }
  const headers = { 'Cache-Control': 'no-store' };
  if (method === 'POST') {
    if (upstream.headers['content-type']?.toLowerCase() !== 'application/sdp' || !body.length) {
      throw failure(502, 'WHEP_ANSWER_INVALID');
    }
    headers['Content-Type'] = 'application/sdp';
    headers.Location = rewriteLocation(upstream.headers.location);
  } else if (method === 'DELETE') {
    const type = upstream.headers['content-type']?.toLowerCase().replace(/\s/g, '');
    let result;
    try { result = JSON.parse(body.toString('utf8')); } catch { /* Invalid APIOK is rejected below. */ }
    // MediaMTX v1.21.2 returns 200 APIOK, not 204. Reason: preserve the pinned
    // implementation's proven contract without accepting arbitrary upstream JSON.
    if (!['application/json', 'application/json;charset=utf-8'].includes(type)
      || !result || result.status !== 'ok' || Object.keys(result).length !== 1) {
      throw failure(502, 'WHEP_DELETE_RESULT_INVALID');
    }
    headers['Content-Type'] = 'application/json; charset=utf-8';
  } else if (body.length) throw failure(502, 'WHEP_UNEXPECTED_BODY');
  const etag = upstream.headers.etag;
  if (etag !== undefined) {
    // This pinned MediaMTX advertises ETag: *. Reason: rejecting the actual
    // wildcard header would turn every otherwise valid SDP answer into 502.
    if (etag !== '*' && !ETAG.test(etag)) throw failure(502, 'WHEP_ETAG_INVALID');
    headers.ETag = etag;
  }
  if (upstream.headers['accept-patch'] === 'application/trickle-ice-sdpfrag') {
    headers['Accept-Patch'] = upstream.headers['accept-patch'];
  }
  const link = upstream.headers.link;
  if (link !== undefined) {
    if (typeof link !== 'string' || link.length > 4096 || /[\r\n]/.test(link)
      || !link.split(/,\s*(?=<)/).every((part) => /^<(?:stun|stuns|turn|turns):[^<>\s]+>;\s*rel="ice-server"(?:;\s*(?:username|credential|credential-type)="[^"\r\n]*")*$/.test(part))) {
      throw failure(502, 'WHEP_ICE_LINK_INVALID');
    }
    headers.Link = link;
  }
  return headers;
}

function exchange(requestImpl, options, body, signal) {
  return new Promise((resolve, reject) => {
    let upstream;
    const outgoing = requestImpl(options, async (response) => {
      upstream = response;
      try { resolve({ upstream: response, body: await boundedBody(response, signal, 502) }); }
      catch (error) { outgoing.destroy(); response.destroy(); reject(error); }
    });
    outgoing.once('error', () => reject(signal.aborted ? signal.reason : failure(502, 'WHEP_UPSTREAM_UNAVAILABLE')));
    signal.addEventListener('abort', () => { upstream?.destroy(); outgoing.destroy(); }, { once: true });
    outgoing.end(body);
  });
}

/** Opt-in WHEP signaling only; MediaMTX owns the actual peer/media lifecycle. */
export function createWebRtcProxy(auth, { requestImpl = httpRequest, timeoutMs = DEADLINE_MS, port = 18889 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw new Error('Invalid WHEP deadline');
  if (![18889, 18890].includes(port)) throw new Error('Invalid owned WHEP port');
  const inflight = new Set();
  return {
    async handle(request, response) {
      if (!auth.origin(request)) return replyError(response, 403, 'WHEP_ORIGIN_REJECTED');
      if (!auth.viewer(request)) return replyError(response, 401, 'WHEP_VIEWER_REQUIRED');
      const route = ROUTE.exec(request.url);
      if (!route) return replyError(response, 400, 'WHEP_PATH_INVALID');
      const allowed = route[1] ? ['OPTIONS', 'PATCH', 'DELETE'] : ['OPTIONS', 'POST'];
      if (!allowed.includes(request.method)) {
        response.setHeader('Allow', allowed.join(', '));
        return replyError(response, 405, 'WHEP_METHOD_INVALID');
      }
      if (inflight.size >= MAX_INFLIGHT) return replyError(response, 503, 'WHEP_BUSY');
      const controller = new AbortController();
      inflight.add(controller);
      const timer = setTimeout(() => controller.abort(failure(504, 'WHEP_TIMEOUT')), timeoutMs);
      const disconnected = () => {
        if (!response.writableFinished) controller.abort(failure(499, 'WHEP_VIEWER_DISCONNECTED'));
      };
      response.once('close', disconnected);
      try {
        const body = await boundedBody(request, controller.signal, 413);
        const headers = requestHeaders(request, body);
        const result = await exchange(requestImpl, { protocol: 'http:', hostname: '127.0.0.1',
          port, path: UPSTREAM_PATH + (route[1] ? `/${route[1]}` : ''),
          method: request.method, headers, maxHeaderSize: 8192, signal: controller.signal }, body, controller.signal);
        const outputHeaders = responseHeaders(result.upstream, request.method, result.body);
        response.writeHead(result.upstream.statusCode, outputHeaders);
        response.end(result.body);
      } catch (error) {
        if (error.statusCode !== 499) replyError(response, error.statusCode || 502, error.code || 'WHEP_UPSTREAM_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        response.removeListener('close', disconnected);
        inflight.delete(controller);
      }
    },
    close() {
      for (const controller of inflight) controller.abort(failure(503, 'WHEP_CLOSED'));
      inflight.clear();
    },
  };
}
