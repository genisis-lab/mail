import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createProxyHandler } from '../scripts/http-proxy.mjs';

let upstream: http.Server;
let proxy: http.Server;
let port: number;
const received: string[] = [];
const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const close = (server: http.Server) => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
const request = (path: string, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
    let body = '';
    res.setEncoding('utf8').on('data', (chunk) => body += chunk).on('end', () => resolve({ status: res.statusCode!, body }));
  });
  req.on('error', reject).end();
});

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    received.push(req.url!);
    res.end(req.url);
  });
  proxy = http.createServer(createProxyHandler(await listen(upstream)));
  port = await listen(proxy);
});
afterAll(async () => { await close(proxy); await close(upstream); });

it.each([
  '/cdn-cgi/handler/scheduled', '/cdn-cgi', '/a/../cdn-cgi/local/explorer/api/local/workers',
  '/a/%2e%2e/cdn-cgi/handler/scheduled', '/%63dn-cgi/local/explorer/api',
  '/%2563dn-cgi/local/explorer/api', '/a%2f..%2fcdn-cgi/handler/scheduled',
  '/a\\..\\cdn-cgi/handler/scheduled', '/a%5c..%5ccdn-cgi/handler/scheduled',
  '//localhost/cdn-cgi/handler/scheduled', 'http://localhost/cdn-cgi/handler/scheduled',
  '/a/../__scheduled', '/%5f%5fscheduled',
])('blocks internal path %s without reaching the upstream', async (path) => {
  const before = received.length;
  expect((await request(path, 'POST')).status).toBe(404);
  expect(received).toHaveLength(before);
});

it('forwards canonical application paths and preserves queries', async () => {
  expect(await request('/a/../api/health?next=/cdn-cgi/')).toEqual({ status: 200, body: '/api/health?next=/cdn-cgi/' });
  expect(await request('/assets/app.js')).toEqual({ status: 200, body: '/assets/app.js' });
  expect(await request('/jmap/download/u1/blob/invoice.pdf')).toEqual({ status: 200, body: '/jmap/download/u1/blob/invoice.pdf' });
  expect(await request('/jmap/download/u1/blob/my%20invoice.pdf')).toEqual({ status: 200, body: '/jmap/download/u1/blob/my%20invoice.pdf' });
});
