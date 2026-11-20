import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { checkMobileCompose } from './mobile-compose';

test('set up a mailbox, sign in, and reopen an autosaved draft', async ({ page, browser }) => {
  const password = randomUUID();
  await page.goto('/');
  await page.getByPlaceholder('Fernhill Mail').fill('Smoke Test');
  const next = page.getByRole('button', { name: 'Continue' });
  await next.click();
  await page.getByPlaceholder('example.com').fill('example.test');
  await next.click();
  await page.getByRole('radio', { name: /Choose later/ }).click();
  await next.click();
  await page.getByLabel('Your name').fill('Smoke Tester');
  await page.getByLabel(/^Email address/).fill('smoke');
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeVisible();

  await test.step('Compose and send above a mobile keyboard', () => checkMobileCompose(browser, page.context()));

  // This session injects HTTP failures. Route requests directly through Playwright.
  const login = await browser.newPage({ serviceWorkers: 'block' });
  try {
    await login.goto('/');
    await login.getByLabel(/^Email address/).fill('smoke@example.test');
    await login.getByLabel(/^Password/).fill(password);
    await login.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(login.getByText(/Welcome to Smoke Test/).first()).toBeVisible();
    await login.getByRole('button', { name: 'Compose', exact: true }).click();
    const subject = login.getByLabel('Subject', { exact: true });
    const body = login.locator('[contenteditable=true]');
    // Delay the first POST so the next edit happens before the new draft has an ID.
    let resume!: () => void;
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    const createStarted = login.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/compose/drafts'));
    await login.route('**/api/compose/drafts', async (route) => {
      await pause;
      await route.continue();
    }, { times: 1 });
    await subject.fill('Browser smoke draft');
    await body.fill('First version.');
    await createStarted;
    await body.fill('Saved across a reload.');
    await login.getByRole('button', { name: 'Minimize', exact: true }).click();
    await login.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(subject).toHaveValue('Browser smoke draft');
    await expect(body).toHaveText('Saved across a reload.');
    const updated = login.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/compose/drafts/'));
    resume();
    expect((await updated).ok()).toBe(true);
    await expect(login.getByText('Draft saved', { exact: true })).toBeVisible();
    await login.reload();
    await login.getByRole('link', { name: /Drafts/ }).click();
    await login.getByText('Browser smoke draft', { exact: true }).click();
    await expect(subject).toHaveValue('Browser smoke draft');
    await expect(body).toHaveText('Saved across a reload.');

    const discard = login.getByRole('button', { name: 'Discard draft' });
    const drafts = '**/api/compose/drafts/*';
    await login.route(drafts, (route) => route.request().method() === 'DELETE'
      ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
      : route.continue());
    const failedDelete = login.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/compose/drafts/'));
    await discard.click();
    expect((await failedDelete).status()).toBe(503);
    await login.unroute(drafts);
    await expect(login.getByText(/Couldn’t discard draft/)).toBeVisible();
    await expect(body).toHaveText('Saved across a reload.');
    await discard.click();
    await expect(login.getByText('Draft discarded', { exact: true })).toBeVisible();
    await login.reload();
    await expect(login.getByRole('link', { name: /Drafts/ })).toBeVisible();
    await expect(login.getByText('Browser smoke draft', { exact: true })).toHaveCount(0);
  } finally {
    await login.close();
  }
});
