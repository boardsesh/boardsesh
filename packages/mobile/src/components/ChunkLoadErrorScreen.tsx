import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { brandColors } from '../theme/colors';
import { spacing } from '../theme/tokens';
import { recoverFromChunkLoadError, reloadPage, type ChunkRecoveryOutcome } from '../lib/chunk-load-recovery';

// The root error boundary's screen for a route chunk that failed to load — web
// only in practice, since the native `isChunkLoadError` is constant false (#5611).
//
// The generic crash screen's buttons cannot help here: "Try again" re-renders a
// React.lazy route whose load React has already marked failed, and "Go home"
// asks for another chunk the same stale deploy no longer serves. The only thing
// that recovers is a page load, so this screen reloads once on its own and
// otherwise offers exactly one button: Reload.
//
// Copy is hardcoded English for the same reason as the generic boundary in
// app/_layout.tsx: it renders before any provider, so i18next is not ready.

type ScreenState = { kind: 'recovering' } | { kind: 'settled'; outcome: ChunkRecoveryOutcome };

const COPY: Record<ChunkRecoveryOutcome | 'recovering', { title: string; message: string }> = {
  recovering: {
    title: 'Loading the latest Boardsesh',
    message: 'This screen needs a fresh copy of the app. One moment.',
  },
  reloading: {
    title: 'Boardsesh just updated',
    message: 'Reloading to get you the latest version.',
  },
  offline: {
    title: "You're offline",
    message: "This screen hasn't downloaded yet. Reconnect, then reload.",
  },
  exhausted: {
    title: "This screen didn't load",
    message: 'Reload the page to try again.',
  },
};

export function ChunkLoadErrorScreen({ error }: { error: Error }) {
  const [state, setState] = useState<ScreenState>({ kind: 'recovering' });
  const recoveredErrorRef = useRef<Error | null>(null);

  useEffect(() => {
    // One recovery per error: the guard already caps reloads, this also keeps a
    // re-render from reporting the same failure twice.
    if (recoveredErrorRef.current === error) return;
    recoveredErrorRef.current = error;
    let cancelled = false;
    setState({ kind: 'recovering' });
    void recoverFromChunkLoadError(error).then((outcome) => {
      if (!cancelled) setState({ kind: 'settled', outcome });
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  const stateKey = state.kind === 'recovering' ? 'recovering' : state.outcome;
  const copy = COPY[stateKey];
  const showReloadButton = state.kind === 'settled' && state.outcome !== 'reloading';

  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Icon name={stateKey === 'offline' ? 'offline.unavailable' : 'refresh'} size={48} color={brandColors.primary} />
      </View>
      <Text variant="title2" style={styles.title}>
        {copy.title}
      </Text>
      <Text variant="body" style={styles.message}>
        {copy.message}
      </Text>
      {showReloadButton && (
        <Pressable
          onPress={reloadPage}
          accessibilityRole="button"
          accessibilityLabel="Reload"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressedButton]}
        >
          <Text variant="body" color={brandColors.onPrimary} style={styles.buttonLabel}>
            Reload
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing[6],
  },
  iconContainer: {
    marginBottom: spacing[5],
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  message: {
    textAlign: 'center',
    marginBottom: spacing[8],
    maxWidth: 320,
    opacity: 0.7,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    width: '100%',
    maxWidth: 280,
    borderRadius: 12,
    backgroundColor: brandColors.primaryFill,
    paddingHorizontal: spacing[5],
  },
  pressedButton: {
    opacity: 0.72,
  },
  buttonLabel: {
    fontWeight: '700',
  },
});
