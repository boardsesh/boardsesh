import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { brandColorsDark, materialSurfaces } from '../theme/colors';
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
//
// Colours are explicit for the same reason. With no ThemeProvider above the
// boundary, an uncoloured `Text` falls back to React Native's default black,
// and the web shell paints body and #root #000000, so the copy would be
// black-on-black. The screen commits to the dark Velvet surface the shell
// already is, and colours every element from it.
const palette = materialSurfaces.dark;

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
  // The browser says it is online, but the probe got no answer from the origin
  // (a captive portal, a flaky in-app browser): "offline" would be wrong.
  unreachable: {
    title: "Couldn't reach Boardsesh",
    message: 'Check your connection, then reload.',
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
    void recoverFromChunkLoadError(error)
      .then((outcome) => {
        if (!cancelled) setState({ kind: 'settled', outcome });
      })
      // Recovery catches its own failures today; if that ever changes, the
      // climber still gets the Reload button instead of a spinner-less dead end.
      .catch(() => {
        if (!cancelled) setState({ kind: 'settled', outcome: 'exhausted' });
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
        <Icon
          name={
            stateKey === 'offline'
              ? 'offline.unavailable'
              : stateKey === 'unreachable'
                ? 'server.unreachable'
                : 'refresh'
          }
          size={48}
          color={brandColorsDark.primary}
        />
      </View>
      <Text variant="title2" color={palette.label} style={styles.title}>
        {copy.title}
      </Text>
      <Text variant="body" color={palette.secondaryLabel} style={styles.message}>
        {copy.message}
      </Text>
      {showReloadButton && (
        <Pressable
          onPress={reloadPage}
          accessibilityRole="button"
          accessibilityLabel="Reload"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressedButton]}
        >
          <Text variant="body" color={brandColorsDark.onPrimary} style={styles.buttonLabel}>
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
    backgroundColor: palette.background,
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
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    width: '100%',
    maxWidth: 280,
    borderRadius: 12,
    backgroundColor: brandColorsDark.primaryFill,
    paddingHorizontal: spacing[5],
  },
  pressedButton: {
    opacity: 0.72,
  },
  buttonLabel: {
    fontWeight: '700',
  },
});
