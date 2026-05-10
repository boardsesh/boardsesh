export const MIN_ASCENTS_FILTER_OPTIONS = [0, 1, 10, 100, 1000, 10000] as const;

export function normalizeMinAscentsFilter(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function getMinAscentsFilterOptions(): number[] {
  return [...MIN_ASCENTS_FILTER_OPTIONS];
}

export function formatMinAscentsFilterCount(value: number): string {
  const normalizedValue = normalizeMinAscentsFilter(value);
  if (normalizedValue >= 1000 && normalizedValue % 1000 === 0) {
    return `${normalizedValue / 1000}k`;
  }
  return String(normalizedValue);
}

export function normalizeMinRatingFilter(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil(value)));
}

export function getMinRatingPickerValue(value: number | null | undefined): number | null {
  const normalizedValue = normalizeMinRatingFilter(value);
  return normalizedValue === 0 ? null : normalizedValue;
}

export function normalizeMinUserQualityFilter(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil(value)));
}

export function getMinUserQualityPickerValue(value: number | null | undefined): number | null {
  const normalizedValue = normalizeMinUserQualityFilter(value);
  return normalizedValue === 0 ? null : normalizedValue;
}
