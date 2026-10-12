/** Native identities are allowlisted; callback destinations never come from a caller URL. */
export type NativeAppVariant = 'production' | 'dev';

export function parseNativeAppVariant(input: unknown): NativeAppVariant | null {
  if (input === undefined || input === null) return 'production';
  return input === 'production' || input === 'dev' ? input : null;
}

export function nativeAppVariantForApplicationId(applicationId: string | null): NativeAppVariant {
  return applicationId === 'com.boardsesh.app.dev' ? 'dev' : 'production';
}

export function nativeAppIdentity(variant: NativeAppVariant) {
  const bundleId = variant === 'dev' ? 'com.boardsesh.app.dev' : 'com.boardsesh.app';
  return { bundleId, scheme: bundleId, appGroup: `group.${bundleId}` };
}
