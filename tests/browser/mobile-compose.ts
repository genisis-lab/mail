import { devices, expect, type Browser, type BrowserContext } from '@playwright/test';

export async function checkMobileCompose(browser: Browser, session: BrowserContext) {
  const phone = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 320, height: 700 },
    storageState: await session.storageState(),
  });
  try {
    const page = await phone.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    const to = page.getByRole('combobox', { name: 'To recipients' });
    const subject = page.getByRole('textbox', { name: 'Subject', exact: true });
    const body = page.getByRole('textbox', { name: 'Message body' });
    for (const field of [to, subject, body]) {
      await field.focus();
      expect(await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    }
    await to.fill('smoke@example.test');
    await to.press('Enter');
    await subject.fill('Mobile compose check');
    await body.fill('Composed on a phone.\n'.repeat(40));

    // Mobile emulation has no OS keyboard. Shrink just the visual viewport,
    // leaving the layout viewport unchanged as Safari does when typing.
    for (const [width, height, keyboardTop] of [[320, 700, 390], [844, 390, 190]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((bottom) => {
        const viewport = window.visualViewport!;
        Object.defineProperties(viewport, {
          height: { configurable: true, value: bottom - 12 },
          offsetTop: { configurable: true, value: 12 },
        });
        viewport.dispatchEvent(new Event('resize'));
      }, keyboardTop);
      await expect.poll(() => page.getByRole('button', { name: 'Send', exact: true }).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const v = window.visualViewport!;
        return r.height >= 44 && r.top >= v.offsetTop && r.bottom <= v.offsetTop + v.height &&
          r.left >= 0 && r.right <= window.innerWidth &&
          el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      })).toBe(true);
    }
    await page.getByRole('button', { name: 'More send options' }).tap();
    const schedule = page.getByRole('menuitem', { name: 'Schedule send' });
    await expect(schedule).toBeVisible();
    expect(await schedule.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(190);
    await page.keyboard.press('Escape');
    const sent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/compose/send'));
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    expect((await sent).ok()).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByText(/Welcome to Smoke Test/).first().tap();
    await page.getByRole('button', { name: 'Reply', exact: true }).last().tap();
    await expect(page.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue(/^Re:/i);
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible();
  } finally {
    await phone.close();
  }
}
