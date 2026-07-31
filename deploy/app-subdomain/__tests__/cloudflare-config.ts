import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Parsers for the two Cloudflare Pages config files in this directory. Shared by
// headers.test.ts and redirects.test.ts. Not a `*.test.ts` file, so the project's
// `include` glob doesn't collect it as a suite.

export type HeaderBlock = {
  /** The path pattern the block applies to, e.g. `/*`, `/_expo/*`. */
  path: string;
  /**
   * Header name -> every value written for it. Cloudflare permits repeating a
   * header name within a block (two `Content-Security-Policy` lines are both
   * sent, and browsers enforce their intersection), so this keeps all of them —
   * a last-one-wins map would let a restrictive first policy slip past.
   */
  headers: Map<string, string[]>;
};

export type RedirectRule = {
  from: string;
  to: string;
  /** Cloudflare Pages defaults to 302 when a rule omits the status. */
  status: number;
};

function readConfigFile(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', name), 'utf8');
}

/** Strip blank lines and `#` comments, which both files use the same way. */
function significantLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/**
 * Parse Cloudflare Pages `_headers` syntax: a path line followed by indented
 * `Name: value` lines. https://developers.cloudflare.com/pages/configuration/headers/
 */
export function parseHeadersFile(source: string): HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  let current: HeaderBlock | null = null;

  for (const line of significantLines(source)) {
    const trimmed = line.trim();
    const isIndented = line.startsWith(' ') || line.startsWith('\t');
    if (!isIndented) {
      current = { path: trimmed, headers: new Map() };
      blocks.push(current);
      continue;
    }

    if (!current) {
      throw new Error(`_headers: indented header line before any path: "${line}"`);
    }
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`_headers: malformed header line (no ":"): "${line}"`);
    }
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    const existing = current.headers.get(name);
    if (existing) {
      existing.push(value);
    } else {
      current.headers.set(name, [value]);
    }
  }

  return blocks;
}

/**
 * Parse Cloudflare Pages `_redirects` syntax: `<from> <to> [status]`, one rule
 * per line, applied in file order.
 * https://developers.cloudflare.com/pages/configuration/redirects/
 */
export function parseRedirectsFile(source: string): RedirectRule[] {
  return significantLines(source).map((line) => {
    const [from, to, status] = line.trim().split(/\s+/);
    if (!from || !to) {
      throw new Error(`_redirects: malformed rule (needs "<from> <to> [status]"): "${line}"`);
    }
    return { from, to, status: status === undefined ? 302 : Number(status) };
  });
}

/**
 * Does a Cloudflare path pattern match a concrete request path? `*` is a
 * wildcard that spans `/` (so `/*` really does cover `/index.html` and
 * `/wasm/renderer.wasm`) — which is exactly the case a pattern-name string
 * comparison would miss. `:placeholder` segments aren't used by either file
 * here, so they aren't handled.
 */
export function pathMatchesPattern(pattern: string, requestPath: string): boolean {
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(requestPath);
}

export const headerBlocks = parseHeadersFile(readConfigFile('_headers'));
export const redirectRules = parseRedirectsFile(readConfigFile('_redirects'));

/**
 * Every value Cloudflare would send for `headerName` on `requestPath`, collected
 * from all blocks whose pattern matches (Pages applies every matching rule, not
 * just the first). Header lookup is case-insensitive.
 */
export function effectiveHeaderValues(requestPath: string, headerName: string): string[] {
  const values: string[] = [];
  for (const block of headerBlocks) {
    if (!pathMatchesPattern(block.path, requestPath)) continue;
    for (const [name, blockValues] of block.headers) {
      if (name.toLowerCase() === headerName.toLowerCase()) values.push(...blockValues);
    }
  }
  return values;
}

/** The rule Cloudflare would apply to `requestPath` — first match wins. */
export function firstMatchingRedirect(requestPath: string): RedirectRule | undefined {
  return redirectRules.find((rule) => pathMatchesPattern(rule.from, requestPath));
}
