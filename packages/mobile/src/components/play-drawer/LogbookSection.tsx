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
import { LogbookSession } from './logbook/LogbookSession';
import { LogbookStatLine } from './logbook/LogbookStatLine';
import { LogbookHeadline, LogbookVerdict } from './logbook/LogbookVerdict';
import { formatLedgerDayLabel, ledgerDayKeys } from './logbook/day-label';
import { useClimbLedger } from './logbook/use-climb-ledger';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
import { nowMs } from '../../lib/clock';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type LogbookSectionProps = {
  climbUuid: string;
  boardName: BoardName;
  layoutId: number;
  /** The angle the board is set to. Its section leads and the line under the verdict covers it. */
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
// worst case here is 6 days x 4 rows plus one heading per angle, and angles are
// a small fixed set per board.
const MAX_SESSIONS_INLINE = 6;
const MAX_ENTRIES_PER_SESSION = 4;
const STATE_GLYPH_SIZE = 16;

type InlineAngle = {
  section: LedgerAngleSection<LogbookEntry>;
  sessions: LedgerSession<LogbookEntry>[];
};

// Spends the session budget in ledger order: the board's angle first (newest
// session first), then the other angles steepest first. Every angle keeps its
// heading even when the budget ran out before its days.
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
    if (sessions.some((session) => session.entries.length > MAX_ENTRIES_PER_SESSION)) hasHiddenEntries = true;
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
  const { brandColors, systemColors } = useTheme();
  const { ledger, hasEntries, fetched, error, offline, retry, climbCurrentRevision } = useClimbLedger(
    boardName,
    climbUuid,
    angle,
  );
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
          <Icon name="history" size={STATE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.flexText}>
            {t('mobile.logbook.signedOut')}
          </Text>
        </View>
      </View>
    );
  }

  // Leads every signed-in branch: a tick still on the phone is the newest thing
  // the climber did here, whatever the rest of the card can or cannot show. The
  // words are in the label colour: the orange glyph is decoration, not the status.
  const pendingRow =
    pendingTicks > 0 ? (
      <View style={styles.row}>
        <Icon name="clock" size={STATE_GLYPH_SIZE} color={brandColors.warning} />
        <Text variant="subheadline" style={styles.flexText}>
          {t('mobile.logbook.pendingSync', { count: pendingTicks })}
        </Text>
      </View>
    ) : null;

  // The fetch for THIS climb has not landed and will not on its own: either it
  // is waiting on signal (offlineFirst pauses it and leaves `error` null), or
  // it failed. Only the first is about signal. A failure with signal (a server
  // error, a rate limit, an expired session) gets a line that says so and a
  // tap to run the fetch again, since nothing else would until the card remounts.
  const historyUnavailable = !fetched && (error !== null || offline);
  let historyLine: ReactNode = null;
  if (historyUnavailable && offline) {
    historyLine = (
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {t('mobile.logbook.offlineEarlier')}
      </Text>
    );
  } else if (historyUnavailable) {
    const retryLabel = t('mobile.logbook.loadFailedRetry');
    historyLine = (
      <PressableSurface
        onPress={retry}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        style={styles.retryRow}
      >
        <Icon name="refresh" size={STATE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.flexText}>
          {retryLabel}
        </Text>
      </PressableSurface>
    );
  }

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
    const seeFullLabel =
      hiddenSessions > 0
        ? t('mobile.logbook.seeFullLogbook', { count: hiddenSessions })
        : t('mobile.logbook.seeFullLogbookPlain');
    // One angle needs no heading: the verdict above already names it.
    const showAngleHeaders = ledger.angles.length > 1;
    // The totals describe one angle when the board's angle has logs (it then
    // leads the ledger) or when the climber has logged a single angle.
    const statSection = ledger.totals.scope === 'angle' || !showAngleHeaders ? ledger.angles[0] : undefined;

    return (
      <View style={styles.container}>
        {pendingRow}
        <View style={styles.summary}>
          <LogbookVerdict verdict={ledger.verdict} todayKey={dayKeys.todayKey} yesterdayKey={dayKeys.yesterdayKey} />
          <LogbookStatLine totals={ledger.totals} section={statSection} />
        </View>
        {/* What is on the phone (an optimistic or cached tick, or the synced
            rows shown while the fetch is in flight) is not the whole history
            until this climb's fetch lands. */}
        {historyLine}
        {inline.map(({ section, sessions }) => {
          const isBoardAngle = section.angle === angle;
          return (
            <View key={section.angle} style={styles.angleSection}>
              {showAngleHeaders ? (
                // The line under the verdict tells the board angle's story.
                <LogbookAngleHeader section={section} isBoardAngle={isBoardAngle} showStory={!isBoardAngle} />
              ) : null}
              {sessions.map((session) => (
                <LogbookSession
                  key={session.dayKey}
                  session={session}
                  dayLabel={formatLedgerDayLabel(session.dayKey, dayLabelOptions)}
                  showMirrorTag={showMirrorTag}
                  showDayTries={section.sessionCount > 1}
                  maxEntries={MAX_ENTRIES_PER_SESSION}
                  climbCurrentRevision={climbCurrentRevision}
                />
              ))}
            </View>
          );
        })}
        {somethingHidden && onOpenFullLogbook ? (
          <PressableSurface
            onPress={onOpenFullLogbook}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={seeFullLabel}
            style={[styles.seeAll, { borderTopColor: systemColors.separator }]}
          >
            <Text variant="subheadline" color={systemColors.accent} style={styles.seeAllLabel}>
              {seeFullLabel}
            </Text>
            <Icon name="chevron.right" size={STATE_GLYPH_SIZE} color={systemColors.accent} />
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
    countSummary = <LogbookHeadline sent={sends > 0} text={summaryText} />;
  }

  // No history from the server and no logs on the phone. Never the untried state: the climber
  // may well have logged this, the card just cannot know.
  if (historyUnavailable) {
    return (
      <View style={styles.container}>
        {pendingRow}
        {countSummary}
        {historyLine}
      </View>
    );
  }

  // Guard the fetch so neither fallback below flashes before entries land. The
  // ticks synced to the phone fill the card meanwhile (`useClimbLedger`); this
  // is what is left when there are none, or the phone may not serve them.
  if (!fetched) {
    return (
      <View style={styles.container}>
        {pendingRow}
        <View style={styles.row}>
          <ActivityIndicator size="small" color={systemColors.secondaryLabel} />
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
  // The verdict and the line under it read as one block.
  summary: {
    gap: 2,
  },
  angleSection: {
    gap: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  retryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 44,
  },
  flexText: {
    flex: 1,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  seeAllLabel: {
    flex: 1,
    fontWeight: '600',
  },
});
