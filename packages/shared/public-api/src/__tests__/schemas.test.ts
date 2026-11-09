import { describe, expect, it } from 'vite-plus/test';
import {
  ApiErrorResponseSchema,
  LOGBOOK_PAGE_DEFAULT_LIMIT,
  LogbookChangesQuerySchema,
  LogbookChangesResponseSchema,
  MeResponseSchema,
  TickParamsSchema,
  TickSchema,
} from '../schemas';

/** The tick from docs/partner-api.md, section 3. */
const documentedTick = {
  id: '0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77',
  climbedAt: '2026-10-20T18:42:11Z',
  status: 'send',
  attempts: 3,
  angle: 40,
  mirrored: false,
  stars: 4,
  grade: { v: 4, font: '6B+', label: '6B+/V4' },
  benchmark: false,
  comment: 'Finally stuck the cross-through',
  climb: {
    id: '3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b',
    name: 'Slopey Business',
    board: { type: 'kilter', layout: 'Kilter Board Original' },
    grade: { v: 4, font: '6B+', label: '6B+/V4' },
    boardseshGrade: 4.2,
  },
  createdAt: '2026-10-20T18:42:15Z',
  updatedAt: '2026-10-20T18:42:15Z',
};

describe('TickSchema', () => {
  it('accepts the documented tick', () => {
    expect(TickSchema.parse(documentedTick)).toEqual(documentedTick);
  });

  it.each(['flash', 'send', 'attempt'])('accepts status %s', (status) => {
    expect(TickSchema.safeParse({ ...documentedTick, status }).success).toBe(true);
  });

  it('accepts every nullable field as null', () => {
    const tick = {
      ...documentedTick,
      stars: null,
      grade: null,
      comment: null,
      climb: { ...documentedTick.climb, name: null, grade: null, boardseshGrade: null },
    };

    expect(TickSchema.safeParse(tick).success).toBe(true);
  });

  it('accepts a grade with no V equivalent', () => {
    expect(TickSchema.safeParse({ ...documentedTick, grade: { v: null, font: '6B+', label: '6B+' } }).success).toBe(
      true,
    );
  });

  it.each(['session_id', 'board_id', 'origin'])('rejects the undocumented field %s', (field) => {
    expect(TickSchema.safeParse({ ...documentedTick, [field]: 'leak' }).success).toBe(false);
    expect(
      TickSchema.safeParse({ ...documentedTick, climb: { ...documentedTick.climb, [field]: 'leak' } }).success,
    ).toBe(false);
  });

  it('rejects a status outside today’s values', () => {
    expect(TickSchema.safeParse({ ...documentedTick, status: 'repeat' }).success).toBe(false);
  });

  it('rejects a board type outside today’s values', () => {
    const climb = { ...documentedTick.climb, board: { type: 'tb2', layout: 'Mirror' } };

    expect(TickSchema.safeParse({ ...documentedTick, climb }).success).toBe(false);
  });

  it.each([
    ['a non-UTC offset', { climbedAt: '2026-10-20T20:42:11+02:00' }],
    ['a date with no time', { updatedAt: '2026-10-20' }],
    ['stars below 1', { stars: 0 }],
    ['stars above 5', { stars: 6 }],
    ['fractional stars', { stars: 2.5 }],
    ['negative attempts', { attempts: -1 }],
    ['a fractional angle', { angle: 40.5 }],
    ['an empty comment, served as null', { comment: '' }],
  ])('rejects %s', (_case, override) => {
    expect(TickSchema.safeParse({ ...documentedTick, ...override }).success).toBe(false);
  });

  it('requires the climb', () => {
    const { climb: _climb, ...withoutClimb } = documentedTick;

    expect(TickSchema.safeParse(withoutClimb).success).toBe(false);
  });
});

describe('LogbookChangesResponseSchema', () => {
  it('accepts the documented page', () => {
    const page = {
      changes: [
        { type: 'tick', tick: documentedTick },
        { type: 'tick.deleted', id: '9a1f7c3d-2b4e-4f6a-8c9d-1e2f3a4b5c6d' },
      ],
      cursor: 'c3.eyJraW5kIjo',
      hasMore: true,
    };

    expect(LogbookChangesResponseSchema.parse(page)).toEqual(page);
  });

  it('accepts an empty page that still has more', () => {
    const page = { changes: [], cursor: 'c3.eyJraW5kIjo', hasMore: true };

    expect(LogbookChangesResponseSchema.safeParse(page).success).toBe(true);
  });

  it('requires a cursor even on the last page', () => {
    expect(LogbookChangesResponseSchema.safeParse({ changes: [], hasMore: false }).success).toBe(false);
  });

  it('rejects a change type outside today’s values', () => {
    const page = { changes: [{ type: 'tick.moved', id: 'abc' }], cursor: 'c3.eyJraW5kIjo', hasMore: false };

    expect(LogbookChangesResponseSchema.safeParse(page).success).toBe(false);
  });

  it('rejects a tick change without its tick', () => {
    const page = { changes: [{ type: 'tick' }], cursor: 'c3.eyJraW5kIjo', hasMore: false };

    expect(LogbookChangesResponseSchema.safeParse(page).success).toBe(false);
  });
});

describe('LogbookChangesQuerySchema', () => {
  it('defaults the limit and leaves the cursor unset for a first sync', () => {
    expect(LogbookChangesQuerySchema.parse({})).toEqual({ limit: LOGBOOK_PAGE_DEFAULT_LIMIT });
  });

  it('reads a limit from its query string form', () => {
    expect(LogbookChangesQuerySchema.parse({ limit: '200', cursor: 'c3.expired' })).toEqual({
      limit: 200,
      cursor: 'c3.expired',
    });
  });

  it.each(['0', '201', '1.5', 'many'])('rejects limit=%s', (limit) => {
    expect(LogbookChangesQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an empty cursor', () => {
    expect(LogbookChangesQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('TickParamsSchema', () => {
  it('takes any non-empty id, so an unknown one answers 404 rather than 400', () => {
    expect(TickParamsSchema.parse({ id: 'not-a-uuid' })).toEqual({ id: 'not-a-uuid' });
  });

  it('rejects an empty id', () => {
    expect(TickParamsSchema.safeParse({ id: '' }).success).toBe(false);
  });
});

describe('MeResponseSchema', () => {
  const documentedMe = {
    id: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6',
    displayName: 'Alex',
    avatarUrl: 'https://images.example.com/alex.webp',
  };

  it('accepts the documented climber', () => {
    expect(MeResponseSchema.parse(documentedMe)).toEqual(documentedMe);
  });

  it('accepts a token without profile:read, which gets only the id', () => {
    expect(MeResponseSchema.safeParse({ id: documentedMe.id }).success).toBe(true);
  });

  it('accepts a climber with no name or avatar', () => {
    expect(MeResponseSchema.safeParse({ id: documentedMe.id, displayName: null, avatarUrl: null }).success).toBe(true);
  });

  it('rejects the id Boardsesh uses internally', () => {
    expect(MeResponseSchema.safeParse({ id: '602c83bf-e090-4c90-9f7e-08ca0b6b5dad' }).success).toBe(false);
  });

  it('rejects the internal id behind the usr_ prefix', () => {
    expect(MeResponseSchema.safeParse({ id: 'usr_602c83bf-e090-4c90-9f7e-08ca0b6b5dad' }).success).toBe(false);
  });

  it.each(['http://images.example.com/alex.webp', 'https://images.example.com/alex.webp'])(
    'accepts the avatar %s',
    (avatarUrl) => {
      expect(MeResponseSchema.safeParse({ ...documentedMe, avatarUrl }).success).toBe(true);
    },
  );

  it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://images.example.com/alex.webp'])(
    'rejects the avatar %s',
    (avatarUrl) => {
      expect(MeResponseSchema.safeParse({ ...documentedMe, avatarUrl }).success).toBe(false);
    },
  );

  it('rejects an undocumented field', () => {
    expect(MeResponseSchema.safeParse({ ...documentedMe, email: 'alex@example.com' }).success).toBe(false);
  });
});

describe('ApiErrorResponseSchema', () => {
  it('accepts the documented error', () => {
    const error = { error: 'invalid_cursor', message: 'cursor is not a value this API issued', requestId: 'req_7Hc' };

    expect(ApiErrorResponseSchema.parse(error)).toEqual(error);
  });

  it('accepts a field on a validation error', () => {
    const error = { error: 'invalid_request', message: 'limit is out of range', field: 'limit', requestId: 'req_7Hc' };

    expect(ApiErrorResponseSchema.safeParse(error).success).toBe(true);
  });

  it('rejects an error without a request id', () => {
    expect(ApiErrorResponseSchema.safeParse({ error: 'not_found', message: 'gone' }).success).toBe(false);
  });

  it('rejects a code outside today’s values', () => {
    expect(ApiErrorResponseSchema.safeParse({ error: 'teapot', message: 'no', requestId: 'req_7Hc' }).success).toBe(
      false,
    );
  });
});
