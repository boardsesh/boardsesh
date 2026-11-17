import { SWAP_LOOK_NATIVE_VERSION } from '../../play-drawer/swap-look';
import type { BoardMotionVariant, LabRenderStatus } from '../types';
import { SWAP_LOOK_LAB_MODE } from '../variants/look-variant';

/** "GPU · API 7 · prepare 42 ms · upload 3 ms", "PNG · <reason>" or "Loading…". */
export function formatStatus(status: LabRenderStatus): string {
  switch (status.path) {
    case 'loading':
      return 'Loading…';
    case 'gpu':
      return [
        'GPU',
        `API ${status.apiVersion}`,
        status.prepareMs === null ? null : `prepare ${Math.round(status.prepareMs)} ms`,
        status.uploadMs === null ? null : `upload ${Math.round(status.uploadMs)} ms`,
      ]
        .filter((part) => part !== null)
        .join(' · ');
    case 'png':
      return `PNG · ${status.reason}`;
  }
}

export type VariantAvailability = { available: true } | { available: false; reason: string };

/**
 * Whether this binary can run `variant`. The one native lab mode is the swap
 * look (`swapLookVersion`, iOS only for now); any other mode is unavailable.
 */
export function variantAvailability(
  variant: BoardMotionVariant,
  nativeApiVersion: number,
  swapLookVersion = 0,
): VariantAvailability {
  if (variant.requiresNativeLab === SWAP_LOOK_LAB_MODE) {
    if (swapLookVersion < SWAP_LOOK_NATIVE_VERSION) {
      return {
        available: false,
        reason: `needs the native swap look (iOS, swapLookVersion ${SWAP_LOOK_NATIVE_VERSION}); this build has ${swapLookVersion}`,
      };
    }
  } else if (variant.requiresNativeLab) {
    return { available: false, reason: `needs native lab mode "${variant.requiresNativeLab}"` };
  }
  if (variant.requiresNativeApi !== undefined && variant.requiresNativeApi > nativeApiVersion) {
    return {
      available: false,
      reason: `needs native API ${variant.requiresNativeApi}, this build has ${nativeApiVersion}`,
    };
  }
  return { available: true };
}

export function captionText(variant: BoardMotionVariant): string {
  return `${variant.letter} · ${variant.name}`;
}
