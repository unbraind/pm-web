import assert from 'node:assert/strict';
import test from 'node:test';
import { tokens } from 'pm-brand';

/** Resolve aliases from one shared theme; no application-owned palette is involved. */
function themeTokens(theme: 'light' | 'dark'): Map<string, string> {
  return new Map(Object.entries(tokens[theme]).map(([name, value]) => [`--pm-${name}`, value]));
}

/** Convert sRGB into WCAG relative luminance, resolving token references first. */
function luminance(name: string, tokens: Map<string, string>): number {
  const value = tokens.get(name);
  assert.ok(value, `Missing token ${name}`);
  const alias = /^var\((--pm-[\w-]+)\)$/.exec(value)?.[1];
  if (alias) return luminance(alias, tokens);
  assert.match(value, /^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

for (const theme of ['light', 'dark'] as const) test(`Triplicate text pairs meet WCAG AA in ${theme}`, () => {
  const tokens = themeTokens(theme);
  const pairs: [string, string][] = [];
  for (const ink of ['carbon', 'graphite', 'stamp', 'danger']) for (const paper of ['paper', 'sheet']) pairs.push([ink, paper]);
  pairs.push(['on-stamp', 'stamp'], ['stamp', 'stamp-wash'], ['graphite', 'stamp-wash'], ['carbon', 'canary-wash'], ['carbon', 'rose-wash']);
  for (const state of ['open', 'in_progress', 'blocked', 'closed']) pairs.push([`status-${state}-fg`, `status-${state}-bg`]);
  for (const [ink, paper] of pairs) {
    const a = luminance(`--pm-${ink}`, tokens), b = luminance(`--pm-${paper}`, tokens);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, `${theme}: ${ink} on ${paper} = ${ratio.toFixed(2)}:1`);
  }
});
