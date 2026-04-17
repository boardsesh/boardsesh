/**
 * Check whether an Instagram post URL is still embeddable.
 *
 * We probe the post's `/embed/` variant — not the canonical URL — because
 * the canonical URL serves full OG metadata even when the embed renders as
 * the generic "Visit Instagram" placeholder (this happens for posts that
 * exist but are account-restricted to non-logged-in viewers). The
 * `/embed/` HTML is the ground truth: its body contains literal error
 * strings whenever the iframe would render the broken card.
 *
 * Known broken-state strings observed in `/embed/` HTML:
 *   - "The link to this photo or video may be broken"
 *   - "the post may have been removed"
 *   - "sorry, this page isn't available"
 *
 * Detection rules:
 *   - Fetch `<url>/embed/` with the Facebook crawler UA (a browser UA is
 *     rate-limited hard for server-side fetches).
 *   - Non-2xx status → broken.
 *   - Body contains any of the broken markers → broken.
 *   - Otherwise → accessible.
 *
 * On network error / timeout → returns `true` (optimistic). We only hide
 * a link when we've affirmatively determined it's broken; transient
 * errors shouldn't make good links disappear.
 */

const FACEBOOK_CRAWLER_USER_AGENT =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const FETCH_TIMEOUT_MS = 8000;

const BROKEN_EMBED_MARKERS = [
  'may be broken',
  'post may have been',
  "sorry, this page isn't available",
];

function toEmbedUrl(link: string): string {
  // Strip any existing query/hash, ensure trailing slash, append `embed/`.
  const [base] = link.split(/[?#]/);
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return withSlash.endsWith('/embed/') ? withSlash : `${withSlash}embed/`;
}

export async function checkInstagramAccessibility(link: string): Promise<boolean> {
  try {
    const res = await fetch(toEmbedUrl(link), {
      headers: { 'User-Agent': FACEBOOK_CRAWLER_USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.text()).toLowerCase();
    return !BROKEN_EMBED_MARKERS.some((marker) => body.includes(marker));
  } catch {
    // Network error / timeout / aborted — don't hide the link.
    return true;
  }
}
