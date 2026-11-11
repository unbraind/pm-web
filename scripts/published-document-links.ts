import { posix } from 'node:path';

/** Whether a repository object can be checked in this checkout. */
export type RevisionPresence = 'present' | 'absent' | 'unresolved';

/**
 * Drop CommonMark fenced code, including an unclosed fence through end of document.
 *
 * A closing fence must use the opener's character, be at least as long, and have
 * only spaces or tabs after the marker. Trailing text, a shorter run, or the other
 * fence character does not end the block.
 *
 * @param document - Markdown source; line endings are normalized before scanning.
 * @returns Prose with fenced examples removed.
 */
export function stripFencedCode(document: string): string {
  const lines = document.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const prose: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const opener = /^( {0,3})(`{3,}|~{3,})([^]*)$/.exec(line);
    if (!opener || (opener[2]?.startsWith('`') && opener[3]?.includes('`'))) {
      prose.push(line);
      continue;
    }
    const marker = opener[2]?.[0] ?? '`';
    const length = opener[2]?.length ?? 3;
    let close = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = /^( {0,3})([`~]+)[ \t]*$/.exec(lines[cursor] ?? '');
      const run = candidate?.[2] ?? '';
      if (run.length >= length && run[0] === marker && run.split('').every(character => character === marker)) {
        close = cursor;
        break;
      }
    }
    index = close;
  }
  return prose.join('\n');
}

/** Read inline, reference and repository autolinks while excluding fenced code examples. */
export function markdownDestinations(document: string): string[] {
  const prose = stripFencedCode(document);
  const destinations = [...prose.matchAll(/\]\(\s*(?:<([^>]+)>|((?:[^\s()\\]|\\.|\([^()]*\))+))(?:\s+[^)]*)?\)/g)]
    .map(match => match[1] ?? match[2]!);
  for (const match of prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) destinations.push(match[1] ?? match[2]!);
  // Keep the original repository-link audit, including bare URLs in prose.
  for (const match of prose.matchAll(/https:\/\/github\.com\/unbraind\/pm-web\/blob\/[^\s)#>]+/g)) destinations.push(match[0]);
  return [...new Set(destinations)];
}

/**
 * Select Markdown files from a pack inventory.
 *
 * Manifest entries are directories and names. Nested and mandatory packed
 * Markdown, including a different extension case, is not visible there.
 *
 * @param files - Paths actually present in the package, using pack separators.
 * @returns Packed Markdown paths, in inventory order.
 */
export function packedMarkdownFiles(files: readonly string[]): string[] {
  return files.filter(file => /(?:^|\/)[^/]+\.md$/i.test(file));
}

/** Compare the installed Markdown bytes for every file in the actual package inventory. */
export function assertPackedMarkdownMatches(files: readonly string[], readInstalled: (file: string) => string, readSource: (file: string) => string): void {
  for (const file of packedMarkdownFiles(files)) {
    if (readInstalled(file) !== readSource(file)) throw new Error(`Packed documentation differs: ${file}`);
  }
}

/**
 * Read the file list from `npm pack --json`, including a receipt with leading non-JSON text.
 *
 * @param stdout - Pack command stdout.
 * @returns Packed paths.
 * @throws {Error} When the receipt has no usable file inventory.
 */
export function packedFileInventory(stdout: string): string[] {
  const line = stdout.search(/^\s*\[/m);
  const start = line >= 0 ? line : stdout.indexOf('[');
  if (start < 0) throw new Error('npm pack --json returned no file inventory');
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.slice(start)); }
  catch { throw new Error('npm pack --json returned no file inventory'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed[0] === null || typeof parsed[0] !== 'object' || !Array.isArray((parsed[0] as { files?: unknown }).files)) {
    throw new Error('npm pack --json returned no file inventory');
  }
  return (parsed[0] as { files: unknown[] }).files.map(file => {
    if (file === null || typeof file !== 'object' || typeof (file as { path?: unknown }).path !== 'string') {
      throw new Error('npm pack --json returned no file inventory');
    }
    return (file as { path: string }).path;
  });
}

/** Decode a link path, or report it missing when percent-encoding is malformed. */
function destinationPath(destination: string): string | undefined {
  let raw = destination.split(/[?#]/, 1)[0] ?? '';
  try { raw = decodeURIComponent(raw); }
  catch { return undefined; }
  return raw.replace(/\\([ !"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

/** Resolve every relative destination against the actual package inventory, never the source tree. */
export function missingPackedDocumentLinks(files: readonly string[], readDocument: (file: string) => string): string[] {
  const inventory = new Set(files);
  const missing: string[] = [];
  for (const file of packedMarkdownFiles(files)) {
    for (const destination of markdownDestinations(readDocument(file))) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
      const pathname = destinationPath(destination);
      if (pathname === undefined) { missing.push(`${file}: ${destination}`); continue; }
      const target = pathname.startsWith('/') ? pathname.slice(1) : posix.normalize(posix.join(posix.dirname(file), pathname));
      if (!inventory.has(target)) missing.push(`${file}: ${destination}`);
    }
  }
  return missing;
}

/** Resolve one blob URL's decoded revision/path boundary using locally resolvable revisions. */
function githubBlobTarget(destination: string, resolves: (revision: string) => boolean): { revision: string; file: string } | 'invalid' | undefined {
  const prefix = 'https://github.com/unbraind/pm-web/blob/';
  const suffix = destinationPath(destination.slice(prefix.length));
  if (suffix === undefined || suffix.includes('\\') || suffix.includes('\0')) return 'invalid';
  const segments = suffix.split('/');
  for (let boundary = segments.length - 1; boundary > 0; boundary--) {
    const revisionParts = segments.slice(0, boundary);
    if (revisionParts.some(part => !part || part === '.' || part === '..')) continue;
    const revision = revisionParts.join('/');
    if (!resolves(revision)) continue;
    const rawFile = segments.slice(boundary).join('/');
    const file = posix.normalize(rawFile);
    if (!rawFile || posix.isAbsolute(rawFile) || file === '..' || file.startsWith('../')) return 'invalid';
    return { revision, file };
  }
  return undefined;
}

/**
 * Classify blob URLs after resolving the revision, decoding and containing their file paths.
 *
 * @param document - Markdown that may contain blob URLs.
 * @param lookup - Checkout-specific object check; an empty path checks the revision's root tree.
 * @returns Missing or invalid links and links whose revision cannot be resolved locally.
 */
export function missingRevisionLinks(document: string, lookup: (revision: string, file: string) => RevisionPresence): { missing: string[]; unresolved: string[] } {
  const missing: string[] = [];
  const unresolved: string[] = [];
  for (const destination of markdownDestinations(document)) {
    if (!destination.startsWith('https://github.com/unbraind/pm-web/blob/')) continue;
    const target = githubBlobTarget(destination, revision => lookup(revision, '') !== 'unresolved');
    if (target === 'invalid') { missing.push(destination); continue; }
    if (!target) { unresolved.push(destination); continue; }
    const presence = lookup(target.revision, target.file);
    if (presence === 'absent') missing.push(destination);
    else if (presence === 'unresolved') unresolved.push(destination);
  }
  return { missing, unresolved };
}
