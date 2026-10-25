import { BOARD_INVITE_PARAM } from './board-invite';
import { WALL_CAPABILITY_PARAM } from './spray/spray-visibility';

/**
 * The query params whose value IS an access capability: whoever holds the URL
 * gets in.
 *
 *   ?invite=  a home board's share link (`board-invite.ts`): joins the board.
 *   ?wall=    an unlisted Spraywall's share link (`spray/spray-visibility.ts`):
 *             the wall's uuid, which opens the wall and its climbs. The same
 *             uuid also rides in the wall photo's path (`WALL_UUID_PATH`).
 *
 * Neither may reach a third party. Sentry and PostHog both copy page URLs onto
 * what they send (`request.url`, breadcrumbs, `$current_url`, `$referrer`), so
 * both run every payload through the functions below. Pure and dependency-free,
 * like the two modules it reads, so the server, edge and browser configs share
 * one rule.
 */
export const SHARE_CAPABILITY_PARAMS: readonly string[] = [BOARD_INVITE_PARAM, WALL_CAPABILITY_PARAM];

const PARAM_NAMES = SHARE_CAPABILITY_PARAMS.join('|');

/**
 * A capability pair, raw or percent-encoded in a nested return URL (a sign-in
 * page's `callbackUrl`, encoded once or more). The value runs to the next
 * separator, so inside an encoded return URL the rest of that URL goes too;
 * over-redacting is the safe side. A backslash ends the value as well, so a
 * pair inside an escaped JSON string never eats the escape.
 */
const CAPABILITY_PAIR = new RegExp(`((?:${PARAM_NAMES})(?:=|%(?:25)*3D))[^&#\\s"'\\\\]*`, 'gi');
const CAPABILITY_NAME = new RegExp(`^(?:${PARAM_NAMES})$`, 'i');

/**
 * The one PATH that carries a wall's uuid: the unlisted wall's photo redirect,
 * `/api/v1/spray-walls/{uuid}/photo` (`spray-wall-render-data.server.ts`), which
 * the wall and climb pages embed as an image. Sentry records it as a sampled page
 * load's `resource.img` span (name and `url.full`) and as that route's
 * `request.url`, next to the page path that names the slug, and slug plus uuid is
 * the whole share link. Raw or encoded slashes; the route template Sentry names
 * the server transaction by (`[wall_uuid]`) is left alone.
 */
const WALL_UUID_PATH = /((?:\/|%(?:25)*2F)spray-walls(?:\/|%(?:25)*2F))(?!\[)(?:(?!%(?:25)*2F)[^/?#&\s"'\\])+/gi;

/** Whether the text carries a capability anywhere, raw or encoded. */
export function carriesShareCapability(text: string): boolean {
  CAPABILITY_PAIR.lastIndex = 0;
  WALL_UUID_PATH.lastIndex = 0;
  return CAPABILITY_PAIR.test(text) || WALL_UUID_PATH.test(text);
}

/** The same text with every capability value replaced, for anything that leaves the app. */
export function redactShareCapabilities(text: string): string {
  return text.replace(CAPABILITY_PAIR, '$1[redacted]').replace(WALL_UUID_PATH, '$1[redacted]');
}

function decodeParamName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * A URL with its capability params removed and everything else left as it was.
 *
 * A top-level `wall=` or `invite=` pair is dropped, so
 * `/b/garage/40/list?wall=<uuid>&src=qr` comes back as `/b/garage/40/list?src=qr`
 * and an analytics breakdown by URL still groups every visit to one page. A
 * capability nested inside another param's value (`?callbackUrl=%2Fb%2Fgarage%3Fwall%3D…`)
 * is redacted in place, because taking a pair out of an encoded URL would mean
 * re-encoding it. The other params keep their order and their exact encoding.
 *
 * String surgery rather than `new URL()`: the input is whatever a browser or
 * SDK put in a property, relative or malformed included, and this never throws.
 */
export function scrubShareCapabilityParams(url: string): string {
  if (!carriesShareCapability(url)) return url;

  const hashStart = url.indexOf('#');
  const beforeHash = hashStart === -1 ? url : url.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : url.slice(hashStart);
  const queryStart = beforeHash.indexOf('?');
  if (queryStart === -1) return redactShareCapabilities(url);

  const keptPairs = beforeHash
    .slice(queryStart + 1)
    .split('&')
    .filter((pair) => !CAPABILITY_NAME.test(decodeParamName(pair.split('=', 1)[0])))
    .map(redactShareCapabilities);
  const query = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';

  return `${redactShareCapabilities(beforeHash.slice(0, queryStart))}${query}${redactShareCapabilities(hash)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Scrub every string under `value`, keeping the same reference wherever nothing changed.
 * `ancestors` guards against a circular reference: an object already on the path is returned as is.
 */
function scrubDeep(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubShareCapabilityParams(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) return value;
  if (Array.isArray(value)) {
    ancestors.add(value);
    let changed = false;
    const scrubbed = value.map((item) => {
      const next = scrubDeep(item, ancestors);
      if (next !== item) changed = true;
      return next;
    });
    ancestors.delete(value);
    return changed ? scrubbed : value;
  }
  // Dates (the event timestamp) and anything else that is not plain JSON pass through.
  if (!isPlainObject(value)) return value;
  ancestors.add(value);
  let changed = false;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = scrubDeep(item, ancestors);
    if (next !== item) changed = true;
    scrubbed[key] = next;
  }
  ancestors.delete(value);
  return changed ? scrubbed : value;
}

/**
 * PostHog `before_send` hook: no event leaves the browser carrying a capability.
 *
 * posthog-js-lite stamps the full `location.href` (`$current_url`) and
 * `document.referrer` (`$referrer`) on every event, and PostHog derives the
 * person's `$initial_current_url` / `$initial_referrer` and the session's entry
 * URL from those two at ingestion. The hook sees the event after the SDK has
 * added them, so every string in it is scrubbed: the properties, and the
 * `$set` / `$set_once` copies the SDK writes back over `properties.$set` after
 * the hook returns. An event that carries no capability (nearly all of them)
 * comes back as the same object.
 */
export function scrubShareCapabilitiesFromEvent<TEvent extends object>(event: TEvent | null): TEvent | null {
  if (!event) return event;
  return scrubDeep(event) as TEvent;
}
