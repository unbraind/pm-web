/** Runtime CSS-token access keeps canvas rendering in step with explicit and system themes. */
import { tokens } from 'pm-brand';
type TokenName = keyof typeof tokens.light;
let paletteKey = '';
let paletteStyle: CSSStyleDeclaration | null = null;
let revision = 0;
let dark = false;
let media: MediaQueryList | null = null;
const resolved = new Map<string, string>();

/** Invalidate resolved values only when the explicit or system theme changes. */
export function brandRevision(): number {
  media ??= matchMedia('(prefers-color-scheme: dark)');
  const theme = document.documentElement.dataset.theme;
  const key = `${theme}:${media.matches}`;
  if (key !== paletteKey) {
    paletteKey = key;
    dark = theme === 'dark' || (theme !== 'light' && media.matches);
    paletteStyle = null;
    resolved.clear();
    revision++;
  }
  return revision;
}

/** Resolve each shared token once per theme after styles load. */
export function brandValue(token: `--pm-${TokenName}`): string {
  brandRevision();
  const cached = resolved.get(token);
  if (cached !== undefined) return cached;
  paletteStyle ??= getComputedStyle(document.documentElement);
  const value = paletteStyle.getPropertyValue(token).trim() || tokens[dark ? 'dark' : 'light'][token.slice(5) as TokenName];
  resolved.set(token, value);
  return value;
}

/** Resolve palette entries lazily so existing graph nodes can repaint after a theme change. */
export function brandPalette(tokens: Record<string, `--pm-${TokenName}`>): Record<string, string> {
  return new Proxy<Record<string, string>>({}, {
    get(_target, key: string): string | undefined { return Object.hasOwn(tokens, key) && tokens[key] ? brandValue(tokens[key]) : undefined; },
  });
}
