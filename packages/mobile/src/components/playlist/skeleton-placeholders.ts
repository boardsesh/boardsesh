/** Number of skeleton rows shown while the first page of a playlist loads. */
export const SKELETON_ROW_COUNT = 8;

/**
 * Stable hoisted keys for the first-page skeleton rows. Shared by the
 * playlist-detail view and the two detail routes' early-return loading states so
 * the row count never drifts between them. Never reordered, so index keys are
 * fine and we avoid allocating an array on every render.
 */
export const SKELETON_PLACEHOLDERS = Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => `skeleton-${index}`);
