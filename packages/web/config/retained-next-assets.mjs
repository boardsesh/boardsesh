/** A build-time opt-in independent of the Next asset URL prefix. */
export function isRetainedNextAssetsEnabled(
  runtimeEnvironment = process.env.NODE_ENV,
  configuredOptIn = process.env.NEXT_PUBLIC_RETAINED_NEXT_ASSETS,
) {
  return runtimeEnvironment === 'production' && configuredOptIn === '1';
}
