// Parses query params off deep links (com.boardsesh.app://...?...) such as
// the OAuth redirects openAuthSessionAsync hands back. Deliberately avoids
// `new URL().searchParams` (incomplete under Hermes) and expo-linking (native
// imports break node-env unit tests).
export function parseDeepLinkQueryParams(url: string): Map<string, string> {
  // A repeated name keeps its last value.
  return new Map(parseDeepLinkQueryEntries(url));
}

/**
 * Every name/value pair in a deep link's query, decoded, in order, with a
 * repeated name once per copy. The one decoder behind `parseDeepLinkQueryParams`,
 * for callers that must refuse a duplicated param rather than pick one
 * (`board-deep-link.ts`). A pair with malformed percent-encoding is skipped.
 */
export function parseDeepLinkQueryEntries(url: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return entries;
  }

  const hashIndex = url.indexOf('#', queryIndex);
  const queryString = url.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);

  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const equalsIndex = pair.indexOf('=');
    const rawKey = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? '' : pair.slice(equalsIndex + 1);
    try {
      entries.push([decodeURIComponent(rawKey), decodeURIComponent(rawValue.replace(/\+/g, ' '))]);
    } catch {
      // Malformed percent-encoding — skip the pair rather than fail the flow.
    }
  }

  return entries;
}
