export function isNewHeatmapFailure({
  active,
  isError,
  isFetching,
  errorUpdatedAt,
  handledErrorAt,
}: {
  active: boolean;
  isError: boolean;
  isFetching: boolean;
  errorUpdatedAt: number;
  handledErrorAt: number;
}): boolean {
  return active && isError && !isFetching && errorUpdatedAt > handledErrorAt;
}
