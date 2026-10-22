import http from 'node:http';

/** Validate the same normalized path we forward; never expose Wrangler's local control plane. */
export function proxyTarget(target) {
  if (!target?.startsWith('/') || target.startsWith('//') || /[\\\s#]/.test(target)) return null;
  const url = new URL(target, 'http://wren.invalid');
  let probe = url.pathname;
  // Some upstream handlers decode route segments. Check encoded and nested-encoded paths too.
  for (let i = 0; i < 5; i++) {
    if (/[\\\u0000-\u001f\u007f?#]/.test(probe) || probe.startsWith('//')) return null;
    const path = new URL(probe, 'http://wren.invalid').pathname;
    if (path === '/cdn-cgi' || path.startsWith('/cdn-cgi/') || path === '/__scheduled' || path.startsWith('/__scheduled/')) return null;
    if (!/%[a-f0-9]{2}/i.test(probe)) return url.pathname + url.search;
    try {
      probe = decodeURIComponent(probe);
    } catch {
      return null;
    }
  }
  return null; // Refuse ambiguous, repeatedly encoded paths.
}

/** The public HTTP server forwards only application requests to the loopback runtime. */
export function createProxyHandler(port, trustProxy = false) {
  return (req, res) => {
    const target = proxyTarget(req.url);
    if (target === null) {
      res.writeHead(404).end();
      return;
    }
    const forwarded = req.headers['x-forwarded-for'];
    const ip = trustProxy && typeof forwarded === 'string' && forwarded
      ? forwarded.split(',')[0].trim()
      : (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const headers = { ...req.headers, 'cf-connecting-ip': ip };
    delete headers['x-forwarded-for'];
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: target, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Wren is starting up. Try again in a few seconds.');
    });
    req.pipe(upstream);
  };
}
