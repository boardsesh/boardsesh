import { memo, type ReactNode } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from '@boardsesh/board-react';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import type { LedgerAngleSection, LedgerSession } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { LogbookAngleHeader } from './logbook/LogbookAngleHeader';
import { LogbookSessionTile } from './logbook/LogbookSessionTile';
import { LogbookStatTiles } from './logbook/LogbookStatTiles';
import { LogbookVerdict } from './logbook/LogbookVerdict';
import { formatLedgerDayLabel, ledgerDayKeys } from './logbook/day-label';
import { useClimbLedger } from './logbook/use-climb-ledger';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
import { useConnectivityField } from '../../lib/connectivity/use-connectivity';
import type { ConnectivitySnapshot } from '../../lib/connectivity/connectivity-store';
import { nowMs } from '../../lib/clock';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type LogbookSectionProps = {
  climbUuid: string;
  boardName: BoardName;
  layoutId: number;
  /** The angle the board is set to. Its section leads and the tiles scope to it. */
  angle: number;
  userAscents: number | null | undefined;
  userAttempts: number | null | undefined;
  /** Opens the virtualised full-history sheet. Offered only when the card hides something. */
  onOpenFullLogbook?: () => void;
};

// HARD inline caps. This card renders inside the play drawer's plain
// ScrollView, where a `.map()` over a growable array mounts every row up front
// (docs/react-native-performance.md section 2). A long-running project can hold
// hundreds of logs, so the card shows a fixed amount and hands the rest to the
// virtualised full-logbook sheet. Do not raise these or add an inline expand:
// worst case here is 6 tiles x (4 rows + 40 fall marks) plus one header per
// angle, and angles are a small fixed set per board.
const MAX_SESSIONS_INLINE = 6;
const MAX_ENTRIES_PER_TILE = 4;

// Hoisted: `useConnectivityField` memoizes its reader on the selector identity.
function selectEffectiveOffline(snapshot: ConnectivitySnapshot): boolean {
  return snapshot.effectiveOffline;
}

type InlineAngle = {
  section: LedgerAngleSection<LogbookEntry>;
  sessions: LedgerSession<LogbookEntry>[];
};

// Spends the session budget in ledger order: the board's angle first (newest
// session first), then the other angles steepest first. Every angle keeps its
// header even when the budget ran out before its tiles.
function takeInlineSessions(angles: LedgerAngleSection<LogbookEntry>[]): {
  inline: InlineAngle[];
  hiddenSessions: number;
  hasHiddenEntries: boolean;
} {
  let remaining = MAX_SESSIONS_INLINE;
  let hiddenSessions = 0;
  let hasHiddenEntries = false;
  const inline = angles.map((section) => {
    const sessions = section.sessions.slice(0, remaining);
    remaining -= sessions.length;
    hiddenSessions += section.sessions.length - sessions.length;
    if (sessions.some((session) => session.entries.length > MAX_ENTRIES_PER_TILE)) hasHiddenEntries = true;
    return { section, sessions };
  });
  return { inline, hiddenSessions, hasHiddenEntries };
}

export const LogbookSection = memo(function LogbookSection({
  climbUuid,
  boardName,
  layoutId,
  angle,
  userAscents,
  userAttempts,
  onOpenFullLogbook,
}: LogbookSectionProps) {
  const { t } = useTranslation('session');
  const { isAuthenticated } = useAuth();
  const { systemColors } = useTheme();
  const { ledger, hasEntries, fetched, error } = useClimbLedger(boardName, climbUuid, angle);
  const offline = useConnectivityField(selectEffectiveOffline);
  const { data: pendingTicks = 0 } = useLocalPendingTicks(climbUuid, boardName);

  // A reader with no account has no logbook, so every string below would be a
  // lie about them: `useLogbook` is disabled signed-out (so the ledger is
  // empty), and `userAscents` / `userAttempts` are viewer-scoped and arrive
  // null — which lands squarely on "No tries yet. Get on it." for someone who
  // has never had a try to record. Ahead of every other branch, because the
  // emptiness that reaches them is not the empty state.
  if (!isAuthenticated) {
    return (
      <View style={styles.container}>
        <View style={styles.row}>
          <Icon name="history" size={20} color={iosSystemColors.systemGray} />
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {t('mobile.logbook.signedOut')}
          </Text>
        </View>
      </View>
    );
  }

  // Leads every signed-in branch: a tick still on the phone is the newest thing
  // the climber did here, whatever the rest of the card can or cannot show.
  const pendingRow =
    pendingTicks > 0 ? (
      <View style={styles.row}>
        <Icon name="history" size={20} color={iosSystemColors.systemOrange} />
        <Text variant="subheadline" color={iosSystemColors.systemOrange}>
          {t('mobile.logbook.pendingSync', { count: pendingTicks })}
        </Text>
      </View>
    ) : null;

  // The fetch for THIS climb has not landed and will not until signal returns:
  // either it failed, or it is paused (offlineFirst leaves `error` null).
  const historyUnavailable = !fetched && (error !== null || offline);
  const offlineLine = historyUnavailable ? (
    <View style={styles.row}>
      <Icon name="offline.unavailable" size={20} color={systemColors.secondaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.flexText}>
        {t('mobile.logbook.offlineEarlier')}
      </Text>
    </View>
  ) : null;

  if (hasEntries) {
    // Read on every render rather than memoised, so the labels cannot go stale
    // across midnight. `nowMs()` keeps screenshot captures on the frozen clock.
    const dayKeys = ledgerDayKeys(nowMs());
    const dayLabelOptions = {
      ...dayKeys,
      todayLabel: t('mobile.logbook.dayToday'),
      yesterdayLabel: t('mobile.logbook.dayYesterday'),
    };
    const showMirrorTag = boardSupportsMirroring(boardName, layoutId);
    const { inline, hiddenSessions, hasHiddenEntries } = takeInlineSessions(ledger.angles);
    const somethingHidden = hiddenSessions > 0 || hasHiddenEntries;

    return (
      <View style={styles.container}>
        {pendingRow}
        <LogbookVerdict verdict={ledger.verdict} todayKey={dayKeys.todayKey} yesterdayKey={dayKeys.yesterdayKey} />
        <LogbookStatTiles totals={ledger.totals} boardAngle={angle} />
        {/* What is on the phone (an optimistic or cached tick) is not the whole
            history until this climb's fetch lands. */}
        {offlineLine}
        {inline.map(({ section, sessions }) => (
          <View key={section.angle} style={styles.angleSection}>
            <LogbookAngleHeader section={section} isBoardAngle={section.angle === angle} />
            {sessions.map((session) => (
              <LogbookSessionTile
                key={session.dayKey}
                session={session}
                dayLabel={formatLedgerDayLabel(session.dayKey, dayLabelOptions)}
                showMirrorTag={showMirrorTag}
                maxEntries={MAX_ENTRIES_PER_TILE}
              />
            ))}
          </View>
        ))}
        {somethingHidden && onOpenFullLogbook ? (
          <PressableSurface
            onPress={onOpenFullLogbook}
            feedback="opacity"
            accessibilityRole="button"
            style={[styles.seeAll, { borderTopColor: systemColors.separator }]}
          >
            <Text variant="subheadline" color={systemColors.accent} style={styles.seeAllLabel}>
              {hiddenSessions > 0
                ? t('mobile.logbook.seeFullLogbook', { count: hiddenSessions })
                : t('mobile.logbook.seeFullLogbookPlain')}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.accent} />
          </PressableSurface>
        ) : null}
      </View>
    );
  }

  // The denormalised counts on the climb payload: all the card can say about a
  // climb whose logs it does not hold.
  const sends = userAscents ?? 0;
  const attempts = userAttempts ?? 0;
  let countSummary: ReactNode = null;
  if (sends > 0 || attempts > 0) {
    const sendsLabel = t('mobile.logbook.sendCount', { count: sends });
    const attemptsLabel = t('mobile.logbook.attemptCount', { count: attempts });
    let summaryText: string;
    if (sends > 0 && attempts > 0) {
      summaryText = t('mobile.logbook.summarySendsAndAttempts', { sends: sendsLabel, attempts: attemptsLabel });
    } else if (sends > 0) {
      summaryText = sendsLabel;
    } else {
      summaryText = t('mobile.logbook.summaryAttemptsNoSend', { attempts: attemptsLabel });
    }
    countSummary = (
      <View style={styles.row}>
        <Icon name="tick" size={20} color={iosSystemColors.systemGreen} />
        <Text variant="body">{summaryText}</Text>
      </View>
    );
  }

  // No signal and no logs on the phone. Never the untried state: the climber
  // may well have logged this, the card just cannot know.
  if (historyUnavailable) {
    return (
      <View style={styles.container}>
        {pendingRow}
        {countSummary}
        {offlineLine}
      </View>
    );
  }

  // Guard the fetch so neither fallback below flashes before entries land.
  if (!fetched) {
    return (
      <View style={styles.container}>
        {pendingRow}
        <View style={styles.row}>
          <ActivityIndicator size="small" color={iosSystemColors.systemGray} />
        </View>
      </View>
    );
  }

  if (countSummary) {
    return (
      <View style={styles.container}>
        {pendingRow}
        {countSummary}
      </View>
    );
  }

  const { todayKey, yesterdayKey } = ledgerDayKeys(nowMs());
  return (
    <View style={styles.container}>
      {pendingRow}
      <LogbookVerdict verdict={ledger.verdict} todayKey={todayKey} yesterdayKey={yesterdayKey} />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  angleSection: {
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  flexText: {
    flex: 1,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  seeAllLabel: {
    fontWeight: '600',
  },
});
