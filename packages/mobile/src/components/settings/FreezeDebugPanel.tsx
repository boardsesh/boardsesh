import { View, StyleSheet } from 'react-native';
import { SectionHeader } from '../SectionHeader';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { useProfile } from '../../lib/graphql/hooks';
import { useFreezeDebugFlags, type FreezeDebugFlag } from '../../lib/freeze-debug-store';
import { useFreezeDiagnosticsStatus } from '../../lib/main-thread-watchdog';

// Diagnostic-only panel for the Android-16 climb-list freeze bug. The toggles
// disable ONE suspected cause each so a tester can bisect on a real affected
// device; the status block surfaces the JS-thread heartbeat + native main-thread
// watchdog so we can tell a thread hang from touch interception and confirm the
// instrumentation is actually running. Gated on the admin-granted `tester` role
// (or a dev build) — same audience as the OTA channel switcher (#3068). Copy is
// intentionally un-translated (matches the other tester/dev-only sections in
// profile/more.tsx).

const ROWS: { flag: FreezeDebugFlag; label: string; description: string }[] = [
  {
    flag: 'hideQueueBar',
    label: 'Hide queue bar',
    description: 'Removes the current-climb bar above the tab bar.',
  },
  {
    flag: 'useFlatList',
    label: 'Use FlatList (not FlashList)',
    description: 'Renders the climb list with React Native FlatList instead of FlashList.',
  },
  {
    flag: 'disableRowSwipe',
    label: 'Disable row swipe',
    description: 'Removes the swipe-to-queue/playlist gesture from each row.',
  },
  {
    flag: 'unmountSheets',
    label: 'Unmount bottom sheets',
    description: 'Stops mounting the always-on queue/board sheets (those buttons stop opening).',
  },
  {
    flag: 'hideTopChrome',
    label: 'Hide top chrome',
    description: 'Removes the search/filter bar overlay at the top of the list.',
  },
  {
    flag: 'disableNativeRender',
    label: 'Disable native render',
    description: 'Stops drawing the board-hold thumbnails (tests the native render burst on board select).',
  },
  {
    flag: 'enableWatchdog',
    label: 'Enable main-thread watchdog',
    description:
      'OFF by default. Turn ON, then reproduce the freeze — it captures the main-thread stack and uploads it next time you open the app. Starts a few seconds after launch.',
  },
];

export function FreezeDebugPanel() {
  const { systemColors } = useTheme();
  const { data: profile } = useProfile();
  const { flags, setFlag } = useFreezeDebugFlags();
  const status = useFreezeDiagnosticsStatus();

  // Admin-granted tester, or a local dev build. Never a regular production user.
  if (!profile?.isTester && !__DEV__) return null;

  return (
    <View style={styles.section}>
      {/* i18n-ignore-next-line — tester/dev-only diagnostic panel */}
      <SectionHeader title="Climb-list freeze debug" />
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        {ROWS.map((row) => (
          <SwitchRow
            key={row.flag}
            label={row.label}
            description={row.description}
            value={flags[row.flag]}
            onValueChange={(next) => setFlag(row.flag, next)}
          />
        ))}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hint}>
        {/* i18n-ignore-next-line */}
        Flip ONE switch, go to the Climbs tab, and check if you can scroll and tap. Tell us which switch helps.
      </Text>
      <View style={[styles.card, styles.statusCard, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {/* i18n-ignore-next-line */}
          JS heartbeat: {status.heartbeatRunning ? 'alive' : 'off'} · worst stall {status.worstGapMs} ms
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {/* i18n-ignore-next-line */}
          Native watchdog: {status.watchdogRunning ? 'running' : 'off (iOS / not built)'} · {status.pendingStalls}{' '}
          pending
        </Text>
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hint}>
        {/* i18n-ignore-next-line */}
        If the app fully freezes, force-kill and reopen — the captured main-thread stack uploads automatically.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    width: '100%',
    marginBottom: spacing[6],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  statusCard: {
    marginTop: spacing[3],
    padding: spacing[3],
    gap: spacing[1],
  },
  hint: {
    marginTop: spacing[2],
    paddingHorizontal: spacing[4],
  },
});
