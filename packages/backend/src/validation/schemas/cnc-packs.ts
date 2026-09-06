import { z } from 'zod';

/**
 * Shape rules for CNC build-pack inputs.
 *
 * Shape only. Whether a board tuple is on sale, whether a manufacturing option
 * holds an allowed value, and whether a piece of artwork physically fits are
 * all decided later — by the catalogue (`services/cnc/catalog.ts`) and by the
 * pack generator, which own that knowledge. This layer's job is to make sure
 * nothing pathological reaches either of them: no NaN millimetres, no 10 MB
 * label, no 500-item artwork list.
 */

/**
 * The most artwork items one pack may carry.
 *
 * Every item costs a rotated-bbox check against every hole on its panel, in the
 * browser on each drag frame and again in the generator, and four is already
 * more than any wall has room for at the 40 mm minimum width.
 */
export const CNC_MAX_ARTWORK_ITEMS = 4;

/** Longest routable text label. Past this it stops fitting on a panel at a legible height. */
export const CNC_MAX_ARTWORK_TEXT_LENGTH = 40;

/**
 * Artwork width bounds in millimetres. The floor is what a router bit can still
 * resolve as a shape; the ceiling is a shade under the widest panel the
 * catalogue's sheet stock can produce, so an item can never be wider than
 * anything it could sit on.
 */
export const CNC_MIN_ARTWORK_WIDTH_MM = 40;
export const CNC_MAX_ARTWORK_WIDTH_MM = 1200;

/**
 * A millimetre coordinate.
 *
 * `z.number()` alone accepts NaN and Infinity, both of which survive JSON and
 * would reach the generator's geometry as a silent poison value. The magnitude
 * cap is a sanity bound, not a wall dimension — the generator does the real
 * "inside the panel" check.
 */
const MillimetreSchema = z
  .number()
  .finite('Coordinates must be finite')
  .min(-100_000, 'Coordinate out of range')
  .max(100_000, 'Coordinate out of range');

export const CncPlacementInputSchema = z.object({
  panelIndex: z.number().int('panelIndex must be a whole number').min(0, 'panelIndex must be >= 0'),
  xMm: MillimetreSchema,
  yMm: MillimetreSchema,
  widthMm: z
    .number()
    .finite('widthMm must be finite')
    .min(CNC_MIN_ARTWORK_WIDTH_MM, `Artwork must be at least ${CNC_MIN_ARTWORK_WIDTH_MM} mm wide`)
    .max(CNC_MAX_ARTWORK_WIDTH_MM, `Artwork may be at most ${CNC_MAX_ARTWORK_WIDTH_MM} mm wide`),
  // Half-turns either way rather than 0..360: the editor's rotate handle
  // produces a signed angle, and normalising here would make the value the
  // buyer sees differ from the value that comes back.
  rotationDeg: z
    .number()
    .finite('rotationDeg must be finite')
    .min(-180, 'rotationDeg must be between -180 and 180')
    .max(180, 'rotationDeg must be between -180 and 180'),
});

export const CncArtworkModeSchema = z.enum(['engrave', 'pocket', 'cut_through']);

/**
 * One artwork item: either an uploaded asset or a typed label, never both and
 * never neither. The generator derives its `kind` from which one is set, so an
 * item with both would be ambiguous and an item with neither would route
 * nothing.
 */
export const CncArtworkInputSchema = z
  .object({
    assetId: z.string().min(1).max(128).nullish(),
    text: z
      .string()
      .trim()
      .min(1, 'A text label cannot be empty')
      .max(CNC_MAX_ARTWORK_TEXT_LENGTH, `A text label may be at most ${CNC_MAX_ARTWORK_TEXT_LENGTH} characters`)
      .nullish(),
    mode: CncArtworkModeSchema,
    placement: CncPlacementInputSchema,
  })
  .refine(
    (item) => (item.assetId != null) !== (item.text != null),
    'Each artwork item needs exactly one of assetId or text',
  );

/**
 * A board tuple plus its manufacturing choices.
 *
 * `options` is deliberately left as an opaque record here. The allowed keys and
 * values live in the catalogue, which is also where the per-key error messages
 * the configurator shows come from — duplicating them as a zod shape would give
 * two sources of truth for the same list. `setIds` is likewise only
 * length-checked; `parseSetIds` in the catalogue does the parsing, and the
 * resolver turns its null into a validation error.
 */
export const CncBoardConfigInputSchema = z.object({
  boardName: z.string().min(1, 'boardName is required').max(50, 'boardName too long'),
  layoutId: z.number().int('layoutId must be a whole number').min(0, 'layoutId must be >= 0'),
  sizeId: z.number().int('sizeId must be a whole number').min(0, 'sizeId must be >= 0'),
  setIds: z.string().min(1, 'setIds is required').max(100, 'setIds too long'),
  options: z.record(z.string(), z.unknown()),
  artwork: z
    .array(CncArtworkInputSchema)
    .max(CNC_MAX_ARTWORK_ITEMS, `A pack may carry at most ${CNC_MAX_ARTWORK_ITEMS} artwork items`)
    .nullish(),
});

export type CncBoardConfigInputValidated = z.infer<typeof CncBoardConfigInputSchema>;
export type CncArtworkInputValidated = z.infer<typeof CncArtworkInputSchema>;

/**
 * A licence id as it arrives from a client.
 *
 * Only length and character set, because this schema runs before the id is used
 * to look anything up. `isLicenceId` in `services/cnc/licence-id.ts` is the
 * canonical predicate; this mirrors it so a malformed id fails as a validation
 * error rather than as a database miss.
 */
export const CncLicenceIdSchema = z
  .string()
  .regex(/^BS-CNC-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/, 'Not a valid licence id');
