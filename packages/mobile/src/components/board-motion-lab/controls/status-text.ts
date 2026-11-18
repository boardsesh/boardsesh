import type { BoardMotionVariant, LabRenderStatus } from '../types';

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

/** Native lab modes do not exist in any binary yet, so those variants are always unavailable. */
export function variantAvailability(variant: BoardMotionVariant, nativeApiVersion: number): VariantAvailability {
  if (variant.requiresNativeLab) {
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
