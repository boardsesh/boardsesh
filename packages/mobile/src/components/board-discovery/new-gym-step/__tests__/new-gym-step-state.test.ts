import { describe, expect, it } from 'vitest';
import type { PlaceSuggestion, SimilarGym } from '@boardsesh/shared-schema';
import {
  GYM_NAME_MAX_LENGTH,
  MAX_ACKNOWLEDGED_GYM_UUIDS,
  acknowledgeGyms,
  buildCreateGymInput,
  buildNewGymRows,
  canSaveGym,
  duplicateCheckFor,
  pinCaptionFor,
  savableGymName,
  similarGymSubtitle,
  similarGymsLookupInput,
  similarGymsToAsk,
} from '../new-gym-step-state';

const PIN = { latitude: 52.37, longitude: 4.89 };

function similarGym(uuid: string, overrides: Partial<SimilarGym> = {}): SimilarGym {
  return {
    uuid,
    slug: null,
    name: `Gym ${uuid}`,
    address: null,
    website: null,
    distanceMeters: null,
    ownerType: 'USER',
    isClaimable: false,
    canClaimByDomain: false,
    providerOrigins: [],
    ...overrides,
  };
}

describe('the name and the pin', () => {
  it.each([
    { text: '', expected: null },
    { text: '   ', expected: null },
    { text: '  Boulder Space  ', expected: 'Boulder Space' },
    { text: 'B', expected: 'B' },
    { text: 'x'.repeat(GYM_NAME_MAX_LENGTH), expected: 'x'.repeat(GYM_NAME_MAX_LENGTH) },
    { text: 'x'.repeat(GYM_NAME_MAX_LENGTH + 1), expected: null },
  ])('saves "$text" as $expected', ({ text, expected }) => {
    expect(savableGymName(text)).toBe(expected);
  });

  it('needs both a name and a pin to save', () => {
    expect(canSaveGym('Boulder Space', PIN)).toBe(true);
    expect(canSaveGym('Boulder Space', null)).toBe(false);
    expect(canSaveGym('  ', PIN)).toBe(false);
  });
});

describe('"is it one of these?"', () => {
  it('asks once the name has two characters, by name alone until there is a pin', () => {
    expect(similarGymsLookupInput('B', PIN)).toBeNull();
    expect(similarGymsLookupInput(' Bo ', null)).toEqual({ name: 'Bo' });
    expect(similarGymsLookupInput('Boulder', { latitude: 52.370_012_3, longitude: 4.890_049_9 })).toEqual({
      name: 'Boulder',
      latitude: 52.37,
      longitude: 4.89,
    });
  });

  it("drops the gyms the climber said aren't theirs, and prefers a refusal's gyms to the lookup's", () => {
    const lookup = [similarGym('a'), similarGym('b')];
    expect(similarGymsToAsk(lookup, null, ['a']).map((gym) => gym.uuid)).toEqual(['b']);
    expect(similarGymsToAsk(lookup, [similarGym('c')], []).map((gym) => gym.uuid)).toEqual(['c']);
    expect(similarGymsToAsk(undefined, null, [])).toEqual([]);
  });

  it('describes a listed gym by distance and street, either alone', () => {
    expect(similarGymSubtitle(similarGym('a', { distanceMeters: 350, address: 'Fokkerweg 75' }))).toBe(
      '350 m · Fokkerweg 75',
    );
    expect(similarGymSubtitle(similarGym('a', { distanceMeters: 1500 }))).toBe('1.5 km');
    expect(similarGymSubtitle(similarGym('a', { address: '  ' }))).toBeNull();
  });
});

describe('the duplicate check a save sends', () => {
  it('refuses on any similar gym until the climber has dismissed some', () => {
    expect(duplicateCheckFor([])).toEqual({ mode: 'REJECT_IF_FOUND' });
    expect(duplicateCheckFor(['a', 'b'])).toEqual({ mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['a', 'b'] });
  });

  it('adds newly dismissed gyms last, without repeats', () => {
    expect(acknowledgeGyms(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(acknowledgeGyms(['a', 'b', 'c'], ['a'])).toEqual(['b', 'c', 'a']);
  });

  it('keeps only the most recent 50', () => {
    const earlier = Array.from({ length: 49 }, (_, index) => `old-${index}`);
    const next = acknowledgeGyms(earlier, ['new-1', 'new-2', 'new-3']);
    expect(next).toHaveLength(MAX_ACKNOWLEDGED_GYM_UUIDS);
    expect(next.slice(-3)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(next).not.toContain('old-0');
    expect(next).not.toContain('old-1');
  });

  it('builds a public, listed gym with its pin, a trimmed name and the address only when given', () => {
    expect(buildCreateGymInput({ name: ' Boulder Space ', pin: PIN, address: '  ', acknowledged: [] })).toEqual({
      name: 'Boulder Space',
      latitude: 52.37,
      longitude: 4.89,
      isPublic: true,
      isListed: true,
      duplicateCheck: { mode: 'REJECT_IF_FOUND' },
    });
    expect(
      buildCreateGymInput({ name: 'Boulder Space', pin: PIN, address: ' Fokkerweg 75 ', acknowledged: ['a'] }),
    ).toMatchObject({
      address: 'Fokkerweg 75',
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['a'] },
    });
  });
});

describe('the rows', () => {
  const labels = { similarTitle: 'Already listed nearby', similarBody: 'Is it one of these?' };
  const noPlaces = { suggestions: [] as PlaceSuggestion[], label: 'Places', attribution: 'GeoNames' };

  it('is the pin and the address with nothing to ask', () => {
    expect(buildNewGymRows({ places: noPlaces, similar: [], notice: null, labels }).map((row) => row.kind)).toEqual([
      'pin',
      'address',
    ]);
  });

  it('asks about listed gyms above the address, and says why a save failed last', () => {
    const rows = buildNewGymRows({
      places: noPlaces,
      similar: [similarGym('a'), similarGym('b')],
      notice: 'Limit reached',
      labels,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      'pin',
      'sectionHeader',
      'similarIntro',
      'similarGym',
      'similarGym',
      'addNew',
      'address',
      'notice',
    ]);
    expect(rows.filter((row) => row.kind === 'similarGym').map((row) => row.position)).toEqual(['first', 'last']);
  });

  it('lists towns for the search first, with their credit', () => {
    const place: PlaceSuggestion = {
      id: 2755003,
      name: 'Haarlem',
      region: 'North Holland',
      country: 'Netherlands',
      countryCode: 'NL',
      latitude: 52.38,
      longitude: 4.64,
    };
    const rows = buildNewGymRows({
      places: { ...noPlaces, suggestions: [place] },
      similar: [],
      notice: null,
      labels,
    });
    expect(rows.map((row) => row.kind)).toEqual(['sectionHeader', 'place', 'placesAttribution', 'pin', 'address']);
  });
});

describe('the line under the map', () => {
  const base = { mapAvailable: true, zoomedOut: false, deviceCoords: null, placeLabel: null };

  it.each([
    { name: 'nothing yet', args: { ...base, pin: null }, expected: { kind: 'needed' } },
    { name: 'zoomed out', args: { ...base, pin: null, zoomedOut: true }, expected: { kind: 'zoomIn' } },
    {
      name: 'at the climber',
      args: { ...base, pin: { ...PIN, source: 'device' as const }, deviceCoords: PIN },
      expected: { kind: 'atYou' },
    },
    {
      name: 'moved away from the climber',
      args: { ...base, pin: { latitude: 52.38, longitude: 4.89, source: 'map' as const }, deviceCoords: PIN },
      expected: { kind: 'fromYou', distance: '1.1 km' },
    },
    {
      name: 'a town picked',
      args: { ...base, pin: { ...PIN, source: 'town' as const }, placeLabel: 'Amsterdam' },
      expected: { kind: 'nearPlace', place: 'Amsterdam' },
    },
    {
      name: 'a pan with no fix',
      args: { ...base, pin: { ...PIN, source: 'map' as const } },
      expected: { kind: 'set' },
    },
    {
      name: 'no map, nothing yet',
      args: { ...base, mapAvailable: false, pin: null },
      expected: { kind: 'fallbackNeeded' },
    },
    {
      name: 'no map, the device fix',
      args: { ...base, mapAvailable: false, pin: { ...PIN, source: 'device' as const } },
      expected: { kind: 'fallbackYou' },
    },
    {
      name: 'no map, an address',
      args: { ...base, mapAvailable: false, pin: { ...PIN, source: 'address' as const }, placeLabel: 'Fokkerweg 75' },
      expected: { kind: 'fallbackPlace', place: 'Fokkerweg 75' },
    },
  ])('$name', ({ args, expected }) => {
    expect(pinCaptionFor(args)).toEqual(expected);
  });
});
