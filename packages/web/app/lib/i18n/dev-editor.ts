// Shared by the web-only development UI and its filesystem endpoint.
export type TranslationEntry = { namespace: string; key: string; text: string };

export function devEditorHostnames(configuredHosts = ''): string[] {
  // Support the exact hostname injected by the dev launcher (e.g. Tailscale),
  // while refusing wildcard rules and arbitrary request/forwarded hostnames.
  return [
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...configuredHosts
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter((hostname) => /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(hostname)),
  ];
}

export function flattenTranslations(catalog: unknown, prefix = ''): { key: string; text: string }[] {
  if (typeof catalog === 'string') return [{ key: prefix, text: catalog }];
  if (!catalog || typeof catalog !== 'object') return [];
  return Object.entries(catalog).flatMap(([key, child]) =>
    flattenTranslations(child, prefix ? `${prefix}.${key}` : key),
  );
}

// Protect complete tokens, including interpolation formatters and tag attributes.
// Keeping tag order also preserves nesting and the components supplied to <Trans>.
const syntaxPattern = /\{\{[\s\S]*?\}\}|\$t\([^)]*\)|<\/?[A-Za-z0-9][^>]*>|\r?\n/g;

export function protectedSyntax(text: string): string[] {
  return text.match(syntaxPattern) ?? [];
}

export function preservesTranslationFormat(original: string, replacement: string): boolean {
  if (!replacement.trim()) return false;
  const originalTokens = protectedSyntax(original);
  const replacementTokens = protectedSyntax(replacement);
  // Interpolation may move within a sentence, but never across a formatting tag
  // or line break. In particular, a variable inside a link must stay inside it.
  const fingerprint = (tokens: string[]) => {
    const groups: string[][] = [[]];
    for (const token of tokens) {
      if (token.startsWith('{{') || token.startsWith('$t(')) groups[groups.length - 1].push(token);
      else groups.push([token], []);
    }
    return JSON.stringify(groups.map((group) => group.toSorted()));
  };
  if (fingerprint(originalTokens) !== fingerprint(replacementTokens)) return false;
  // Also reject incomplete/new markup or interpolation delimiters.
  const residue = (text: string) => text.replace(syntaxPattern, '').match(/\{\{|\}\}|<|>|\$t\(/g) ?? [];
  return JSON.stringify(residue(original)) === JSON.stringify(residue(replacement));
}

export function normalizeTranslationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createTranslationMatcher(entries: TranslationEntry[]) {
  const exact = new Map<string, TranslationEntry[]>();
  const interpolated: { entry: TranslationEntry; pattern: RegExp }[] = [];
  for (const entry of entries) {
    const visible = normalizeTranslationText(entry.text.replace(/<\/?[A-Za-z0-9][^>]*>/g, ''));
    if (!visible) continue;
    if (visible.includes('{{')) {
      // Literal fragments are escaped before becoming a regex. Require some
      // actual copy so a bare {{name}} never matches arbitrary user content.
      const fragments = visible.split(/\{\{[^}]+\}\}/g);
      if (fragments.join('').trim().length < 4) continue;
      const pattern = fragments.map((fragment) => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
      interpolated.push({ entry, pattern: new RegExp(`^${pattern}$`, 'u') });
    } else {
      const matches = exact.get(visible) ?? [];
      matches.push(entry);
      exact.set(visible, matches);
    }
  }
  return (text: string): TranslationEntry[] => {
    const normalized = normalizeTranslationText(text);
    // Literal copy can collide with a different key's rendered interpolation.
    // Retain both so inspection never silently chooses the wrong source key.
    return [
      ...(exact.get(normalized) ?? []),
      ...interpolated.filter(({ pattern }) => pattern.test(normalized)).map(({ entry }) => entry),
    ];
  };
}
