// Tester/dev-only harness for the offline local-write path (issue #4315).
//
// The failure this screen exists to reproduce cannot be produced by ordinary
// use: every measured board import fits inside the shipped 5s `busy_timeout`, so
// "log a tick during a download" just yields a fast save. Two tools here, plus
// the read that proves the outcome:
//
//   1. Hold write lock — a SECOND connection sits on a real write lock. Any hold
//      longer than the timeout makes the app's next write throw the GENUINE
//      platform lock error, which is the only way to check on a device that
//      `isDatabaseLockedError` still matches what Android and iOS emit.
//   2. Fault mode — deterministic error shapes for the branches a real lock
//      cannot schedule (a fixed number of failures, a non-lock error, and the
//      commit-then-throw case behind the tick INSERT's OR IGNORE).
//   3. Outbox inspector — the newest `pending_mutations` rows. The More tab's
//      "Sync issues" section only renders online and only lists dead letters, so
//      nothing else in the app can show a degraded tick's queued row.
//
// All copy is hardcoded English with `i18n-ignore`, matching the other dev
// screens (FeatureFlagsScreen, DevServerSwitcherScreen).

import { useCallback, useState } from 'react';
import { View, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { Text } from '../Text';
import { SectionHeader } from '../SectionHeader';
import { ListRow } from '../ListRow';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { getDatabaseHandle } from '../../db';
import { holdWriteLock } from '../../offline/dev/lock-holder';
import { setWriteFault, type WriteFaultMode } from '../../offline/dev/write-fault-injection';
import { usePendingMutations } from '../../offline/dev/use-pending-mutations';

const HOLD_DURATIONS_MS = [3000, 7000, 15000];

const FAULT_MODES: { mode: WriteFaultMode; label: string }[] = [
  // i18n-ignore-next-line — tester-only screen
  { mode: 'off', label: 'Off' },
  { mode: 'ios-lock', label: 'iOS lock' },
  { mode: 'android-lock', label: 'Android lock (control byte)' },
  { mode: 'android-lock-no-code', label: 'Android lock (no code)' },
  { mode: 'disk-full', label: 'Disk full (not retryable)' },
  { mode: 'commit-then-throw', label: 'Commit, then throw' },
];

const FAIL_ATTEMPT_CHOICES = [1, 99];

export function DevOfflineWritesScreen() {
  const { systemColors, spacing } = useTheme();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const database = getDatabaseHandle();
  const pendingMutations = usePendingMutations(database);

  const [holdStatus, setHoldStatus] = useState<string | null>(null);
  const [faultMode, setFaultMode] = useState<WriteFaultMode>('off');
  const [failAttempts, setFailAttempts] = useState(1);

  const handleHold = useCallback((durationMs: number) => {
    // i18n-ignore-next-line — tester-only screen
    setHoldStatus(`Holding the write lock for ${durationMs / 1000}s — log a tick NOW.`);
    holdWriteLock(durationMs)
      // i18n-ignore-next-line
      .then(() => setHoldStatus('Lock released.'))
      .catch((error: unknown) => {
        // i18n-ignore-next-line
        setHoldStatus(`Hold failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  const applyFault = useCallback((mode: WriteFaultMode, attempts: number) => {
    setFaultMode(mode);
    setFailAttempts(attempts);
    setWriteFault(mode, attempts);
  }, []);

  // Same route guard as FeatureFlagsScreen: hiding the More-tab row is not a
  // guard, since a deep link reaches this route directly — and this screen can
  // hold a real write lock on the user's database.
  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
          <ActivityIndicator />
        </View>
      );
    }
    if (!profile?.isTester) {
      return <Redirect href="/(tabs)/profile/more" />;
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: systemColors.groupedBackground }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[4] }}
    >
      {/* i18n-ignore-next-line — tester-only screen */}
      <SectionHeader title="Hold the write lock" />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {/* i18n-ignore-next-line */}
        Opens a second connection and sits on a real write lock. Start a hold, then log an ascent: a hold shorter than
        the 9s budget should still save normally; a longer one should degrade to an outbox-only row.
      </Text>
      <View style={[styles.buttonRow, { gap: spacing[2] }]}>
        {HOLD_DURATIONS_MS.map((durationMs) => (
          <Button
            key={durationMs}
            // i18n-ignore-next-line
            title={`${durationMs / 1000}s`}
            variant="tonal"
            size="small"
            onPress={() => handleHold(durationMs)}
          />
        ))}
      </View>
      {holdStatus !== null && (
        <Text variant="footnote" color={systemColors.label}>
          {holdStatus}
        </Text>
      )}

      {/* i18n-ignore-next-line — tester-only screen */}
      <SectionHeader title="Inject a write fault" />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {/* i18n-ignore-next-line */}
        Deterministic error shapes for the branches a real lock cannot schedule. Fail 1 attempt to see the retry
        recover; fail 99 to see the ladder exhaust and the tick degrade.
      </Text>
      <View style={[styles.buttonRow, { gap: spacing[2] }]}>
        {FAIL_ATTEMPT_CHOICES.map((attempts) => (
          <Button
            key={attempts}
            // i18n-ignore-next-line
            title={`Fail ${attempts}`}
            variant={failAttempts === attempts ? 'filled' : 'outlined'}
            size="small"
            onPress={() => applyFault(faultMode, attempts)}
          />
        ))}
      </View>
      {FAULT_MODES.map((option) => (
        <ListRow
          key={option.mode}
          title={option.label}
          // i18n-ignore-next-line
          subtitle={faultMode === option.mode ? 'Armed' : undefined}
          onPress={() => applyFault(option.mode, failAttempts)}
        />
      ))}

      {/* i18n-ignore-next-line — tester-only screen */}
      <SectionHeader title="Outbox (newest 50)" />
      <Button
        // i18n-ignore-next-line
        title="Refresh"
        variant="outlined"
        size="small"
        onPress={() => void pendingMutations.refetch()}
      />
      {pendingMutations.data?.length === 0 && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {/* i18n-ignore-next-line */}
          Nothing queued.
        </Text>
      )}
      {pendingMutations.data?.map((row) => (
        <ListRow
          key={row.id}
          title={`${row.table_name} · ${row.operation} · ${row.status}`}
          subtitle={`${row.idempotency_key} · retries ${row.retry_count} · ${row.created_at}`}
          haptic={false}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap' },
});
