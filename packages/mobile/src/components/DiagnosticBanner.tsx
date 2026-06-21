import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import {
  flushDiagnosticLogs,
  isDiagnosticLoggingEnabled,
  setDiagnosticMode,
  type DiagnosticMode,
  type DiagnosticState,
} from '../lib/diagnostic-logger';
import { useDiagnosticState } from '../hooks/use-diagnostic-mode';
import { brandColors } from '../theme/colors';
import { spacing } from '../theme/tokens';

const MODE_OPTIONS: { mode: DiagnosticMode; label: string }[] = [
  { mode: 'bare_climbs', label: 'Bare' },
  { mode: 'no_thumbnails', label: 'No images' },
  { mode: 'no_overlays', label: 'No overlays' },
  { mode: 'normal', label: 'Normal' },
];

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    bottom: spacing[3],
    zIndex: 1000,
    borderRadius: 10,
    backgroundColor: brandColors.warning,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  title: {
    fontWeight: '700',
  },
  detail: {
    marginTop: 2,
  },
  modeRow: {
    flexDirection: 'row',
    gap: spacing[1],
    marginTop: spacing[2],
  },
  modeButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.58)',
    paddingHorizontal: spacing[1],
    paddingVertical: 5,
  },
  modeButtonActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  modeButtonLabel: {
    fontWeight: '700',
  },
});

function statusText(state: DiagnosticState): string {
  if (state.status === 'uploading') return `sending ${state.pendingCount}`;
  if (state.status === 'error') return `upload waiting`;
  if (state.status === 'sent') return 'sent';
  return state.pendingCount > 0 ? `queued ${state.pendingCount}` : 'ready';
}

export function DiagnosticBanner() {
  const state = useDiagnosticState();

  if (!isDiagnosticLoggingEnabled) return null;

  const sessionId = state.sessionId ?? 'starting';
  return (
    <View style={styles.container}>
      <Pressable accessibilityRole="button" onPress={() => void flushDiagnosticLogs()}>
        <Text variant="caption1" color="#FFFFFF" style={styles.title}>
          Diagnostics {statusText(state)} · {state.mode}
        </Text>
        <Text variant="caption2" color="#FFFFFF" numberOfLines={1} style={styles.detail}>
          Code: {sessionId}. Tap to send now.
        </Text>
      </Pressable>
      <View style={styles.modeRow}>
        {MODE_OPTIONS.map((option) => {
          const selected = option.mode === state.mode;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option.mode}
              onPress={() => setDiagnosticMode(option.mode)}
              style={[styles.modeButton, selected ? styles.modeButtonActive : null]}
            >
              <Text
                variant="caption2"
                color={selected ? brandColors.warning : '#FFFFFF'}
                numberOfLines={1}
                style={styles.modeButtonLabel}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
