import { describe, expect, it } from 'vite-plus/test';
import { MAX_SEARCH_PAGE, mapSearchInputToParams } from '@boardsesh/db/queries';
import { typeDefs } from '@boardsesh/shared-schema';
import { ClimbSearchInputSchema } from '../validation/schemas';

const base = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 7,
  setIds: '1',
  angle: 40,
};

describe('ClimbSearchInputSchema page bound', () => {
  it('accepts pages up to MAX_SEARCH_PAGE', () => {
    expect(ClimbSearchInputSchema.safeParse({ ...base, page: 0 }).success).toBe(true);
    expect(ClimbSearchInputSchema.safeParse({ ...base, page: MAX_SEARCH_PAGE }).success).toBe(true);
  });

  it('rejects pages past MAX_SEARCH_PAGE to block deep-OFFSET abuse', () => {
    const result = ClimbSearchInputSchema.safeParse({ ...base, page: MAX_SEARCH_PAGE + 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'Page number too large')).toBe(true);
    }
  });
});

describe('ClimbSearchInputSchema holdsFilter cap', () => {
  it('accepts a realistic number of hold filters', () => {
    const holdsFilter: Record<string, { ANY: 'include' }> = {};
    for (let holdId = 1; holdId <= 50; holdId++) holdsFilter[`hold_${holdId}`] = { ANY: 'include' };
    expect(ClimbSearchInputSchema.safeParse({ ...base, holdsFilter }).success).toBe(true);
  });

  it('rejects an oversized holdsFilter record', () => {
    const holdsFilter: Record<string, { ANY: 'include' }> = {};
    for (let holdId = 1; holdId <= 400; holdId++) holdsFilter[`hold_${holdId}`] = { ANY: 'include' };
    const result = ClimbSearchInputSchema.safeParse({ ...base, holdsFilter });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'Too many hold filters')).toBe(true);
    }
  });
});

describe('ClimbSearchInputSchema personal rating filters (#2645)', () => {
  it('accepts a 1-5 star minimum, matching the boardsesh_ticks quality range', () => {
    for (const minUserRating of [1, 2, 3, 4, 5]) {
      expect(ClimbSearchInputSchema.safeParse({ ...base, minUserRating }).success).toBe(true);
    }
  });

  it('accepts 0 as "no minimum" so a client sending the default cannot 400 the search', () => {
    expect(ClimbSearchInputSchema.safeParse({ ...base, minUserRating: 0 }).success).toBe(true);
  });

  it('rejects out-of-range and fractional star minimums', () => {
    expect(ClimbSearchInputSchema.safeParse({ ...base, minUserRating: 6 }).success).toBe(false);
    expect(ClimbSearchInputSchema.safeParse({ ...base, minUserRating: -1 }).success).toBe(false);
    expect(ClimbSearchInputSchema.safeParse({ ...base, minUserRating: 3.5 }).success).toBe(false);
  });

  it('accepts onlyRatedByMe as a boolean only', () => {
    expect(ClimbSearchInputSchema.safeParse({ ...base, onlyRatedByMe: true }).success).toBe(true);
    expect(ClimbSearchInputSchema.safeParse({ ...base, onlyRatedByMe: 'true' }).success).toBe(false);
  });

  it('leaves both filters optional', () => {
    expect(ClimbSearchInputSchema.safeParse(base).success).toBe(true);
  });
});

describe('ClimbSearchInputSchema boulders/routes have no default (#3975)', () => {
  it('leaves omitted boulders/routes undefined after parsing, not defaulted to boulders-only', () => {
    const result = ClimbSearchInputSchema.parse(base);
    expect(result.boulders).toBeUndefined();
    expect(result.routes).toBeUndefined();
  });

  it('resolves to the same "no climb-type constraint" outcome whether boulders/routes are omitted or explicitly true/true', () => {
    // This is the no-behavior-change proof for removing the dead .default(true)/
    // .default(false): now that searchClimbs uses validateInput's parsed return
    // (see queries.ts), a live default here would have flipped omitted callers
    // to boulders-only. omitted and explicit true/true are NOT byte-identical
    // ClimbSearchParams (boulders/routes are `undefined` vs `true`), but
    // create-climb-filters.ts's `wantsBoulders = !!searchParams.boulders` /
    // `wantsRoutes = !!searchParams.routes` coerce both `undefined` and the
    // both-true case to the same "no frames_count constraint" branch — that's
    // the equivalence #3976's repro (and filter-state.ts's comment) rely on.
    const omitted = mapSearchInputToParams(ClimbSearchInputSchema.parse(base));
    const explicit = mapSearchInputToParams(ClimbSearchInputSchema.parse({ ...base, boulders: true, routes: true }));
    expect(omitted.boulders).toBeUndefined();
    expect(omitted.routes).toBeUndefined();

    const hasNoClimbTypeConstraint = (params: { boulders?: boolean | null; routes?: boolean | null }) => {
      const wantsBoulders = !!params.boulders;
      const wantsRoutes = !!params.routes;
      // Mirrors create-climb-filters.ts: constrained only when exactly one is set.
      return !((wantsBoulders && !wantsRoutes) || (wantsRoutes && !wantsBoulders));
    };
    expect(hasNoClimbTypeConstraint(omitted)).toBe(true);
    expect(hasNoClimbTypeConstraint(explicit)).toBe(true);
  });
});

describe('ClimbSearchInputSchema covers every ClimbSearchInput SDL field (#3975)', () => {
  it('has one Zod key per GraphQL input field, so parsing strips nothing the resolver needs', () => {
    // searchClimbs now feeds `validateInput`'s PARSED result downstream, and
    // Zod objects strip keys they don't declare. Before #3975 the resolver
    // read the raw GraphQL input, so a field added to the SDL but forgotten
    // in this schema still reached mapSearchInputToParams; now it would be
    // silently dropped and the filter would just stop working. This test is
    // the tripwire for that: add the field here whenever the SDL grows one.
    const sdl = typeDefs.join('\n');
    const inputBlock = /input ClimbSearchInput\s*\{([\s\S]*?)\n\s*\}/.exec(sdl);
    expect(inputBlock).not.toBeNull();

    const sdlFields = (inputBlock?.[1] ?? '')
      .split('\n')
      // Drop SDL doc-comment lines ("..." / """...""") and blanks.
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('"') && !line.startsWith('#'))
      .map((line) => line.split(':')[0].trim())
      .sort();
    const zodFields = Object.keys(ClimbSearchInputSchema.shape).sort();

    expect(sdlFields.length).toBeGreaterThan(0);
    expect(zodFields).toEqual(sdlFields);
  });
});
