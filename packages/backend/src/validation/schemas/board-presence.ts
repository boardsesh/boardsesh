import { z } from 'zod';
import { MAX_ACTIVE_BOARD_LAYERS } from '@boardsesh/board-layers';
import { ClimbInputSchema } from './climbs';
import { BoardNameSchema, ClimbUuidSchema, ExternalUUIDSchema, NumericCsvSchema } from './primitives';

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

export const ReportBoardLayerInputSchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Board layer colour must be a 24-bit hex colour')
    .transform((color) => color.toUpperCase()),
  remainingSeconds: z.number().int().min(0).max(65_535),
  climbUuid: ExternalUUIDSchema.nullish(),
  angle: BoardPresenceAngleSchema,
  geometryKnown: z.boolean(),
});

export const ReportBoardLayersInputSchema = z.array(ReportBoardLayerInputSchema).max(MAX_ACTIVE_BOARD_LAYERS);
