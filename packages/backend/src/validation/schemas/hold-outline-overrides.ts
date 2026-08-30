import { z } from 'zod';
import { MAX_RING_NUMBERS, MIN_RING_NUMBERS, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import { BoardNameSchema } from './primitives';

/**
 * Shape rules for a stored hold outline.
 *
 * The rule itself is `isValidOutlineRing` from `@boardsesh/board-art-geometry/ring`
 * — one implementation, shared with the editor, so a client can never draw a ring
 * its own validator accepts and the backend then refuses. Zod's own array bounds
 * sit in front of it purely so the common failures come back with a message that
 * says which one it was; the refine is what actually decides.
 *
 * Shape only. Whether the ring covers its own placement centre, and whether the
 * placement exists on the board at all, need board data and are checked in the
 * resolver.
 */
const OutlineRingSchema = z
  .array(z.number())
  .min(MIN_RING_NUMBERS, `An outline needs at least ${MIN_RING_NUMBERS / 2} points`)
  .max(MAX_RING_NUMBERS, `An outline may hold at most ${MAX_RING_NUMBERS / 2} points`)
  .refine((ring) => ring.length % 2 === 0, 'An outline is a flat [x, y, ...] list, so its length must be even')
  .refine(isValidOutlineRing, 'Every outline coordinate must be a finite number within 4 placement radii');

/**
 * GraphQL sends the enum in SCREAMING_CASE and the column stores snake_case, so
 * the schema accepts the wire form and hands the resolver the stored one.
 * Absent means SILHOUETTE — the overwhelmingly common write, and what every
 * pre-`kind` client sends.
 */
export const HOLD_OUTLINE_KIND_BY_WIRE_NAME = {
  SILHOUETTE: 'silhouette',
  LED_INNER: 'led_inner',
} as const;

const HoldOutlineKindSchema = z
  .enum(['SILHOUETTE', 'LED_INNER'])
  .nullish()
  .transform((wireName) => HOLD_OUTLINE_KIND_BY_WIRE_NAME[wireName ?? 'SILHOUETTE']);

const HoldOutlineConfigShape = {
  boardName: BoardNameSchema,
  layoutId: z.number().int().nonnegative(),
  sizeId: z.number().int().nonnegative(),
};

export const HoldOutlineConfigInputSchema = z.object(HoldOutlineConfigShape);

export const UpsertHoldOutlineOverrideInputSchema = z.object({
  ...HoldOutlineConfigShape,
  placementId: z.number().int().nonnegative(),
  kind: HoldOutlineKindSchema,
  outline: OutlineRingSchema,
  note: z.string().trim().max(500).optional().nullable(),
});

export const DeleteHoldOutlineOverrideInputSchema = z.object({
  ...HoldOutlineConfigShape,
  placementId: z.number().int().nonnegative(),
  kind: HoldOutlineKindSchema,
});
