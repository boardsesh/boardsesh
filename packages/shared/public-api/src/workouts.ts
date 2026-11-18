import { z } from 'zod';
import { ApiErrorResponseSchema, BoardTypeSchema, TickSchema, extensibleEnum } from './schemas';

export const WORKOUT_BLOCK_TYPES = [
  'warmUp',
  'volume',
  'pyramid',
  'ladder',
  'gradeFocus',
  'onTheMinute',
  'fourByFour',
  'limitBouldering',
  'freeClimbing',
] as const;
export const WORKOUT_STATUSES = [
  'created',
  'opened',
  'started',
  'completed',
  'auto_closed',
  'cancelled',
  'expired',
  'revoked',
] as const;
const FONT_GRADES = [
  '3',
  '3+',
  '4',
  '4+',
  '5',
  '5+',
  '6A',
  '6A+',
  '6B',
  '6B+',
  '6C',
  '6C+',
  '7A',
  '7A+',
  '7B',
  '7B+',
  '7C',
  '7C+',
  '8A',
  '8A+',
  '8B',
  '8B+',
  '8C',
  '8C+',
  '9A',
] as const;
export const WorkoutGradeSchema = z.discriminatedUnion('scale', [
  z.object({ scale: z.literal('v'), value: z.number().int().min(0).max(17) }),
  z.object({ scale: z.literal('font'), value: z.enum(FONT_GRADES) }),
]);
export const WorkoutGradeRangeSchema = z
  .discriminatedUnion('scale', [
    z.object({ scale: z.literal('v'), from: z.number().int().min(0).max(17), to: z.number().int().min(0).max(17) }),
    z.object({ scale: z.literal('font'), from: z.enum(FONT_GRADES), to: z.enum(FONT_GRADES) }),
  ])
  .refine(
    (range) =>
      range.scale === 'v' ? range.from <= range.to : FONT_GRADES.indexOf(range.from) <= FONT_GRADES.indexOf(range.to),
    'from must not be harder than to',
  );
const restSeconds = z.number().int().min(0).max(3600);
const commonBlock = {
  label: z.string().trim().min(1).max(40).optional(),
  instructions: z.string().max(1000).optional(),
};
const countedBlock = { ...commonBlock, climbCount: z.number().int().min(1).max(40) };
export const WorkoutBlockSchema = z
  .discriminatedUnion('type', [
    z.object({ ...countedBlock, type: z.literal('warmUp'), gradeRange: WorkoutGradeRangeSchema }),
    z.object({
      ...countedBlock,
      type: z.literal('volume'),
      targetGrade: WorkoutGradeSchema,
      restSeconds: restSeconds.optional(),
    }),
    z.object({
      ...countedBlock,
      type: z.literal('pyramid'),
      gradeRange: WorkoutGradeRangeSchema,
      restSeconds: restSeconds.optional(),
    }),
    z.object({
      ...countedBlock,
      type: z.literal('ladder'),
      gradeRange: WorkoutGradeRangeSchema,
      restSeconds: restSeconds.optional(),
    }),
    z.object({
      ...countedBlock,
      type: z.literal('gradeFocus'),
      targetGrade: WorkoutGradeSchema,
      restSeconds: restSeconds.optional(),
    }),
    z.object({
      ...countedBlock,
      type: z.literal('onTheMinute'),
      targetGrade: WorkoutGradeSchema,
      intervalSeconds: z.number().int().min(15).max(3600).default(60),
    }),
    z.object({
      ...countedBlock,
      type: z.literal('fourByFour'),
      targetGrade: WorkoutGradeSchema,
      rounds: z.number().int().min(1).max(10),
      restBetweenClimbsSeconds: restSeconds,
      restBetweenRoundsSeconds: restSeconds,
    }),
    z.object({
      ...countedBlock,
      type: z.literal('limitBouldering'),
      targetGrade: WorkoutGradeSchema,
      restSeconds: restSeconds.optional(),
    }),
    z.object({
      ...commonBlock,
      type: z.literal('freeClimbing'),
      durationSeconds: z.number().int().min(1).max(86400).optional(),
    }),
  ])
  .openapi('WorkoutBlock', { example: { type: 'volume', targetGrade: { scale: 'v', value: 3 }, climbCount: 8 } });
export type WorkoutBlock = z.infer<typeof WorkoutBlockSchema>;
export const CreateWorkoutSchema = z
  .object({
    externalRef: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(80),
    scheduledFor: z.iso.date().optional(),
    notes: z.string().max(2000).optional(),
    preferredBoard: z.object({ type: BoardTypeSchema, angle: z.number().int().min(0).max(90).optional() }).optional(),
    blocks: z.array(WorkoutBlockSchema).min(1).max(12),
  })
  .openapi('CreateWorkout', {
    example: {
      externalRef: 'session_88213',
      title: 'Easy volume',
      blocks: [{ type: 'volume', targetGrade: { scale: 'v', value: 3 }, climbCount: 8 }],
    },
  });
export type CreateWorkout = z.infer<typeof CreateWorkoutSchema>;
export const WorkoutStatusSchema = extensibleEnum(WORKOUT_STATUSES, {
  description: 'Workout lifecycle. New statuses may be added; treat unknown statuses as unfinished.',
  example: 'created',
}).openapi('WorkoutStatus');
export type WorkoutStatus = z.infer<typeof WorkoutStatusSchema>;
const BLOCK_SUPPORT_EXAMPLE = { index: 0, type: 'volume', support: 'native' };
const WORKOUT_CREATED_EXAMPLE = {
  id: 'wk_example',
  externalRef: 'session_88213',
  status: 'created',
  launchUrl: 'https://www.boardsesh.com/w/wk_example',
  appUrl: 'com.boardsesh.app://w/wk_example',
  expiresAt: '2026-12-01T00:00:00Z',
  blocks: [BLOCK_SUPPORT_EXAMPLE],
};
export const WorkoutBlockSupportSchema = z
  .strictObject({
    index: z.number().int().min(0).max(11),
    type: extensibleEnum(WORKOUT_BLOCK_TYPES, {
      description: 'Block type. New values may be added.',
      example: 'volume',
    }),
    support: extensibleEnum(['native', 'freeform'] as const, {
      description: 'How the block runs. New values may be added.',
      example: 'native',
    }),
  })
  .openapi('WorkoutBlockSupport', { additionalProperties: true, example: BLOCK_SUPPORT_EXAMPLE });
export function workoutBlockSupport(block: WorkoutBlock): 'native' | 'freeform' {
  return block.type === 'fourByFour' || block.type === 'limitBouldering' ? 'freeform' : 'native';
}
export const WorkoutCreatedSchema = z
  .strictObject({
    id: z.string().regex(/^wk_[A-Za-z0-9_-]+$/),
    externalRef: z.string(),
    status: WorkoutStatusSchema,
    launchUrl: z.url(),
    appUrl: z.string(),
    expiresAt: z.iso.datetime(),
    blocks: z.array(WorkoutBlockSupportSchema),
  })
  .openapi('WorkoutCreated', { additionalProperties: true, example: WORKOUT_CREATED_EXAMPLE });
export type WorkoutCreated = z.infer<typeof WorkoutCreatedSchema>;
export const WorkoutConflictSchema = z
  .strictObject({
    ...ApiErrorResponseSchema.shape,
    existing: WorkoutCreatedSchema.optional(),
  })
  .openapi('WorkoutConflict', {
    additionalProperties: true,
    example: {
      error: 'conflict',
      message: 'This reference already exists.',
      requestId: 'req_example',
      existing: WORKOUT_CREATED_EXAMPLE,
    },
  });
export const WorkoutResultsSchema = z
  .strictObject({
    completion: z.enum(['ended', 'auto_closed']),
    session: z
      .strictObject({
        startedAt: z.iso.datetime().openapi({
          description:
            'When the workout started: the session start, or later when the workout was added to a session already running.',
        }),
        endedAt: z.iso.datetime(),
        durationSeconds: z.number().int().nonnegative().openapi({ description: 'Seconds from startedAt to endedAt.' }),
        timezone: z.string().nullable(),
        notes: z.string().nullable(),
        board: z
          .strictObject({
            type: BoardTypeSchema,
            name: z.string().nullable(),
            layout: z.string().nullable(),
            size: z.string().nullable(),
            angle: z.number().int().nullable(),
          })
          .openapi({ additionalProperties: true }),
      })
      .openapi({ additionalProperties: true }),
    ticks: z
      .array(
        z
          .strictObject({
            ...TickSchema.shape,
            blockIndex: z.number().int().min(0).max(11).nullable().openapi({
              description:
                "The block the climber logged this tick on, as their session recorded it. `null` when the tick is on none of this workout's blocks, or the block cannot be told.",
            }),
          })
          .openapi({ additionalProperties: true }),
      )
      .openapi({
        description:
          "The climber's own ticks from this workout, in time order: every tick on one of its blocks, plus every tick logged after the workout started. Ticks from earlier in the same session are left out.",
      }),
    blocks: z.array(
      z
        .strictObject({ ...WorkoutBlockSupportSchema.shape, planned: WorkoutBlockSchema })
        .openapi({ additionalProperties: true }),
    ),
  })
  .openapi('WorkoutResults', {
    additionalProperties: true,
    example: {
      completion: 'ended',
      session: {
        startedAt: '2026-11-17T17:00:00Z',
        endedAt: '2026-11-17T18:00:00Z',
        durationSeconds: 3600,
        timezone: 'Europe/Amsterdam',
        notes: null,
        board: { type: 'kilter', name: 'Homewall', layout: 'Kilter Board Original', size: '12x12', angle: 40 },
      },
      ticks: [],
      blocks: [],
    },
  });
export type WorkoutResults = z.infer<typeof WorkoutResultsSchema>;
export const WorkoutResponseSchema = z
  .strictObject({
    ...WorkoutCreatedSchema.shape,
    title: z.string(),
    scheduledFor: z.iso.date().nullable(),
    notes: z.string().nullable(),
    spec: CreateWorkoutSchema,
    openedByMismatch: z.boolean(),
    results: WorkoutResultsSchema.optional(),
  })
  .openapi('Workout', {
    additionalProperties: true,
    example: {
      ...WORKOUT_CREATED_EXAMPLE,
      title: 'Easy volume',
      scheduledFor: null,
      notes: null,
      openedByMismatch: false,
      spec: {
        externalRef: 'session_88213',
        title: 'Easy volume',
        blocks: [{ type: 'volume', targetGrade: { scale: 'v', value: 3 }, climbCount: 8 }],
      },
    },
  });
export type WorkoutResponse = z.infer<typeof WorkoutResponseSchema>;
export const WorkoutListQuerySchema = z.object({
  externalRef: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export const WorkoutListSchema = z
  .strictObject({ workouts: z.array(WorkoutResponseSchema), cursor: z.string().nullable(), hasMore: z.boolean() })
  .openapi('WorkoutList', { additionalProperties: true, example: { workouts: [], cursor: null, hasMore: false } });
export const WorkoutPlanSchema = z
  .array(z.object({ index: z.number().int().min(0).max(11), climbUuids: z.array(z.string().min(1).max(128)).max(400) }))
  .max(12)
  .refine(
    (blocks) => new Set(blocks.map((block) => block.index)).size === blocks.length,
    'Each block index must occur once',
  );
export type WorkoutPlan = z.infer<typeof WorkoutPlanSchema>;
