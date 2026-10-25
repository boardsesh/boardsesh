import { describe, expect, it } from 'vite-plus/test';
import { redactShareCapabilitiesFromEvent } from '../observability/redact-share-capabilities';
import {
  carriesShareCapability,
  redactShareCapabilities,
  scrubShareCapabilitiesFromEvent,
  scrubShareCapabilityParams,
} from '../share-capability';

const WALL = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f';
const INVITE = 'Ab3_dE-fGhIjKlMnOpQrSt';
const ORIGIN = 'https://www.boardsesh.com';

/** The sign-in page carrying a share link back, the way `board-invite-sign-in.tsx` builds it. */
function signInCarrying(path: string): string {
  return `${ORIGIN}/auth/login?callbackUrl=${encodeURIComponent(path)}`;
}

describe('scrubShareCapabilityParams', () => {
  it('drops a top-level wall or invite pair and keeps every other param in order', () => {
    expect(scrubShareCapabilityParams(`${ORIGIN}/b/garage/40/list?wall=${WALL}&src=qr&medium=board`)).toBe(
      `${ORIGIN}/b/garage/40/list?src=qr&medium=board`,
    );
    expect(scrubShareCapabilityParams(`${ORIGIN}/b/garage?src=qr&invite=${INVITE}&utm_source=ig`)).toBe(
      `${ORIGIN}/b/garage?src=qr&utm_source=ig`,
    );
  });

  it('drops the question mark when the capability was the only param, and keeps a hash', () => {
    expect(scrubShareCapabilityParams(`${ORIGIN}/b/garage?wall=${WALL}`)).toBe(`${ORIGIN}/b/garage`);
    expect(scrubShareCapabilityParams(`/poster/b/garage?wall=${WALL}#print`)).toBe('/poster/b/garage#print');
  });

  it('drops a repeated, upper-cased or empty capability param', () => {
    expect(scrubShareCapabilityParams(`/b/garage?wall=${WALL}&wall=${WALL}&WALL=${WALL}&wall=&angle=40`)).toBe(
      '/b/garage?angle=40',
    );
  });

  it('keeps the exact encoding of the params it leaves', () => {
    const url = `/b/garage?q=crimp%20line&utm_campaign=spring+sale&wall=${WALL}&empty=&flag`;
    expect(scrubShareCapabilityParams(url)).toBe('/b/garage?q=crimp%20line&utm_campaign=spring+sale&empty=&flag');
  });

  it('redacts a capability inside an encoded sign-in return URL, nested more than once', () => {
    const once = signInCarrying(`/b/garage/40/list?wall=${WALL}`);
    const twice = signInCarrying(`/auth/login?callbackUrl=${encodeURIComponent(`/b/garage?invite=${INVITE}`)}`);
    for (const url of [once, twice]) {
      const scrubbed = scrubShareCapabilityParams(url);
      expect(scrubbed).not.toContain(WALL);
      expect(scrubbed).not.toContain(INVITE);
      expect(scrubbed.startsWith(`${ORIGIN}/auth/login?callbackUrl=`)).toBe(true);
    }
  });

  it('redacts an unencoded capability inside another param value', () => {
    expect(scrubShareCapabilityParams(`/auth/login?callbackUrl=/b/garage?wall=${WALL}`)).not.toContain(WALL);
  });

  it('leaves a URL with no capability as the same string', () => {
    const url = `${ORIGIN}/gym/the-crag?src=qr&medium=board&utm_source=poster&utm_medium=print`;
    expect(scrubShareCapabilityParams(url)).toBe(url);
    expect(scrubShareCapabilityParams('')).toBe('');
  });

  it('never throws on a malformed or relative URL', () => {
    for (const url of [
      `%E0%A4%A?wall=${WALL}`,
      `?%E0%A4%A=1&wall=${WALL}`,
      `http://[::1?wall=${WALL}`,
      `wall=${WALL}`,
      `not a url wall%3D${WALL}`,
      `??wall=${WALL}&&`,
    ]) {
      expect(() => scrubShareCapabilityParams(url)).not.toThrow();
      expect(scrubShareCapabilityParams(url)).not.toContain(WALL);
    }
  });
});

describe('scrubShareCapabilitiesFromEvent', () => {
  // The shape posthog-js-lite's before_send hands over: the SDK's own URL
  // properties already stamped, and $set / $set_once both at the top level and
  // inside properties (the SDK writes the top-level copies back after the hook).
  function eventLandingOn(currentUrl: string, referrer: string) {
    return {
      uuid: '0192d2a4-0000-7000-8000-000000000000',
      event: '$pageview',
      timestamp: new Date('2026-10-25T12:00:00Z'),
      properties: {
        $current_url: currentUrl,
        $referrer: referrer,
        $referring_domain: 'www.boardsesh.com',
        $host: 'www.boardsesh.com',
        $pathname: '/b/garage/40/list',
        utm_source: 'poster',
        $set: { $current_url: currentUrl },
        $set_once: { $initial_current_url: currentUrl, $initial_referrer: referrer },
        nested: { urls: [currentUrl, { href: referrer }] },
      },
      $set: { $current_url: currentUrl },
      $set_once: { $initial_current_url: currentUrl, $initial_referrer: referrer },
    };
  }

  it('leaves no wall uuid anywhere in the event', () => {
    const event = eventLandingOn(
      `${ORIGIN}/b/garage/40/list?wall=${WALL}&src=qr&medium=board`,
      signInCarrying(`/b/garage?wall=${WALL}`),
    );
    const scrubbed = scrubShareCapabilitiesFromEvent(event);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(WALL);
    expect(serialized).not.toMatch(/wall=[^[]/);
    expect(scrubbed?.properties.$current_url).toBe(`${ORIGIN}/b/garage/40/list?src=qr&medium=board`);
    expect(scrubbed?.$set_once.$initial_current_url).toBe(`${ORIGIN}/b/garage/40/list?src=qr&medium=board`);
  });

  it('leaves no invite token anywhere in the event', () => {
    const event = eventLandingOn(
      `${ORIGIN}/b/garage?invite=${INVITE}&utm_source=poster`,
      signInCarrying(`/b/garage?invite=${INVITE}`),
    );
    const serialized = JSON.stringify(scrubShareCapabilitiesFromEvent(event));
    expect(serialized).not.toContain(INVITE);
    expect(serialized).toContain('utm_source=poster');
  });

  it('keeps every other property, the timestamp as a Date, and the attribution params', () => {
    const event = eventLandingOn(`${ORIGIN}/b/garage/40/list?wall=${WALL}&src=qr&medium=board`, '');
    const scrubbed = scrubShareCapabilitiesFromEvent(event);
    expect(scrubbed?.timestamp).toBeInstanceOf(Date);
    expect(scrubbed?.uuid).toBe(event.uuid);
    expect(scrubbed?.event).toBe('$pageview');
    expect(scrubbed?.properties.$pathname).toBe('/b/garage/40/list');
    expect(scrubbed?.properties.utm_source).toBe('poster');
    expect(JSON.stringify(scrubbed)).toContain('src=qr&medium=board');
  });

  it('hands back the same object for an event that carries no capability, and passes null through', () => {
    const event = eventLandingOn(`${ORIGIN}/gym/the-crag?src=qr&medium=board`, `${ORIGIN}/`);
    expect(scrubShareCapabilitiesFromEvent(event)).toBe(event);
    expect(scrubShareCapabilitiesFromEvent(null)).toBeNull();
  });
});

describe("the wall photo's path", () => {
  // The wall and climb pages embed `/api/v1/spray-walls/{uuid}/photo` as an image,
  // and Sentry's page-load trace records it as a `resource.img` span beside the
  // page path that names the slug: slug plus uuid is the whole share link.
  const photoPath = `/api/v1/spray-walls/${WALL}/photo`;

  it('redacts the uuid in the path, raw or encoded, and keeps the route template', () => {
    expect(carriesShareCapability(photoPath)).toBe(true);
    expect(redactShareCapabilities(`${ORIGIN}${photoPath}?look=wall-crop`)).toBe(
      `${ORIGIN}/api/v1/spray-walls/[redacted]/photo?look=wall-crop`,
    );
    expect(redactShareCapabilities(encodeURIComponent(photoPath))).toBe(
      encodeURIComponent('/api/v1/spray-walls/[redacted]/photo').replace('%5Bredacted%5D', '[redacted]'),
    );
    expect(scrubShareCapabilityParams(`${ORIGIN}${photoPath}`)).toBe(`${ORIGIN}/api/v1/spray-walls/[redacted]/photo`);
    const template = 'GET /api/v1/spray-walls/[wall_uuid]/photo';
    expect(redactShareCapabilities(template)).toBe(template);
  });

  it('scrubs it from a Sentry page-load transaction', () => {
    const transaction = {
      type: 'transaction',
      transaction: '/b/[board_slug]/[angle]/list',
      request: { url: `${ORIGIN}/b/garage/40/list?wall=${WALL}` },
      spans: [
        {
          op: 'resource.img',
          description: photoPath,
          data: { 'url.full': `${ORIGIN}${photoPath}`, 'url.same_origin': true },
        },
      ],
    };
    const scrubbed = redactShareCapabilitiesFromEvent(transaction);
    expect(JSON.stringify(scrubbed)).not.toContain(WALL);
    expect(scrubbed.spans[0].description).toBe('/api/v1/spray-walls/[redacted]/photo');
    expect(scrubbed.transaction).toBe('/b/[board_slug]/[angle]/list');
  });
});

describe('redactShareCapabilities and the Sentry processor', () => {
  it('finds and redacts a wall uuid as its own param and inside an encoded return URL', () => {
    expect(carriesShareCapability(`?wall=${WALL}`)).toBe(true);
    expect(carriesShareCapability(`?callbackUrl=${encodeURIComponent(`/b/garage?wall=${WALL}`)}`)).toBe(true);
    expect(carriesShareCapability('?src=qr&medium=kiosk')).toBe(false);
    expect(redactShareCapabilities(`${ORIGIN}/b/garage?wall=${WALL}&src=qr`)).toBe(
      `${ORIGIN}/b/garage?wall=[redacted]&src=qr`,
    );
  });

  it('scrubs a wall uuid from a Sentry event wherever a URL landed, and keeps it valid JSON', () => {
    const event = {
      request: { url: `${ORIGIN}/b/garage/40/list?wall=${WALL}`, query_string: `wall=${WALL}&src=qr` },
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: `/b/garage/40/view/abc?wall=${WALL}` } }],
      message: `Failed on "${ORIGIN}/b/garage?wall=${WALL}"`,
    };
    const scrubbed = redactShareCapabilitiesFromEvent(event);
    expect(JSON.stringify(scrubbed)).not.toContain(WALL);
    expect(scrubbed.request.query_string).toBe('wall=[redacted]&src=qr');
    expect(scrubbed.message).toBe(`Failed on "${ORIGIN}/b/garage?wall=[redacted]"`);
  });
});
