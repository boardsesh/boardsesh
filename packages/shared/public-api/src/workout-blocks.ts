import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

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
  externalRef: z.string().trim().min(1).max(200).optional(),
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
