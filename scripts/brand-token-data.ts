/** Decode the installed contract when the held kit has no compiled TypeScript export. */
export function parseBrandTokens(css: string): Record<'light' | 'dark', Record<string, string>> {
  /** Read one declaration block without introducing application-owned token values. */
  const declarations = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/--pm-([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  const light = declarations(/:root\s*\{([^}]+)\}/.exec(css)?.[1] ?? '');
  const dark = { ...light, ...declarations(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/.exec(css)?.[1] ?? '') };
  return { light, dark };
}
