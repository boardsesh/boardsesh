import { describe, it, expect } from 'vitest';
import {
  GYM_FUNNEL_EVENTS,
  GYM_QR_MEDIUMS,
  GYM_QR_MEDIUM_PARAM,
  GYM_QR_SRC_PARAM,
  GYM_QR_SRC_VALUE,
  buildGymQrHref,
  gymClaimCtaClicked,
  gymClaimResult,
  gymClaimSubmitted,
  gymDirectorySearched,
  gymManageTabViewed,
  gymPageCtaClicked,
  gymQrScanned,
  parseGymQrLanding,
  stripGymQrParams,
} from '../gym-funnel';

// Every payload this module can produce, built once so the cross-cutting
// assertions (no location precision, values stay primitive) cover all seven
// events instead of whichever one a future edit remembers to add.
const EVERY_PAYLOAD = [
  gymClaimCtaClicked({ placement: 'gym-page', viewerState: 'signed-out', gymUuid: 'gym-1' }),
  gymClaimSubmitted({ method: 'domain', gymUuid: 'gym-1' }),
  gymClaimResult({ status: 'admin_review', gymUuid: 'gym-1' }),
  gymQrScanned({ medium: 'poster', gymSlug: 'boulderwelt' }),
  gymPageCtaClicked({ cta: 'follow', gymUuid: 'gym-1' }),
  gymManageTabViewed({ tab: 'kiosks' }),
  gymDirectorySearched({ queryLength: 7, boardTypes: ['tension'], hasGeo: true, resultsCount: 3 }),
];

describe('GYM_FUNNEL_EVENTS', () => {
  // Asserted verbatim: a one-character drift here does not fail anything at
  // runtime, it just splits one PostHog funnel into two that nobody notices.
  it('spells every event name exactly as the contract declares', () => {
    expect(GYM_FUNNEL_EVENTS).toEqual({
      ClaimCtaClicked: 'Gym Claim CTA Clicked',
      ClaimSubmitted: 'Gym Claim Submitted',
      ClaimResult: 'Gym Claim Result',
      QrScanned: 'Gym QR Scanned',
      PageCtaClicked: 'Gym Page CTA Clicked',
      DirectorySearched: 'Gym Directory Searched',
      ManageTabViewed: 'Gym Manage Tab Viewed',
    });
  });

  it('has seven distinct names', () => {
    const names = Object.values(GYM_FUNNEL_EVENTS);
    expect(names).toHaveLength(7);
    expect(new Set(names).size).toBe(7);
  });
});

describe('payload builders', () => {
  // EVERY_PAYLOAD is hand-maintained and the key-set assertion below is built
  // FROM it, so an eighth builder added later would silently escape every
  // cross-cutting check in this file — including the no-coordinates one. Pin the
  // list to the event catalog so forgetting to extend it fails here instead.
  it('covers every event in the catalog', () => {
    expect(new Set(EVERY_PAYLOAD.map((payload) => payload.name))).toEqual(new Set(Object.values(GYM_FUNNEL_EVENTS)));
  });

  it('pairs each name with its own property set', () => {
    expect(gymClaimCtaClicked({ placement: 'preview-sheet', viewerState: 'signed-in', gymUuid: 'gym-9' })).toEqual({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'preview-sheet', viewerState: 'signed-in', gymUuid: 'gym-9' },
    });

    expect(gymClaimSubmitted({ method: 'admin', gymUuid: 'gym-9' })).toEqual({
      name: 'Gym Claim Submitted',
      properties: { method: 'admin', gymUuid: 'gym-9' },
    });

    expect(gymClaimResult({ status: 'email_sent', gymUuid: 'gym-9' })).toEqual({
      name: 'Gym Claim Result',
      properties: { status: 'email_sent', gymUuid: 'gym-9' },
    });

    expect(gymQrScanned({ medium: 'kiosk', gymSlug: 'boulderwelt' })).toEqual({
      name: 'Gym QR Scanned',
      properties: { medium: 'kiosk', gymSlug: 'boulderwelt' },
    });

    expect(gymPageCtaClicked({ cta: 'report-duplicate', gymUuid: 'gym-9' })).toEqual({
      name: 'Gym Page CTA Clicked',
      properties: { cta: 'report-duplicate', gymUuid: 'gym-9' },
    });

    expect(gymManageTabViewed({ tab: 'branding' })).toEqual({
      name: 'Gym Manage Tab Viewed',
      properties: { tab: 'branding' },
    });
  });

  it('emits exactly the documented property keys', () => {
    const keysByName = Object.fromEntries(
      EVERY_PAYLOAD.map((payload) => [payload.name, Object.keys(payload.properties).sort()]),
    );

    expect(keysByName).toEqual({
      'Gym Claim CTA Clicked': ['gymUuid', 'placement', 'viewerState'],
      'Gym Claim Submitted': ['gymUuid', 'method'],
      'Gym Claim Result': ['gymUuid', 'status'],
      'Gym QR Scanned': ['gymSlug', 'medium'],
      'Gym Page CTA Clicked': ['cta', 'gymUuid'],
      'Gym Manage Tab Viewed': ['tab'],
      'Gym Directory Searched': ['boardTypes', 'hasGeo', 'queryLength', 'resultsCount'],
    });
  });

  // `hasGeo` is the ONLY geo-adjacent property the contract permits, and it is
  // permitted precisely because it is a bare boolean — "did this search use
  // location", never where. It is allow-listed out of the scan below by exact
  // key name (not by weakening the pattern) and separately pinned to a boolean.
  const GEO_ALLOWED_KEY = 'hasGeo';

  it('only ever carries geo as the allow-listed boolean', () => {
    const geoEntries = EVERY_PAYLOAD.flatMap((payload) =>
      Object.entries(payload.properties).filter(([key]) => key === GEO_ALLOWED_KEY),
    );
    expect(geoEntries).toHaveLength(1);
    for (const [, value] of geoEntries) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('never emits a property that could carry location precision', () => {
    // Run over the SERIALISED payload, not just top-level `Object.keys`: a
    // nested object or an array would hide a coordinate key from a key scan,
    // and the whole point is that no builder can ever grow one.
    const forbidden = /lat|lon|lng|coord|accuracy|precision|position|geo|gps|distance|bearing|altitude|radius/i;
    for (const payload of EVERY_PAYLOAD) {
      const scannable = Object.fromEntries(
        Object.entries(payload.properties).filter(([key]) => key !== GEO_ALLOWED_KEY),
      );
      const serialised = JSON.stringify({ name: payload.name, properties: scannable });
      expect(forbidden.test(serialised), `${payload.name} serialises to "${serialised}"`).toBe(false);
    }
  });

  it('never emits a value shaped like a coordinate', () => {
    // A forbidden-key scan cannot catch `gymSlug: '52.37,4.89'`. Decimal degrees
    // and coordinate pairs are checked on the values themselves.
    const coordinatePair = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
    const decimalDegrees = /-?\d{1,3}\.\d{4,}/;
    for (const payload of EVERY_PAYLOAD) {
      for (const [key, value] of Object.entries(payload.properties)) {
        if (typeof value !== 'string') continue;
        expect(coordinatePair.test(value), `${payload.name}.${key} = "${value}"`).toBe(false);
        expect(decimalDegrees.test(value), `${payload.name}.${key} = "${value}"`).toBe(false);
      }
    }
  });

  it('keeps every property value a primitive web track() can forward', () => {
    for (const payload of EVERY_PAYLOAD) {
      for (const value of Object.values(payload.properties)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });
});

describe('gymDirectorySearched', () => {
  it('sorts and comma-joins boardTypes so one filter combination is one PostHog value', () => {
    const { properties } = gymDirectorySearched({
      queryLength: 4,
      boardTypes: ['tension', 'moonboard', 'kilter'],
      hasGeo: false,
      resultsCount: 12,
    });
    expect(properties.boardTypes).toBe('kilter,moonboard,tension');
  });

  it('produces the same string regardless of the caller order', () => {
    const first = gymDirectorySearched({ queryLength: 0, boardTypes: ['b', 'a'], hasGeo: false, resultsCount: 0 });
    const second = gymDirectorySearched({ queryLength: 0, boardTypes: ['a', 'b'], hasGeo: false, resultsCount: 0 });
    expect(first.properties.boardTypes).toBe(second.properties.boardTypes);
  });

  it('does not mutate the caller array while sorting', () => {
    const boardTypes = ['tension', 'kilter'];
    gymDirectorySearched({ queryLength: 1, boardTypes, hasGeo: false, resultsCount: 1 });
    expect(boardTypes).toEqual(['tension', 'kilter']);
  });

  it('turns an empty selection into an empty string, not undefined', () => {
    const { properties } = gymDirectorySearched({
      queryLength: 0,
      boardTypes: [],
      hasGeo: false,
      resultsCount: 0,
    });
    // `undefined` would be stripped before ingest, making "no board filter"
    // indistinguishable from "the property was never sent".
    expect(properties.boardTypes).toBe('');
    expect(Object.keys(properties)).toContain('boardTypes');
  });

  it('reports geo as a bare boolean', () => {
    expect(
      gymDirectorySearched({ queryLength: 3, boardTypes: [], hasGeo: true, resultsCount: 1 }).properties.hasGeo,
    ).toBe(true);
  });
});

describe('parseGymQrLanding', () => {
  it('recognises every known medium', () => {
    for (const medium of GYM_QR_MEDIUMS) {
      expect(parseGymQrLanding({ [GYM_QR_SRC_PARAM]: GYM_QR_SRC_VALUE, [GYM_QR_MEDIUM_PARAM]: medium })).toEqual({
        medium,
      });
    }
  });

  it('ignores other params on the URL', () => {
    expect(parseGymQrLanding({ src: 'qr', medium: 'board', tab: 'boards' })).toEqual({ medium: 'board' });
  });

  it('rejects a src that is not exactly "qr"', () => {
    expect(parseGymQrLanding({ src: 'QR', medium: 'poster' })).toBeNull();
    expect(parseGymQrLanding({ src: ' qr', medium: 'poster' })).toBeNull();
    expect(parseGymQrLanding({ src: 'email', medium: 'poster' })).toBeNull();
  });

  it('rejects an unknown medium', () => {
    expect(parseGymQrLanding({ src: 'qr', medium: 'billboard' })).toBeNull();
    expect(parseGymQrLanding({ src: 'qr', medium: '' })).toBeNull();
  });

  it('rejects an array-valued src', () => {
    expect(parseGymQrLanding({ src: ['qr', 'qr'], medium: 'poster' })).toBeNull();
    expect(parseGymQrLanding({ src: ['qr'], medium: 'poster' })).toBeNull();
  });

  it('rejects an array-valued medium', () => {
    expect(parseGymQrLanding({ src: 'qr', medium: ['kiosk', 'poster'] })).toBeNull();
    expect(parseGymQrLanding({ src: 'qr', medium: ['kiosk'] })).toBeNull();
  });

  it('rejects a missing param', () => {
    expect(parseGymQrLanding({ src: 'qr' })).toBeNull();
    expect(parseGymQrLanding({ medium: 'poster' })).toBeNull();
    expect(parseGymQrLanding({ src: undefined, medium: undefined })).toBeNull();
  });

  it('rejects an empty search-param object', () => {
    expect(parseGymQrLanding({})).toBeNull();
  });

  it('ignores params inherited from a prototype', () => {
    const prototype = { [GYM_QR_SRC_PARAM]: GYM_QR_SRC_VALUE, [GYM_QR_MEDIUM_PARAM]: 'poster' };
    const inherited = Object.create(prototype) as Record<string, string | string[] | undefined>;
    expect(inherited[GYM_QR_SRC_PARAM]).toBe(GYM_QR_SRC_VALUE);
    expect(parseGymQrLanding(inherited)).toBeNull();
  });
});

describe('buildGymQrHref', () => {
  it('opens a query string when the path has none', () => {
    expect(buildGymQrHref('/gym/boulderwelt', 'poster')).toBe('/gym/boulderwelt?src=qr&medium=poster');
  });

  it('appends to an existing query string', () => {
    expect(buildGymQrHref('/gym/boulderwelt?tab=boards', 'kiosk')).toBe(
      '/gym/boulderwelt?tab=boards&src=qr&medium=kiosk',
    );
  });

  // This output is printed on laminated posters. A href that lands the params
  // inside the fragment reaches no server and fires nothing, and cannot be
  // patched once the poster is on a wall.
  it('puts the params BEFORE a fragment, not inside it', () => {
    expect(buildGymQrHref('/gym/boulderwelt#boards', 'poster')).toBe('/gym/boulderwelt?src=qr&medium=poster#boards');
  });

  it('keeps other params when the path has both a query and a fragment', () => {
    expect(buildGymQrHref('/gym/boulderwelt?tab=boards#comments', 'poster')).toBe(
      '/gym/boulderwelt?tab=boards&src=qr&medium=poster#comments',
    );
  });

  // `?src=email&src=qr` arrives as a string[], which parseGymQrLanding rejects.
  it('replaces a pre-existing src instead of duplicating it', () => {
    expect(buildGymQrHref('/gym/boulderwelt?src=email', 'poster')).toBe('/gym/boulderwelt?src=qr&medium=poster');
  });

  it('replaces a pre-existing medium and keeps unrelated params', () => {
    expect(buildGymQrHref('/gym/boulderwelt?medium=email&tab=boards', 'kiosk')).toBe(
      '/gym/boulderwelt?tab=boards&src=qr&medium=kiosk',
    );
  });

  it('survives a fragment plus both QR params already present', () => {
    const href = buildGymQrHref('/gym/boulderwelt?src=email&medium=newsletter#boards', 'board');
    expect(href).toBe('/gym/boulderwelt?src=qr&medium=board#boards');

    const query = href.slice(href.indexOf('?') + 1, href.indexOf('#'));
    expect(parseGymQrLanding(Object.fromEntries(new URLSearchParams(query).entries()))).toEqual({ medium: 'board' });
  });

  it('round-trips through parseGymQrLanding for every medium', () => {
    for (const medium of GYM_QR_MEDIUMS) {
      const href = buildGymQrHref('/b/some-board', medium);
      const search = new URLSearchParams(href.slice(href.indexOf('?')));
      expect(parseGymQrLanding(Object.fromEntries(search.entries()))).toEqual({ medium });
    }
  });
});

describe('stripGymQrParams', () => {
  it('removes both params and leaves the rest in order', () => {
    expect(stripGymQrParams('?tab=boards&src=qr&medium=poster&sort=name')).toBe('?tab=boards&sort=name');
  });

  it('returns an empty string when the QR params were the only ones', () => {
    expect(stripGymQrParams('?src=qr&medium=kiosk')).toBe('');
  });

  it('accepts a search string with no leading question mark', () => {
    expect(stripGymQrParams('src=qr&medium=board&tab=boards')).toBe('?tab=boards');
  });

  it('leaves a search string without QR params untouched', () => {
    expect(stripGymQrParams('?tab=boards')).toBe('?tab=boards');
  });

  // The result goes straight into the address bar via history.replaceState, so
  // a param we are NOT touching must not visibly change shape. Round-tripping
  // through URLSearchParams would rewrite both of these.
  it('preserves percent-encoding rather than re-encoding it', () => {
    expect(stripGymQrParams('?q=hello%20world&src=qr&medium=poster')).toBe('?q=hello%20world');
  });

  it('preserves a valueless param without adding an equals sign', () => {
    expect(stripGymQrParams('?embed&src=qr&medium=poster')).toBe('?embed');
  });

  it('preserves a repeated unrelated param', () => {
    expect(stripGymQrParams('?tag=a&src=qr&tag=b')).toBe('?tag=a&tag=b');
  });

  it('handles an empty search string', () => {
    expect(stripGymQrParams('')).toBe('');
    expect(stripGymQrParams('?')).toBe('');
  });
});
