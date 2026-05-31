import { useCallback } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useTheme } from '../../../src/providers/theme-provider';
import { useAuth } from '../../../src/providers/auth-provider';
import { useSetting } from '../../../src/settings';
import { getDatabaseHandle } from '../../../src/db';
import {
  getDeadLetterCount,
  getDeadLetters,
  retryDeadLetter,
  discardDeadLetter,
  getPendingCount,
  drainMutationQueue,
} from '../../../src/mutation-queue';
import { useSyncStatus } from '../../../src/sync';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { Icon } from '../../../src/components/Icon';
import { ListRow } from '../../../src/components/ListRow';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { Text } from '../../../src/components/Text';
import { isPreviewBuild } from '../../../src/lib/eas-api';

type ToggleSettingKey =
  | 'autoConnectBle'
  | 'keepScreenAwake'
  | 'hapticFeedbackEnabled'
  | 'notifySessionInvites'
  | 'notifyClimbComments';

// Boards that support offline sync. Only Kilter and Tension have the per-board
// pull resolvers + local tables; the other SUPPORTED_BOARDS entries (MoonBoard,
// Decoy, …) have no offline path, so they are deliberately not listed here.
const SYNCABLE_BOARDS = [
  { boardType: 'kilter', label: 'Kilter' },
  { boardType: 'tension', label: 'Tension' },
] as const;

function ToggleRow({ title, settingsKey }: { title: string; settingsKey: ToggleSettingKey }) {
  const [value, setValue] = useSetting(settingsKey);
  const { brandColors } = useTheme();

  return (
    <ListRow
      title={title}
      trailing={<Switch value={value} onValueChange={setValue} trackColor={{ true: brandColors.tint }} />}
      haptic={false}
    />
  );
}

type ThemeOption = 'system' | 'light' | 'dark';

function ThemePicker() {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const [theme, setTheme] = useSetting('theme');

  const options: { value: ThemeOption; label: string }[] = [
    { value: 'system', label: t('mobile.settings.themeSystem') },
    { value: 'light', label: t('mobile.settings.themeLight') },
    { value: 'dark', label: t('mobile.settings.themeDark') },
  ];

  return (
    <>
      {options.map((option, index) => (
        <ListRow
          key={option.value}
          title={option.label}
          onPress={() => setTheme(option.value)}
          showSeparator={index < options.length - 1}
          trailing={theme === option.value ? <Icon name="check.small" size={18} color={brandColors.tint} /> : undefined}
        />
      ))}
    </>
  );
}

// Single offline-board toggle. Enabling kicks off a long from-empty pull of every
// climb on that board, so confirm first; disabling just stops future pulls (the
// already-downloaded rows stay for offline browse).
function BoardSyncRow({
  boardType,
  label,
  showSeparator,
}: {
  boardType: string;
  label: string;
  showSeparator: boolean;
}) {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const [enabledBoards, setEnabledBoards] = useSetting('syncEnabledBoards');
  const isEnabled = enabledBoards.includes(boardType);

  const setEnabled = (next: boolean) => {
    setEnabledBoards(
      next ? [...new Set([...enabledBoards, boardType])] : enabledBoards.filter((entry) => entry !== boardType),
    );
  };

  const handleToggle = (next: boolean) => {
    if (next) {
      Alert.alert(
        t('mobile.settings.boardSyncEnableTitle', { board: label }),
        t('mobile.settings.boardSyncEnableMessage'),
        [
          { text: t('mobile.settings.cancel'), style: 'cancel' },
          { text: t('mobile.settings.boardSyncEnableConfirm'), onPress: () => setEnabled(true) },
        ],
      );
      return;
    }
    setEnabled(false);
  };

  return (
    <ListRow
      title={label}
      trailing={<Switch value={isEnabled} onValueChange={handleToggle} trackColor={{ true: brandColors.tint }} />}
      showSeparator={showSeparator}
      haptic={false}
    />
  );
}

function formatMinutesAgo(epochMs: number): number {
  return Math.max(0, Math.floor((Date.now() - epochMs) / 60000));
}

// Live sync-status row: shows the running phase + document count while a pull is
// in flight, otherwise "last synced …" for this session (or a never-synced hint).
function BoardSyncStatusRow() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { progress, isSyncing, lastSyncedAt } = useSyncStatus();
  const [enabledBoards] = useSetting('syncEnabledBoards');

  if (enabledBoards.length === 0) {
    return <ListRow title={t('mobile.settings.boardSyncStatusOff')} showSeparator={false} haptic={false} />;
  }

  let statusText: string;
  if (isSyncing && progress) {
    statusText =
      progress.phase === 'board_data'
        ? t('mobile.settings.boardSyncProgressClimbs', { count: progress.documentsProcessed })
        : t('mobile.settings.boardSyncProgressGeneric', { count: progress.documentsProcessed });
  } else if (lastSyncedAt !== null) {
    statusText = t('mobile.settings.boardSyncLastSynced', { count: formatMinutesAgo(lastSyncedAt) });
  } else {
    statusText = t('mobile.settings.boardSyncNotSyncedYet');
  }

  return (
    <ListRow
      title={t('mobile.settings.boardSyncStatusLabel')}
      trailing={
        <Text variant="subheadline" style={{ color: systemColors.secondaryLabel }}>
          {statusText}
        </Text>
      }
      showSeparator={false}
      haptic={false}
    />
  );
}

// Dead-letter surface: a write that exhausted its retries lands in dead_letter and
// will never sync on its own. Poll the count (refetched on focus) and, when any
// exist, let the user retry (re-queue + kick the drainer) or discard (drop the
// failed write). Hidden entirely when the queue is clean.
function DeadLetterSection() {
  const { t } = useTranslation('common');
  const { systemColors, borderRadius, spacing } = useTheme();
  const queryClient = useQueryClient();

  const { data: deadLetterCount = 0, refetch } = useQuery({
    queryKey: ['deadLetters'],
    queryFn: async () => {
      const db = getDatabaseHandle();
      if (!db) return 0;
      return getDeadLetterCount(db);
    },
    // Catch a drain that dead-letters while the user is sitting on this screen,
    // without waiting for a re-focus. The query is local SQLite, so polling is cheap.
    refetchInterval: 5000,
  });

  // Refetch whenever the screen regains focus so the badge reflects a drain that
  // dead-lettered while the user was elsewhere.
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const handleRetry = async () => {
    const db = getDatabaseHandle();
    if (!db) return;
    try {
      const failed = await getDeadLetters(db);
      for (const mutation of failed) {
        await retryDeadLetter(db, mutation.id);
      }
      // Fire the runner so re-queued writes push immediately when online. Not
      // awaited — it drains in the background; we just refresh the badge.
      const graphqlFetch = <T,>(query: string, variables?: Record<string, unknown>) =>
        getHttpClient().request<T>(query, variables);
      void drainMutationQueue(db, queryClient, graphqlFetch);
    } catch (error) {
      if (__DEV__) {
        console.warn('[Settings] retry dead-letters failed:', error);
      }
    } finally {
      refetch();
    }
  };

  const handleDiscard = async () => {
    const db = getDatabaseHandle();
    if (!db) return;
    try {
      const failed = await getDeadLetters(db);
      for (const mutation of failed) {
        await discardDeadLetter(db, mutation.id);
      }
    } catch (error) {
      if (__DEV__) {
        console.warn('[Settings] discard dead-letters failed:', error);
      }
    } finally {
      refetch();
    }
  };

  const confirmDiscard = () => {
    Alert.alert(t('mobile.settings.deadLetterDiscardTitle'), t('mobile.settings.deadLetterDiscardMessage'), [
      { text: t('mobile.settings.cancel'), style: 'cancel' },
      { text: t('mobile.settings.deadLetterDiscard'), style: 'destructive', onPress: handleDiscard },
    ]);
  };

  if (deadLetterCount === 0) return null;

  const cardStyle = {
    backgroundColor: systemColors.secondaryBackground,
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    overflow: 'hidden' as const,
  };

  return (
    <View style={styles.section}>
      <SectionHeader title={t('mobile.settings.syncIssuesSection')} />
      <View style={cardStyle}>
        <ListRow
          title={t('mobile.settings.deadLetterCount', { count: deadLetterCount })}
          subtitle={t('mobile.settings.deadLetterSubtitle')}
          leading={<Icon name="warning" size={22} color={systemColors.label} />}
          haptic={false}
        />
        <ListRow title={t('mobile.settings.deadLetterRetry')} onPress={handleRetry} />
        <ListRow title={t('mobile.settings.deadLetterDiscard')} onPress={confirmDiscard} showSeparator={false} />
      </View>
    </View>
  );
}

export default function MoreScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const { signOut } = useAuth();
  const { t } = useTranslation('common');

  const appVersion = Constants.expoConfig?.version ?? '2.0.0';

  const handleSignOut = () => {
    // Sign-out wipes this user's local data, including any not-yet-synced writes.
    // If writes are still queued, warn with the exact count so the user knows what
    // they'd drop (auth-provider attempts a best-effort drain before clearing, but
    // an offline device can't, so the loss is real).
    const db = getDatabaseHandle();
    const finishSignOut = (pendingCount: number) => {
      const message =
        pendingCount > 0
          ? t('mobile.settings.signOutPendingMessage', { count: pendingCount })
          : t('mobile.settings.signOutConfirmMessage');
      Alert.alert(t('mobile.settings.signOutConfirmTitle'), message, [
        { text: t('mobile.settings.cancel'), style: 'cancel' },
        { text: t('mobile.settings.signOut'), style: 'destructive', onPress: signOut },
      ]);
    };

    if (!db) {
      finishSignOut(0);
      return;
    }
    getPendingCount(db)
      .then(finishSignOut)
      .catch(() => finishSignOut(0));
  };

  const cardStyle = {
    backgroundColor: systemColors.secondaryBackground,
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    overflow: 'hidden' as const,
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <DevMetadataPanel />

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.sessionSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.autoConnectBle')} settingsKey="autoConnectBle" />
          <ToggleRow title={t('mobile.settings.keepScreenAwake')} settingsKey="keepScreenAwake" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.notificationsSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.sessionInvites')} settingsKey="notifySessionInvites" />
          <ToggleRow title={t('mobile.settings.climbComments')} settingsKey="notifyClimbComments" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.appearanceSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.hapticFeedback')} settingsKey="hapticFeedbackEnabled" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.themeSection')} />
        <View style={cardStyle}>
          <ThemePicker />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.boardDataSection')} />
        <Text variant="footnote" style={[styles.sectionNote, { color: systemColors.secondaryLabel }]}>
          {t('mobile.settings.boardDataNote')}
        </Text>
        <View style={cardStyle}>
          {SYNCABLE_BOARDS.map((board) => (
            <BoardSyncRow key={board.boardType} boardType={board.boardType} label={board.label} showSeparator />
          ))}
          <BoardSyncStatusRow />
        </View>
      </View>

      <DeadLetterSection />

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.accountSection')} />
        <View style={cardStyle}>
          <ListRow title={t('mobile.settings.signOut')} onPress={handleSignOut} showSeparator={false} />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.aboutSection')} />
        <View style={cardStyle}>
          <ListRow
            title={t('mobile.settings.version')}
            trailing={
              <Text variant="body" style={{ color: systemColors.secondaryLabel }}>
                {appVersion}
              </Text>
            }
            showSeparator={false}
            haptic={false}
          />
        </View>
      </View>

      {__DEV__ ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.development')} />
          <View style={cardStyle}>
            <ListRow
              title={t('mobile.more.metroServersTitle')}
              subtitle={t('mobile.more.metroServersSubtitle')}
              leading={<Icon name="server" size={22} color={systemColors.secondaryLabel} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/more/dev-servers')}
            />
          </View>
        </View>
      ) : null}

      {isPreviewBuild() ? (
        <View style={styles.section}>
          {/* i18n-ignore-next-line — preview-only section */}
          <SectionHeader title="Preview Build" />
          <View style={cardStyle}>
            <ListRow
              // i18n-ignore-next-line
              title="Branch Switcher"
              // i18n-ignore-next-line
              subtitle="Switch EAS Update branch"
              leading={<Icon name="branch" size={22} color={systemColors.label} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/more/branch-switcher')}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingTop: 16,
    paddingBottom: 32,
  },
  section: {
    width: '100%',
    marginBottom: 24,
  },
  sectionNote: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
});
