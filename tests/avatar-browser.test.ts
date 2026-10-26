import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setApiAccount } from '../src/web/lib/api';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example' });
let root: Root;
let avatar: typeof import('../src/web/components/Avatar');
beforeAll(async () => {
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  avatar = await import('../src/web/components/Avatar');
  root = createRoot(document.getElementById('root')!);
  setApiAccount(1);
});
afterAll(async () => { await act(async () => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); });
const image = () => document.querySelector('img')!;
const show = () => act(async () => { root.render(createElement(avatar.Avatar, { address: 'sam@example.org' })); });

it('shows a cached avatar immediately on remount, and invalidates it when changed', async () => {
  await show();
  expect(image().className).toContain('opacity-0');
  await act(async () => { image().dispatchEvent(new dom.window.Event('load')); });
  expect(image().className).toContain('opacity-100');
  const first = image().src;
  await act(async () => root.render(null));
  await show();
  expect(image().src).toBe(first);
  expect(image().className).toContain('opacity-100'); // before another load event
  await act(async () => avatar.refreshAvatar(['sam@example.org'], 123));
  expect(image().src).not.toBe(first);
  expect(image().className).toContain('opacity-0');
  await act(async () => image().dispatchEvent(new dom.window.Event('load')));
  await act(async () => avatar.refreshAvatar(['sam@example.org'], 0));
  expect(image().src).toContain('v=0');
});

it('does not reuse another account’s missing-picture result', async () => {
  await act(async () => image().dispatchEvent(new dom.window.Event('error')));
  expect(document.querySelector('img')).toBeNull();
  setApiAccount(2);
  await show();
  expect(image().src).toContain('account=2');
});
