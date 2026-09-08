import { z } from 'zod';
import { BOARD_ANGLE_VALIDATION_MESSAGE, isBoardAngleSupported } from './board-angles';
import { ClimbInputSchema } from './climbs';
import { BoardNameSchema, ClimbUuidSchema, NumericCsvSchema } from './primitives';

export const BoardPresenceConfigInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('layoutId must be a positive integer'),
  sizeId: z.number().int().positive('sizeId must be a positive integer'),
  setIds: NumericCsvSchema,
});

/**
 * The board type parsed from the connected controller's BLE device name
 * (`Tension Board#12345@3`). Scopes every serial lookup to the hardware in
 * front of the climber, because Aurora runs a separate serial sequence per
 * board app. Nullish for clients shipped before the serial-per-board-type fix,
 * which keep the old type-blind resolution.
 */
export const AdvertisedBoardTypeSchema = BoardNameSchema.nullish();

// Live board angle; Aurora supports negative tilt.
export const BoardPresenceAngleSchema = z.number().int().min(-90).max(90).nullable().optional();

/**
 * Args for the wall-kiosk recent-senders byline.
 *
 * The angle contract tracks the tick-WRITE path (`SaveTickInputSchema`) rather
 * than the looser live-tilt broadcast above: this read can only ever match an
 * angle a tick was allowed to be written at, so anything outside that range is
 * a client bug, not an empty wall. Hence the same `-5..90` bound plus the same
 * `isBoardAngleSupported` refinement — 0..90 is the historic write range, while
 * negative tilt is board-specific (only Grasshopper's -5° slab today), which is
 * why `boardType` is part of the input.
 *
 * `boardType` is the bound board row's own value, not a client field, so it is
 * a plain string here: `isBoardAngleSupported` maps an unrecognised board to
 * "no negative angles" on its own, and running a server-side value through
 * `BoardNameSchema` would report it as bad user input.
 */
export const BoardClimbRecentSendersArgsSchema = z
  .object({
    boardType: z.string(),
    climbUuid: ClimbUuidSchema.refine(
      (climbUuid) => climbUuid.trim().length > 0,
      'Climb UUID cannot be empty',
    ).transform((climbUuid) => climbUuid.trim()),
    angle: z.number().int().min(-5).max(90),
  })
  .refine((args) => isBoardAngleSupported(args.boardType, args.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  });

export const ReportBoardClimbInputSchema = z.object({
  uuid: z.string().min(1, 'Queue item UUID cannot be empty').max(100, 'Queue item UUID too long'),
  climb: ClimbInputSchema.extend({
    uuid: ClimbUuidSchema,
  }),
  addedBy: z.string().max(100).nullish(),
  addedByUser: z
    .object({
      id: z.string().max(100),
      username: z.string().max(100),
      avatarUrl: z.string().max(500).nullish(),
    })
    .nullish(),
  tickedBy: z.array(z.string().max(100)).max(100).nullish(),
  suggested: z.boolean().nullish(),
});
