import { describe, expect, it } from 'vitest';
import { isGymLimitError, readSimilarGymsError } from '../errors';

const clientError = (extensions: Record<string, unknown>) => ({ response: { errors: [{ message: 'x', extensions }] } });
const rethrown = (extensions: Record<string, unknown>) => ({ graphqlErrors: [{ message: 'x', extensions }] });

const listedGym = {
  uuid: 'gym-1',
  slug: 'bahnhof-bloc',
  name: 'Bahnhof Bloc',
  address: 'Bahnhofstrasse 1',
  website: null,
  distanceMeters: 42,
  ownerType: 'SYSTEM',
  isClaimable: true,
  canClaimByDomain: false,
  providerOrigins: ['kilter'],
};

describe('readSimilarGymsError', () => {
  it('reads the named gyms from either error shape', () => {
    const extensions = { code: 'GYM_SIMILAR_EXISTS', candidates: [listedGym] };
    expect(readSimilarGymsError(clientError(extensions))).toEqual([listedGym]);
    expect(readSimilarGymsError(rethrown(extensions))).toEqual([listedGym]);
  });

  it('drops malformed entries and fills missing optional fields, but still reports the refusal', () => {
    expect(
      readSimilarGymsError(
        clientError({
          code: 'GYM_SIMILAR_EXISTS',
          candidates: [null, { name: 'No uuid' }, { uuid: 'gym-2', name: 'Bare', ownerType: 'SOMETHING_NEW' }],
        }),
      ),
    ).toEqual([
      {
        uuid: 'gym-2',
        name: 'Bare',
        slug: null,
        address: null,
        website: null,
        distanceMeters: null,
        ownerType: 'USER',
        isClaimable: false,
        canClaimByDomain: false,
        providerOrigins: [],
      },
    ]);
    expect(readSimilarGymsError(clientError({ code: 'GYM_SIMILAR_EXISTS' }))).toEqual([]);
  });

  it('is null for any other error', () => {
    expect(readSimilarGymsError(clientError({ code: 'BOARD_EXISTING_WALLS' }))).toBeNull();
    expect(readSimilarGymsError(new Error('GYM_SIMILAR_EXISTS'))).toBeNull();
    expect(readSimilarGymsError(null)).toBeNull();
  });
});

describe('isGymLimitError', () => {
  it('matches only the gym cap refusal', () => {
    expect(isGymLimitError(clientError({ code: 'GYM_LIMIT_REACHED', maxGyms: 25 }))).toBe(true);
    expect(isGymLimitError(clientError({ code: 'BOARD_LIMIT_REACHED' }))).toBe(false);
  });
});
