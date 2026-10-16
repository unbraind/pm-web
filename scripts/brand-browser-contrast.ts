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
    /** Composite the foreground over an opaque background. */
    const blend = (foreground: number[], background: number[]): number[] => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
    /** Compute WCAG relative luminance from normalized sRGB channels. */
    const luminance = (color: number[]): number => {
      const linear = color.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    const scope = [...document.querySelectorAll<HTMLElement>('.modal-backdrop[style*="flex"] .modal')].at(-1) ?? document.body;
    const failures: string[] = [];
    const pairs = new Set<string>();
    for (const el of scope.querySelectorAll<HTMLElement>('*')) {
      if (!el.checkVisibility() || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[aria-hidden="true"],:disabled') || el.matches('script,style,option')) continue;
      const text = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join('').trim();
      if (!text && !el.matches('input:not([type="checkbox"]):not([type="radio"]),textarea,select')) continue;
      const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let background = [1, 1, 1];
      let opacity = 1;
      for (const ancestor of ancestors) {
        const css = getComputedStyle(ancestor);
        background = blend(rgba(css.backgroundColor), background);
        opacity *= Number(css.opacity);
      }
      if (!opacity) continue;
      const css = getComputedStyle(el);
      const ink = rgba(css.color);
      ink[3] *= opacity;
      const foreground = blend(ink, background);
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
