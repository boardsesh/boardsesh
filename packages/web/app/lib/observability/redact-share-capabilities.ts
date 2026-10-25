import { carriesShareCapability, redactShareCapabilities } from '../share-capability';

/**
 * Sentry event processor: a share link's capability (a home board's `?invite=`
 * token, an unlisted Spraywall's `?wall=` uuid) never reaches an error report, a
 * transaction or a breadcrumb.
 *
 * The capability rides in a page URL (`/b/{slug}?invite=…`, `/b/{slug}/40/list?wall=…`)
 * and, encoded, in the sign-in page's `callbackUrl`, and Sentry copies URLs into
 * `request.url`, `request.query_string`, span attributes and navigation
 * breadcrumbs. `sendDefaultPii: false` masks only parameters whose NAMES look
 * sensitive, and neither `invite` nor `wall` is one of them. One serialized pass
 * covers every place a URL can land; an event that never mentions either (nearly
 * all of them) comes back untouched.
 */
export function redactShareCapabilitiesFromEvent<TEvent>(event: TEvent): TEvent {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event);
  } catch {
    return event;
  }
  if (!serialized || !carriesShareCapability(serialized)) return event;
  return JSON.parse(redactShareCapabilities(serialized)) as TEvent;
}
