// Parses query params off deep links (com.boardsesh.app://...?...) such as
// the OAuth redirects openAuthSessionAsync hands back. Deliberately avoids
// `new URL().searchParams` (incomplete under Hermes) and expo-linking (native
// imports break node-env unit tests).
export function parseDeepLinkQueryParams(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return params;
  }

  const hashIndex = url.indexOf('#', queryIndex);
  const queryString = url.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);

  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const equalsIndex = pair.indexOf('=');
    const rawKey = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? '' : pair.slice(equalsIndex + 1);
    try {
      params.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      // Malformed percent-encoding — skip the pair rather than fail the flow.
    }
  }

  return params;
}
