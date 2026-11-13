import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import { runAgentContextBrowser } from '../scripts/agent-context-browser.ts';

test('a failing page step closes the real browser before awaiting the streaming server', { timeout: 60_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'browser-cleanup-'));
  const previous = process.env.CONTEXT_SCREENSHOTS;
  process.env.CONTEXT_SCREENSHOTS = output;
  let browser: Browser | undefined;
  let url = '';
  let connectedWhenServerClosed: boolean | undefined;
  try {
    await assert.rejects(runAgentContextBrowser(async (page, openedBrowser, server) => {
      browser = openedBrowser;
      url = server.url('/');
      const close = server.close;
      server.close = async () => { connectedWhenServerClosed = openedBrowser.isConnected(); await close(); };
      await page.waitForFunction(() => document.getElementById('sse-indicator')?.classList.contains('connected'));
      throw new Error('synthetic page step failure');
    }), /synthetic page step failure/);
    assert.ok(browser);
    assert.equal(browser.isConnected(), false);
    assert.equal(connectedWhenServerClosed, false, 'server shutdown must begin after the browser closes');
    await assert.rejects(fetch(url));
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_SCREENSHOTS;
    else process.env.CONTEXT_SCREENSHOTS = previous;
    await rm(output, { recursive: true, force: true });
  }
});
