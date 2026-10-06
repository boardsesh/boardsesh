// What a spray wall is drawn on: its photo, or one of the generated looks the
// backend makes per published version (`sprayWallArt`, `docs/spray-walls.md`).
//
// Pure and import-light: the registry (on the draw path) and the look picker
// both read it.

import { SPRAY_WALL_BACKGROUNDS, type SprayWallBackground } from '@boardsesh/spray-wall-geometry';
import type { SprayArtVariant } from './spray-photo-keys';

export type { SprayWallBackground };

/**
 * The background a stored look asks for. `render_settings.background`, where
 * missing, unknown or anything else reads as `photo` — what every wall drew
 * before generated looks existed.
 */
export function sprayWallBackgroundOf(renderSettings: unknown): SprayWallBackground {
  if (renderSettings == null || typeof renderSettings !== 'object') return 'photo';
  const background = (renderSettings as { background?: unknown }).background;
  return (SPRAY_WALL_BACKGROUNDS as readonly unknown[]).includes(background)
    ? (background as SprayWallBackground)
    : 'photo';
}

/** The cached file a background is drawn from, or `null` for the raw photo. */
export function artVariantForBackground(background: SprayWallBackground | undefined): SprayArtVariant | null {
  if (background === 'wall-crop') return 'crop';
  if (background === 'hold-cutouts') return 'cutout';
  return null;
}
