import { z } from 'zod';
import { MAX_RING_COORDINATE, MAX_RING_NUMBERS, MIN_RING_NUMBERS } from '@boardsesh/board-art-geometry/ring';
import { BoardNameSchema } from './primitives';

/**
 * Shape rules for a stored hold silhouette. The bounds come from
 * `@boardsesh/board-art-geometry/ring` so this schema and the client-side
 * validator can never drift into a state where an editor lets you draw a ring
 * the backend then refuses.
 *
 * Shape only. Whether the ring contains its own placement centre, and whether
 * the placement exists on the board at all, need board data and are checked in
 * the resolver.
 */
const OutlineRingSchema = z
  .array(z.number().finite().min(-MAX_RING_COORDINATE).max(MAX_RING_COORDINATE))
  .min(MIN_RING_NUMBERS, `An outline needs at least ${MIN_RING_NUMBERS / 2} points`)
  .max(MAX_RING_NUMBERS, `An outline may hold at most ${MAX_RING_NUMBERS / 2} points`)
  .refine((ring) => ring.length % 2 === 0, 'An outline is a flat [x, y, ...] list, so its length must be even');

const HoldOutlineConfigShape = {
  boardName: BoardNameSchema,
  layoutId: z.number().int().nonnegative(),
  sizeId: z.number().int().nonnegative(),
};

export const HoldOutlineConfigInputSchema = z.object(HoldOutlineConfigShape);

export const UpsertHoldOutlineOverrideInputSchema = z.object({
  ...HoldOutlineConfigShape,
  placementId: z.number().int().nonnegative(),
  outline: OutlineRingSchema,
  note: z.string().trim().max(500).optional().nullable(),
});

export const DeleteHoldOutlineOverrideInputSchema = z.object({
  ...HoldOutlineConfigShape,
  placementId: z.number().int().nonnegative(),
});
