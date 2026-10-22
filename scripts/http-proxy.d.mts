import type { RequestListener } from 'node:http';
export function proxyTarget(target: string | undefined): string | null;
export function createProxyHandler(port: number, trustProxy?: boolean): RequestListener;
