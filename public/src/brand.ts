/** Runtime CSS-token access keeps canvas rendering in step with explicit and system themes. */
import { tokens, type TokenName } from '../brand/tokens.js';
let paletteKey = '';
let paletteStyle: CSSStyleDeclaration | null = null;

/** Resolve a shared token after styles load, refreshing the palette when the theme changes. */
export function brandValue(token: `--pm-${TokenName}`): string {
  const key = `${document.documentElement.dataset.theme}:${matchMedia('(prefers-color-scheme: dark)').matches}`;
  if (key !== paletteKey || !paletteStyle) {
    paletteKey = key;
    paletteStyle = getComputedStyle(document.documentElement);
  }
  const theme = document.documentElement.dataset.theme;
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return paletteStyle.getPropertyValue(token).trim() || tokens[dark ? 'dark' : 'light'][token.slice(5) as TokenName];
}

/** Resolve palette entries lazily so existing graph nodes can repaint after a theme change. */
export function brandPalette(tokens: Record<string, `--pm-${TokenName}`>): Record<string, string> {
  return new Proxy<Record<string, string>>({}, {
    get(_target, key: string): string | undefined { return tokens[key] ? brandValue(tokens[key]) : undefined; },
  });
}
