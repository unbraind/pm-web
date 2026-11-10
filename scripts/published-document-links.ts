import { posix } from 'node:path';

/** Read inline, reference and repository autolinks while excluding fenced code examples. */
export function markdownDestinations(document: string): string[] {
  const prose = document.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
  const destinations = [...prose.matchAll(/\]\(\s*(?:<([^>]+)>|((?:[^\s()\\]|\\.|\([^()]*\))+))(?:\s+[^)]*)?\)/g)]
    .map(match => match[1] ?? match[2]!);
  for (const match of prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) destinations.push(match[1] ?? match[2]!);
  // Keep the original repository-link audit, including bare URLs in prose.
  for (const match of prose.matchAll(/https:\/\/github\.com\/unbraind\/pm-web\/blob\/[^\s)#>]+/g)) destinations.push(match[0]);
  return [...new Set(destinations)];
}

/** Resolve every relative destination against the actual package inventory, never the source tree. */
export function missingPackedDocumentLinks(files: readonly string[], readDocument: (file: string) => string): string[] {
  const inventory = new Set(files);
  const missing: string[] = [];
  for (const file of files.filter(file => /\.md$/i.test(file))) {
    for (const destination of markdownDestinations(readDocument(file))) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
      const pathname = decodeURIComponent(destination.split(/[?#]/, 1)[0]!).replace(/\\([ !"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
      const target = pathname.startsWith('/') ? pathname.slice(1) : posix.normalize(posix.join(posix.dirname(file), pathname));
      if (!inventory.has(target)) missing.push(`${file}: ${destination}`);
    }
  }
  return missing;
}
