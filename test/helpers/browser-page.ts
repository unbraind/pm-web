import type { BrowserContext, Page } from 'playwright-core';

/** Open an authenticated page through the shipped consent UI with optional storage disabled. */
export async function authenticatedBrowserPage(session: BrowserContext, origin: string, token: string): Promise<Page> {
  await session.addCookies([{ name: 'pm_token', value: token, url: origin }]);
  const page = await session.newPage();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
  return page;
}
