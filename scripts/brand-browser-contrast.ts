import type { Page } from 'playwright-core';

/** Check painted text colors, alpha and ancestor backgrounds in the active sheet. */
export async function auditTextContrast(page: Page): Promise<{ pairs: number; failures: string[] }> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    /** Decode any browser-supported CSS color into linear byte channels and alpha. */
    const rgba = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map(channel => channel / 255);
    };
    /** Composite two transparent layers before applying their containing opacity group. */
    const blend = (foreground: number[], background: number[]): number[] => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      return [...foreground.slice(0, 3).map((channel, index) => alpha ? (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha : 0), alpha];
    };
    /** Compute WCAG relative luminance from normalized sRGB channels. */
    const luminance = (color: number[]): number => {
      const linear = color.slice(0, 3).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    const scope = [...document.querySelectorAll<HTMLElement>('.modal-backdrop[style*="flex"] .modal')].at(-1) ?? document.body;
    const failures: string[] = [];
    const pairs = new Set<string>();
    for (const el of scope.querySelectorAll<HTMLElement>('*')) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[aria-hidden="true"],:disabled') || el.matches('script,style,option')) continue;
      const text = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join('').trim();
      if (!text && !el.matches('input:not([type="checkbox"]):not([type="radio"]),textarea,select')) continue;
      const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
      const css = getComputedStyle(el);
      let background = [0, 0, 0, 0];
      let foreground = rgba(css.color);
      // CSS opacity composites a whole subtree, including opaque child fills.
      for (const ancestor of ancestors.reverse()) {
        const style = getComputedStyle(ancestor);
        const fill = rgba(style.backgroundColor);
        background = blend(background, fill);
        foreground = blend(foreground, fill);
        background[3] *= Number(style.opacity);
        foreground[3] *= Number(style.opacity);
      }
      if (!foreground[3]) continue;
      background = blend(background, [1, 1, 1, 1]);
      foreground = blend(foreground, [1, 1, 1, 1]);
      const key = `${foreground.join(',')}/${background.join(',')}`;
      pairs.add(key);
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const size = parseFloat(css.fontSize);
      const minimum = size >= 24 || (size >= 18.66 && Number(css.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio + .01 < minimum) failures.push(`${el.id || el.className || el.tagName}: ${JSON.stringify(text.slice(0, 60))} ${ratio.toFixed(2)}:1 (${css.color} on ${css.backgroundColor})`);
    }
    return { pairs: pairs.size, failures };
  });
}
