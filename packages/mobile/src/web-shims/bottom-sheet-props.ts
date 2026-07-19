export function resolveGorhomDynamicSizing(snapPoints: unknown, enableDynamicSizing: boolean | undefined): boolean {
  const hasExplicitSnapPoints = Array.isArray(snapPoints) ? snapPoints.length > 0 : snapPoints !== undefined;
  return !hasExplicitSnapPoints && (enableDynamicSizing ?? true);
}
