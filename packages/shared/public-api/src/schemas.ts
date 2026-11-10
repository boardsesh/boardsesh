/**
 * The public /v1 contract as zod schemas: what a request may send and what a
 * response may contain. docs/partner-api.md is the prose version of this file.
 *
 * Response objects are strict on purpose. Validating a response (contract tests,
 * the handlers) then fails when a field outside the contract appears, such as
 * `session_id` or `origin`, which must never leave the API. Apps get the opposite
 * promise in the published document: `additionalProperties: true`, because v1 adds
 * fields without notice and apps ignore what they do not know.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * A string whose set of values can grow on v1. A response is validated against
 * today's values, so adding one is a reviewed change to this file. The published
 * document lists the values without closing the set, because a generated client
 * reading a closed enum breaks on the first new value and the docs promise it won't.
 */
function extensibleEnum<const Values extends readonly [string, ...string[]]>(
  values: Values,
  metadata: { description: string; example: Values[number] },
) {
  const knownValues = new Set<string>(values);
  return z
    .custom<Values[number]>((candidate) => typeof candidate === 'string' && knownValues.has(candidate), {
      error: `Expected one of: ${values.join(', ')}`,
    })
    .openapi({ type: 'string', 'x-extensible-enum': [...values], ...metadata });
}

const OPEN_FIELDS_NOTE = 'Apps must ignore fields they do not know.';

/** Every board type Boardsesh can report. Matches SUPPORTED_BOARDS in shared-schema. */
export const BOARD_TYPES = [
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'woods',
  'spray',
] as const;
export const BoardTypeSchema = extensibleEnum(BOARD_TYPES, {
  description: "The kind of board. `spray` is a climber's own spray wall. New values may be added.",
  example: 'kilter',
}).openapi('BoardType');
export type BoardType = z.infer<typeof BoardTypeSchema>;

export const TICK_STATUSES = ['flash', 'send', 'attempt'] as const;
export const TickStatusSchema = extensibleEnum(TICK_STATUSES, {
  description: 'Whether the climb was topped. New values may be added; treat an unknown one as `attempt`.',
  example: 'send',
}).openapi('TickStatus');
export type TickStatus = z.infer<typeof TickStatusSchema>;

const GRADE_EXAMPLE = { v: 4, font: '6B+', label: '6b+/V4' };

export const GradeSchema = z
  .strictObject({
    v: z.number().int().nullable().openapi({
      description: 'V-scale grade, or `null` where the board grade has no V equivalent.',
      example: 4,
    }),
    font: z.string().min(1).openapi({ description: 'Fontainebleau grade.', example: '6B+' }),
    label: z.string().min(1).openapi({
      description: "The board's own label for this grade, as its grade table spells it.",
      example: '6b+/V4',
    }),
  })
  .openapi('Grade', { additionalProperties: true, example: GRADE_EXAMPLE });
export type Grade = z.infer<typeof GradeSchema>;

const TICK_CLIMB_EXAMPLE = {
  id: '3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b',
  name: 'Slopey Business',
  board: { type: 'kilter', layout: 'Kilter Board Original' },
  grade: GRADE_EXAMPLE,
  boardseshGrade: null,
};

export const TickClimbSchema = z
  .strictObject({
    id: z.string().min(1).openapi({
      description:
        "Stable climb id. If Boardsesh merges duplicate climbs, this changes to the surviving climb's id and the tick comes through the feed again.",
      example: TICK_CLIMB_EXAMPLE.id,
    }),
    name: z.string().nullable().openapi({
      description:
        "Climb name. `null` for a climb on someone else's spray wall that is not public: the wall's owner shared it with the climber, not with apps.",
      example: 'Slopey Business',
    }),
    board: z
      .strictObject({
        type: BoardTypeSchema,
        layout: z.string().min(1).openapi({
          description: 'Layout name, for display (`"Spray wall"` when the name is withheld).',
          example: 'Kilter Board Original',
        }),
      })
      .openapi({ additionalProperties: true, description: 'The board this climb is on.' }),
    grade: z.union([GradeSchema, z.null()]).openapi({
      description:
        'The community grade at this angle when read. It drifts over time without the tick changing. `null` when the climb has no community grade at this angle.',
    }),
    boardseshGrade: z.number().nullable().openapi({
      description:
        'The Boardsesh universal grade, a decimal on the V scale, or `null`. Always `null` for now: its V-scale form is not published yet. Optional reading; the model may change.',
      example: null,
    }),
  })
  .openapi('TickClimb', { additionalProperties: true, example: TICK_CLIMB_EXAMPLE });
export type TickClimb = z.infer<typeof TickClimbSchema>;

const utcTimestamp = (description: string, example: string) =>
  z.iso.datetime().openapi({ description, example, format: 'date-time' });

const TICK_EXAMPLE = {
  id: '0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77',
  climbedAt: '2026-10-20T18:42:11Z',
  status: 'send',
  attempts: 3,
  angle: 40,
  mirrored: false,
  stars: 4,
  grade: GRADE_EXAMPLE,
  benchmark: false,
  comment: 'Finally stuck the cross-through',
  climb: TICK_CLIMB_EXAMPLE,
  createdAt: '2026-10-20T18:42:15Z',
  updatedAt: '2026-10-20T18:42:15Z',
};

export const TickSchema = z
  .strictObject({
    id: z.string().min(1).openapi({ description: 'Stable id of this tick. Never reused.', example: TICK_EXAMPLE.id }),
    climbedAt: utcTimestamp(
      'When the climber logged the climb, UTC. Ticks imported from other board apps carry the time that app recorded.',
      TICK_EXAMPLE.climbedAt,
    ),
    status: TickStatusSchema,
    attempts: z.number().int().nonnegative().openapi({
      description: 'Goes this tick represents. A `send` with `attempts: 3` went on the third go.',
      example: 3,
    }),
    angle: z.number().int().openapi({ description: 'Wall angle in degrees.', example: 40 }),
    mirrored: z.boolean().openapi({ description: 'Climbed mirrored, on boards that support it.', example: false }),
    stars: z.number().int().min(1).max(5).nullable().openapi({
      description: "The climber's 1 to 5 rating, or `null`.",
      example: 4,
    }),
    grade: z.union([GradeSchema, z.null()]).openapi({
      description: 'The grade the climber gave it, or `null` if they did not give one.',
    }),
    benchmark: z.boolean().openapi({ description: 'The climb is a benchmark on its board.', example: false }),
    comment: z.string().min(1).nullable().openapi({
      description: "The climber's note, or `null` when they left none.",
      example: 'Finally stuck the cross-through',
    }),
    climb: TickClimbSchema,
    createdAt: utcTimestamp('When Boardsesh first stored this tick, UTC.', TICK_EXAMPLE.createdAt),
    updatedAt: utcTimestamp('When Boardsesh last changed this tick, UTC.', TICK_EXAMPLE.updatedAt),
  })
  .openapi('Tick', {
    additionalProperties: true,
    description: `One logged climb, the same shape everywhere a tick appears. ${OPEN_FIELDS_NOTE}`,
    example: TICK_EXAMPLE,
  });
export type Tick = z.infer<typeof TickSchema>;

export const TickChangeSchema = z
  .strictObject({
    type: z.literal('tick').openapi({ description: 'Upsert this tick by `id`.' }),
    tick: TickSchema,
  })
  .openapi('TickChange', {
    additionalProperties: true,
    description: 'Set this tick to these values. Treat it as "set", never "add one"; the feed is at least once.',
    example: { type: 'tick', tick: TICK_EXAMPLE },
  });

const TICK_DELETED_EXAMPLE = { type: 'tick.deleted', id: '9a1f7c3d-2b4e-4f6a-8c9d-1e2f3a4b5c6d' };

export const TickDeletedChangeSchema = z
  .strictObject({
    type: z.literal('tick.deleted').openapi({ description: 'Remove this tick.' }),
    id: z.string().min(1).openapi({
      description: 'The tick to remove, even if you never saw it.',
      example: TICK_DELETED_EXAMPLE.id,
    }),
  })
  .openapi('TickDeletedChange', {
    additionalProperties: true,
    description: 'This tick is gone, or is now hidden by duplicate handling.',
    example: TICK_DELETED_EXAMPLE,
  });

/**
 * One feed entry, as a response validator. Rejects a `type` outside today's set,
 * like {@link extensibleEnum}. The published document adds an open branch.
 */
export const LogbookChangeSchema = z.discriminatedUnion('type', [TickChangeSchema, TickDeletedChangeSchema]);
export type LogbookChange = z.infer<typeof LogbookChangeSchema>;

/** Stops z.discriminatedUnion emitting a closed `oneOf` with a discriminator into the published document. */
const PublishedLogbookChangeSchema = z
  .custom<LogbookChange>((candidate) => LogbookChangeSchema.safeParse(candidate).success, {
    error: 'Expected a tick or tick.deleted change',
  })
  .openapi({
    type: 'object',
    anyOf: [
      { $ref: '#/components/schemas/TickChange' },
      { $ref: '#/components/schemas/TickDeletedChange' },
      { $ref: '#/components/schemas/UnknownLogbookChange' },
    ],
    description: 'One feed entry. Apply entries in order and ignore types you do not know.',
  });

/** Documented only: the catch-all branch of the published feed entry. */
export const UnknownLogbookChangeSchema = z
  .object({ type: z.string().min(1).openapi({ description: 'Any other change type.', example: 'tick.moved' }) })
  .openapi('UnknownLogbookChange', {
    description: 'A change type added after your client was written. Skip it and continue.',
    example: { type: 'tick.moved' },
  });

export const LOGBOOK_PAGE_DEFAULT_LIMIT = 100;
export const LOGBOOK_PAGE_MAX_LIMIT = 200;

const CURSOR_EXAMPLE = 'c3.eyJraW5kIjo';

export const LogbookChangesQuerySchema = z.object({
  cursor: z.string().min(1).optional().openapi({
    description:
      "Omit it to start a complete snapshot of the climber's visible ticks. Otherwise pass the `cursor` from the previous page. Opaque: do not parse or build it. `c3.expired` always answers `410`, for testing recovery.",
    example: CURSOR_EXAMPLE,
  }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LOGBOOK_PAGE_MAX_LIMIT)
    .default(LOGBOOK_PAGE_DEFAULT_LIMIT)
    .openapi({ description: `Page size, 1 to ${LOGBOOK_PAGE_MAX_LIMIT}.`, example: LOGBOOK_PAGE_DEFAULT_LIMIT }),
});
export type LogbookChangesQuery = z.infer<typeof LogbookChangesQuerySchema>;

export const LogbookChangesResponseSchema = z
  .strictObject({
    changes: z
      .array(PublishedLogbookChangeSchema)
      .openapi({ description: 'Possibly empty, even while `hasMore` is true.' }),
    cursor: z.string().min(1).openapi({
      description: 'Pass it as `cursor` on the next request. Opaque. Commit it together with the page you applied.',
      example: CURSOR_EXAMPLE,
    }),
    hasMore: z.boolean().openapi({
      description:
        'Keep paging while true. Only `false` means a complete snapshot and its catch-up, or an incremental sync, is finished.',
      example: false,
    }),
  })
  .openapi('LogbookChangesResponse', {
    additionalProperties: true,
    example: { changes: [TICK_DELETED_EXAMPLE], cursor: CURSOR_EXAMPLE, hasMore: false },
  });
export type LogbookChangesResponse = z.infer<typeof LogbookChangesResponseSchema>;

export const TickParamsSchema = z.object({
  id: z.string().min(1).openapi({ description: 'The tick id.', example: TICK_EXAMPLE.id }),
});
export type TickParams = z.infer<typeof TickParamsSchema>;

export const MeResponseSchema = z
  .strictObject({
    // No hyphen in the pattern: internal user ids are UUIDs, so `usr_<users.id>`
    // fails here instead of leaking the id this field exists to hide.
    id: z
      .string()
      .regex(/^usr_[0-9A-Za-z]+$/)
      .openapi({
        description:
          "The climber's id for your app: stable across reconnects, different for every app, and not the id Boardsesh uses anywhere else.",
        example: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6',
      }),
    displayName: z.string().nullable().optional().openapi({
      description: "The climber's display name. Present only with `profile:read`; `null` when they have none.",
      example: 'Alex',
    }),
    // z.httpUrl() because z.url() also accepts javascript: and data:, and apps put
    // this in an <img> or a link. The handler must map any stored value that is
    // not http(s) to `null`, or the response fails this schema.
    avatarUrl: z.httpUrl().nullable().optional().openapi({
      description: "The climber's avatar. Present only with `profile:read`; `null` when they have none.",
      example: 'https://images.example.com/alex.webp',
    }),
  })
  .openapi('MeResponse', {
    additionalProperties: true,
    example: {
      id: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6',
      displayName: 'Alex',
      avatarUrl: 'https://images.example.com/alex.webp',
    },
  });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const API_ERROR_CODES = [
  'invalid_request',
  'invalid_cursor',
  'invalid_token',
  'insufficient_scope',
  'not_found',
  'cursor_expired',
  'rate_limited',
  'server_error',
] as const;

export const ApiErrorResponseSchema = z
  .strictObject({
    error: extensibleEnum(API_ERROR_CODES, {
      description: 'Machine-readable code. New codes may be added; branch on the HTTP status first.',
      example: 'invalid_cursor',
    }),
    message: z.string().min(1).openapi({
      description: 'For a human reading logs.',
      example: 'cursor is not a value this API issued',
    }),
    field: z.string().min(1).optional().openapi({
      description: 'Added for validation errors: the field that failed.',
      example: 'limit',
    }),
    requestId: z.string().min(1).openapi({
      description: 'Quote this when something looks wrong. Also sent as `Boardsesh-Request-Id`.',
      example: 'req_7Hc2Pb9Xw1Lm',
    }),
  })
  .openapi('ApiError', {
    additionalProperties: true,
    example: {
      error: 'invalid_cursor',
      message: 'cursor is not a value this API issued',
      requestId: 'req_7Hc2Pb9Xw1Lm',
    },
  });
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
