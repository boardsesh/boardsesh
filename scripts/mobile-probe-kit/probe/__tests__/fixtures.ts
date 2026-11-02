// Independent, compact source contexts for the supported injector revisions.
// These are text fixtures; real revision copies are separately injected locally.
export const FIXTURE_VARIANTS = ['baseline', 'candidate', 'current-privacy', 'current-credential'] as const;
export type FixtureVariant = (typeof FIXTURE_VARIANTS)[number];

export const LOCAL_LEGACY =
  '        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse;\n';
export const LOCAL_CURRENT =
  '        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse | null;\n';
export const NETWORK_LEGACY =
  '    const networkResponse = await getHttpClient().request<TResponse>(document, sentVariables);\n';
export const NETWORK_CURRENT = `    const networkResponse = signal
      ? await getHttpClient().request<TResponse>({ document, variables: sentVariables, signal })
      : await getHttpClient().request<TResponse>(document, sentVariables);
`;
export const ACTIVATION_PRIVACY =
  '      if (privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();';
export const ACTIVATION_CREDENTIAL =
  '      if (credentialGeneration !== getCredentialGeneration()) return Promise.resolve();';
export const CORE_FRAMES = '                            currentFrames={displayedClimb.frames}';
export const MEASURED_WIDTH =
  '  const measuredOverlayWidth = boardBox ? Math.round(boardBox.width * PixelRatio.get()) : null;';
export const REANIMATED_CURRENT = `import Animated, {
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';`;
export const REANIMATED_LEGACY =
  "import Animated, { useAnimatedStyle, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';";

export function probeFixture(variant: FixtureVariant): Record<string, string> {
  const candidate = variant !== 'baseline';
  const current = variant.startsWith('current-');
  const source: Record<string, string> = {
    'src/hooks/use-native-climb-render.ts': `import { useRef, useMemo } from 'react';
type RenderResult = {
  onOverlayLoad: (loadKey: string | null) => void;
  overlayUri: string | null;
};
  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
    const renderRequest = requestRender(currentCacheKey, renderPriority, () =>
      getOrStartInflightRender(currentCacheKey, () => {
        const configJson = JSON.stringify({
          ...boardConfig.configBase,
          frames: flatFrames,
        });
        return nativeModule.renderHoldsOverlay(configJson, currentCacheKey);
      .then((renderedEntry) => {
        clearRenderStallWatchdog();
    (emittingLoadKey: string | null) => {
      // Before the key-match guards below: a paint is a paint, and the watchdog
      // only ever asks whether expo-image answered.
      clearPaintWatchdog(emittingLoadKey);
  const currentBoardKey = useMemo(
  return {
${candidate ? '    artworkIdentity,\n' : ''}    overlayUri,
`,
    'src/components/LayeredClimbImage.tsx': `import type { ImageErrorEventData } from 'expo-image';
type LayeredClimbImageProps = {
  onOverlayLoad?: (loadKey: string | null) => void;
};
export function backgroundImageUri(path: string): string {
  onOverlayLoad,
  const hidden = isBackgrounded || !boardArtVisible;
  const awaitingOverlay = true;
  if (hidden) {
${
  candidate
    ? '          onLoad={() => noteBoardArtInMemory(backgroundImageUri(path))}'
    : `          allowDownscaling={false}
        />
      ))}`
}
          onLoad={() => {
            onOverlayLoad?.(emittingLoadKey);
          onError={(event) => onOverlayError?.(event, overlayLoadKey ?? null)}
`,
    'src/lib/graphql/hooks/use-infinite-search-climbs.ts': `import { useGradeSourceSearchInput } from './search-grade-source';
    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      }),
`,
    'app/(tabs)/climbs/index.tsx': `import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
  const handleClimbPress = useCallback(
${candidate ? "    (climb: Climb, readyBoardArt?: import('../../../src/lib/board-render/ready-board-art').ReadyBoardArtSnapshot) => {" : '    (climb: Climb) => {'}
      if (isPlaceholderDataRef.current) return;
  const anotherAction = () => {
      if (isPlaceholderDataRef.current) return;
`,
    'app/play.tsx': `import { useEffect, useRef } from 'react';
function PlayScreen() {
  const queueSheetRef = useRef<QueueSheetHandle>(null);
    <Link.AppleZoomTarget>
    </Link.AppleZoomTarget>
${candidate ? 'canConsumeTarget(playTarget.nonce);\n' : ''}`,
    'src/components/play-drawer/SwipeBoardCarousel.tsx': `import { useEffect } from 'react';
${current ? REANIMATED_CURRENT : REANIMATED_LEGACY}
  const isScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
  const boardBox = useMemo(() => null, []);
${MEASURED_WIDTH}
  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');
`,
    'src/lib/graphql/offline-request.ts': `import { ${current ? 'isLocalDataOwnerCurrent' : 'canReadPrivateCatalog'} } from '../owner';
      localDb = getDatabaseHandle();
        (await ${current ? 'isLocalDataOwnerCurrent' : 'canReadPrivateCatalog'}(localDb)) &&
${current ? LOCAL_CURRENT : LOCAL_LEGACY}${current ? NETWORK_CURRENT : NETWORK_LEGACY}`,
    'src/components/onboarding/ConsentGate.tsx': `import { useEffect } from 'react';
    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      updateConsentState({ settled: true });
`,
    'src/lib/overlay-index.ts': `import { cache } from './cache';
  const entry = { uri, generation: nextOverlayGeneration };
function dropKey(cacheKey: string): boolean {
export function clearOverlayIndex(): void {
`,
    'src/components/BoardImageNative.tsx': `import { useRef } from 'react';
  const {
    overlayUri,
        onOverlayLoad={onOverlayLoad}
${
  candidate
    ? `            if (!bridging) onReadyArtDisplayed?.(displayedArt);
      liveArtRef.current.onReadyArtDisplayed?.(pending.art);
`
    : ''
}`,
  };
  if (candidate) {
    source['src/components/play-drawer/PlayCore.tsx'] = `import { useRef } from 'react';
  const isAnonymous = viewer === 'anonymous';
${CORE_FRAMES}
`;
    source['src/lib/playlists/use-playlist-activation.ts'] = `import { useCallback } from 'react';
${
  variant === 'candidate'
    ? `      if (!loadedSnapshotCurrent || privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();
      if (capturedGeneration !== undefined && capturedGeneration !== privacyGeneration) return Promise.resolve();
      if (!loadedClimb && initialPrivacyGeneration.current !== privacyGeneration) return Promise.resolve();`
    : variant === 'current-privacy'
      ? ACTIVATION_PRIVACY
      : ACTIVATION_CREDENTIAL
}
`;
  }
  return source;
}
