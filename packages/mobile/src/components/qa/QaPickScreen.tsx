import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SearchField } from '../SearchField';
import { Text } from '../Text';
import { useProfile } from '../../lib/graphql/hooks';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { listPrBranches, qaSurfingAvailable, readRefusedPrNumber, surfToPr } from '../../lib/qa/qa-surf';
import { parsePrNumberList } from '../../lib/qa/pr-branch';
import {
  buildQaPickRows,
  fallbackRowTitle,
  filterQaPickRows,
  labelChipColor,
  qaPickListState,
  riskTone,
  unlistedPrNumber,
  visibleLabels,
  type QaPickRow,
  type QaRiskTone,
} from '../../lib/qa/qa-pick-rows';
import { useQaPreviews } from '../../lib/qa/use-qa-previews';
import {
  LAUNCH_ORIGIN,
  QA_PREVIEW_PICKED_EVENT,
  QA_PREVIEW_SKIPPED_EVENT,
  QA_SURF_FAILED_EVENT,
  QA_UNLISTED_SURF_MISSED_EVENT,
  surfFailureReason,
} from '../../lib/qa/qa-analytics';

// This screen was tester-only (hardcoded English, matching Feature Flags and
// the branch switcher) until it opened to every user in #5126. `DEV_HINT` is
// the one string left English-only: it's a dev-build-only hint no shipped
// user ever sees.

// i18n-ignore-next-line — dev-build-only hint, never shown in a shipped build
const DEV_HINT = 'Surfing is unavailable in a dev build — the list is read-only here.';

const NO_ROWS: QaPickRow[] = [];
const keyExtractor = (row: QaPickRow) => row.branch;

/**
 * The launch prompt's list of PR previews this build can load, and the drawer's
 * "Test a PR preview" destination.
 *
 * The branch list is the source of truth for what is loadable; the backend only
 * decorates it. A backend or GitHub failure therefore degrades to bare `pr-N`
 * rows that still surf — testing is never blocked on metadata.
 */
export function QaPickScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { data: profile } = useProfile();
  const params = useLocalSearchParams<{ prNumbers?: string; origin?: string }>();

  // Seed from the gate's already-paid-for listing so the metadata request starts
  // on the first render instead of waiting for a second round-trip.
  const seedPrNumbers = useMemo(() => parsePrNumberList(params.prNumbers), [params.prNumbers]);

  const branchesQuery = useQuery({
    queryKey: ['qaPrBranches'],
    queryFn: ({ signal }) => listPrBranches(signal),
    staleTime: 30_000,
    retry: 1,
  });
  const branches = branchesQuery.data ?? null;
  const { refetch: refetchBranches } = branchesQuery;

  const prNumbers = branches === null ? seedPrNumbers : branches.map((entry) => entry.prNumber);
  // Metadata needs an account; the branch list does not. A signed-out user still
  // gets every row — rendered as bare `pr-N` — rather than a request that can
  // only be rejected, because testing must never be blocked on metadata.
  const previewsQuery = useQaPreviews(prNumbers, { enabled: profile?.id !== undefined, includeBuilding: true });

  const refusedPrNumber = useMemo(() => (qaSurfingAvailable() ? readRefusedPrNumber() : null), []);
  const rows = useMemo(() => {
    if (branches === null) return NO_ROWS;
    return buildQaPickRows({ branches, previews: previewsQuery.data ?? [], refusedPrNumber });
  }, [branches, previewsQuery.data, refusedPrNumber]);

  const [query, setQuery] = useState('');
  const visibleRows = useMemo(() => filterQaPickRows(rows, query), [rows, query]);
  const unlistedPr = useMemo(() => unlistedPrNumber(rows, query), [rows, query]);

  const [surfingPrNumber, setSurfingPrNumber] = useState<number | null>(null);
  // Swipe-dismiss pops the route without touching Skip, so the "left without
  // choosing" signal is recorded on unmount — one place, both exits, no
  // double-count when a pick did happen.
  const pickedRef = useRef(false);
  const surfInFlightRef = useRef(false);

  // `QA Preview Skipped` is the other half of `QA Preview Prompted`, so it may
  // only fire for a launch that was actually prompted. The drawer's "Test a PR
  // preview" row and the dev More row open the same screen on purpose — counting
  // those as skips inflated the denominator and made the funnel unreadable.
  const isLaunchPrompt = params.origin === LAUNCH_ORIGIN;
  // Armed on "a launch prompt was actually shown". `QaTesterGate` is the only
  // thing that sets `origin=launch`, and only for a tester — but that is a
  // convention, and the screen is now reachable by anyone (including a
  // hand-made deep link carrying the param). Keeping the tester check means the
  // skip event stays the exact other half of `QA Preview Prompted` rather than
  // trusting a URL: a non-tester who opened the list themselves never saw a
  // prompt and cannot have skipped one.
  const launchPromptShown = isLaunchPrompt && Boolean(profile?.isTester);
  const skipArmedRef = useRef(false);
  useEffect(() => {
    if (launchPromptShown) skipArmedRef.current = true;
  }, [launchPromptShown]);
  useEffect(
    () => () => {
      if (skipArmedRef.current && !pickedRef.current) track(QA_PREVIEW_SKIPPED_EVENT, {});
    },
    [],
  );

  const surfingAvailable = qaSurfingAvailable();

  const handlePick = useCallback(
    (row: QaPickRow) => {
      // A ref, not `surfingPrNumber`: two taps inside one React batch both see
      // the pre-render state, and a second `surfToPr` would race the first —
      // competing header overrides and two reloads, so the bundle that actually
      // boots is whichever won, and the verdict would be filed against the PR
      // the tester did NOT choose. The disabled rows below are the visible half
      // of the same guard; this is the half that cannot be out-raced.
      if (!surfingAvailable || surfInFlightRef.current) return;
      // A building row has no branch yet. It is rendered unpressable, but say
      // why rather than swallow a tap that reached here anyway.
      if (!row.loadable) {
        showToast(t('qa.pick.buildingToast'), 'info');
        return;
      }
      surfInFlightRef.current = true;
      setSurfingPrNumber(row.prNumber);
      pickedRef.current = true;
      track(QA_PREVIEW_PICKED_EVENT, { prNumber: row.prNumber, risk: row.risk, source: 'list' });
      void surfToPr(row.prNumber)
        .then((outcome) => {
          // 'reloading' never gets here in practice — the app restarts onto the
          // new bundle mid-promise.
          if (outcome === 'nothing-to-load') {
            surfInFlightRef.current = false;
            setSurfingPrNumber(null);
            showToast(t('qa.pick.nothingNewToast', { prNumber: row.prNumber }), 'info');
          }
        })
        .catch((error: unknown) => {
          surfInFlightRef.current = false;
          setSurfingPrNumber(null);
          pickedRef.current = false;
          reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-pr' } });
          track(QA_SURF_FAILED_EVENT, { prNumber: row.prNumber, reason: surfFailureReason(error) });
          // The thrown message names the actual problem ("Could not reach the
          // update server (502)", "Branch surfing is unavailable on this build"),
          // which is worth showing — but an Error can carry an empty message, and
          // an empty toast tells the tester nothing.
          const message =
            error instanceof Error && error.message.length > 0 ? error.message : t('qa.pick.unreachableTitle');
          showToast(message, 'error');
        });
    },
    [showToast, surfingAvailable, t],
  );

  // The escape hatch behind a no-match search: a PR the branch list never offered.
  // Shares `surfInFlightRef` with `handlePick` so the two entry points cannot race
  // each other into two header overrides and two reloads.
  const handleTrySurf = useCallback(
    (prNumber: number) => {
      if (!surfingAvailable || surfInFlightRef.current) return;
      surfInFlightRef.current = true;
      setSurfingPrNumber(prNumber);
      pickedRef.current = true;
      // A forced surf is still a pick: it runs a bundle and ends in a brief and a
      // verdict, so it belongs in the same funnel. `risk` is unknown — an unlisted
      // PR has no metadata here.
      track(QA_PREVIEW_PICKED_EVENT, { prNumber, risk: null, source: 'search' });

      const rearm = () => {
        surfInFlightRef.current = false;
        setSurfingPrNumber(null);
      };

      void (async () => {
        // Re-ask the update server, and let its answer decide. `/branch_lists` is
        // authoritative — it returns exactly the branches this build can be served,
        // filtered on runtimeVersion and platform — and the local copy is cached for
        // 30s, so the commonest honest reason a PR is missing is that it published a
        // moment ago.
        const refreshed = await refetchBranches();
        if (refreshed.data === null) {
          // Surfing was switched off since the screen loaded.
          rearm();
          pickedRef.current = false;
          showToast(t('qa.pick.surfingOffTitle'), 'info');
          return;
        }
        if (refreshed.data?.some((branch) => branch.prNumber === prNumber)) {
          const outcome = await surfToPr(prNumber);
          // 'reloading' deliberately leaves the in-flight state set and `pickedRef`
          // true: the app is restarting onto that bundle and nothing after this
          // runs. Only the no-op outcome has to hand the screen back.
          if (outcome === 'nothing-to-load') {
            rearm();
            showToast(t('qa.pick.nothingNewToast', { prNumber }), 'info');
          }
          return;
        }
        // Still not listed, so the server will not serve it here — and pinning it
        // anyway would be worse than useless. An unrecognised `xprem-branch` does
        // NOT make the server answer "nothing available": it falls back to the
        // channel's own latest update (verified against updates.boardsesh.com —
        // `pr-0` and `pr-999999` both return the production manifest verbatim). So a
        // speculative pin would quietly fetch and reload the tester onto PRODUCTION
        // while the UI claimed they were on this PR, and leave the device pinned to
        // a branch that does not exist. The refreshed list is the whole answer.
        rearm();
        pickedRef.current = false;
        track(QA_UNLISTED_SURF_MISSED_EVENT, { prNumber, refetchFailed: refreshed.isError });
        // A failed refetch resolves with the STALE list still in `data`, so "not
        // listed" is not evidence of anything. Say we could not check, rather than
        // telling the tester this PR has no preview and pointing blame at its author.
        showToast(
          refreshed.isError ? t('qa.pick.unreachableTitle') : t('qa.pick.notServableToast', { prNumber }),
          refreshed.isError ? 'error' : 'info',
        );
      })().catch((error: unknown) => {
        rearm();
        pickedRef.current = false;
        reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-unlisted-pr' } });
        track(QA_SURF_FAILED_EVENT, { prNumber, reason: surfFailureReason(error) });
        const message =
          error instanceof Error && error.message.length > 0 ? error.message : t('qa.pick.unreachableTitle');
        showToast(message, 'error');
      });
    },
    [refetchBranches, showToast, surfingAvailable, t],
  );

  // Every row goes flat while a surf is in flight, not just the one that was
  // tapped: the app is on its way to another bundle and a second choice cannot
  // be honoured, so offering it would be a lie.
  const rowsDisabled = !surfingAvailable || surfingPrNumber !== null;

  const renderItem = useCallback(
    ({ item }: { item: QaPickRow }) => (
      <QaPickRowItem
        row={item}
        disabled={rowsDisabled}
        busy={surfingPrNumber === item.prNumber}
        onPress={handlePick}
        t={t}
      />
    ),
    [handlePick, rowsDisabled, surfingPrNumber, t],
  );

  const listState = qaPickListState({
    isPending: branchesQuery.isPending,
    isError: branchesQuery.isError,
    surfingOff: branchesQuery.isSuccess && branches === null,
    rows,
    visibleRows,
    hasQuery: query.trim().length > 0,
  });

  // Hidden only where there is no list to filter. Shown while the list loads, so
  // the layout does not jump when rows land, and shown on a dev build, where
  // filtering a read-only list is still useful.
  const showSearchField = listState.kind !== 'surfing-off' && listState.kind !== 'unreachable';

  const trySurfBlock =
    unlistedPr !== null && surfingAvailable ? (
      <TrySurfBlock prNumber={unlistedPr} busy={surfingPrNumber !== null} onTrySurf={handleTrySurf} t={t} />
    ) : null;

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text variant="title3" style={styles.headerTitle}>
          {t('qa.pick.title')}
        </Text>
        <PressableSurface
          onPress={() => router.back()}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('qa.pick.skip')}
        >
          <Text variant="subheadline" color={brandColors.primary}>
            {t('qa.pick.skip')}
          </Text>
        </PressableSurface>
      </View>

      {!surfingAvailable ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hint}>
          {DEV_HINT}
        </Text>
      ) : null}

      {showSearchField ? (
        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t('qa.pick.searchPlaceholder')}
            clearAccessibilityLabel={t('qa.pick.clearSearch')}
          />
        </View>
      ) : null}

      {listState.kind === 'loading' ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : null}

      {listState.kind === 'surfing-off' ? (
        <Placard title={t('qa.pick.surfingOffTitle')} body={t('qa.pick.surfingOffBody')} />
      ) : null}

      {listState.kind === 'unreachable' ? (
        <Placard
          title={t('qa.pick.unreachableTitle')}
          body={branchesQuery.error instanceof Error ? branchesQuery.error.message : ''}
        />
      ) : null}

      {listState.kind === 'empty' ? <Placard title={t('qa.pick.emptyTitle')} body={t('qa.pick.emptyBody')} /> : null}

      {listState.kind === 'no-match' ? (
        <NoMatchState query={query} t={t}>
          {trySurfBlock}
        </NoMatchState>
      ) : null}

      <FlashList
        data={listState.kind === 'rows' ? listState.rows : NO_ROWS}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        // Rows can match a query while the PR it names is still missing — a title
        // saying "Follow up #5203" is not #5203 — so the offer belongs under the
        // results too, not only on an empty screen.
        ListFooterComponent={listState.kind === 'rows' ? trySurfBlock : null}
        contentContainerStyle={styles.listContent}
        // Without this the first tap on a row after typing is eaten by the keyboard
        // dismissal, and the tester has to tap twice to pick anything.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    </View>
  );
}

type NoMatchStateProps = {
  query: string;
  t: TFunction<'common'>;
  children?: ReactNode;
};

/**
 * Nothing matched what the tester typed — a different fact from "nothing is
 * published for this build", and it reads differently.
 */
function NoMatchState({ query, t, children }: NoMatchStateProps) {
  const { systemColors } = useTheme();

  return (
    <View style={styles.centered}>
      <Text variant="headline" style={styles.placardTitle}>
        {t('qa.pick.noMatchTitle')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.placardBody}>
        {t('qa.pick.noMatchBody', { query })}
      </Text>
      {children}
    </View>
  );
}

type TrySurfBlockProps = {
  prNumber: number;
  busy: boolean;
  onTrySurf: (prNumber: number) => void;
  t: TFunction<'common'>;
};

/**
 * The offer to load a PR this build was never handed a branch for.
 *
 * Rendered from two places — under an empty result, and under a list that matched
 * something else — because a query can turn up rows while the PR it actually names
 * is missing. A title-shaped query reaches neither: there is no branch name to guess
 * from a handful of words.
 */
function TrySurfBlock({ prNumber, busy, onTrySurf, t }: TrySurfBlockProps) {
  const { systemColors, brandColors } = useTheme();

  return (
    <View style={styles.trySurfWrap}>
      <PressableSurface
        onPress={() => onTrySurf(prNumber)}
        feedback="opacity"
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('qa.pick.trySurfAction', { prNumber })}
        style={[styles.trySurfButton, { borderColor: brandColors.primary }]}
      >
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text variant="subheadline" color={brandColors.primary}>
            {t('qa.pick.trySurfAction', { prNumber })}
          </Text>
        )}
      </PressableSurface>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.placardBody}>
        {t('qa.pick.trySurfHint')}
      </Text>
    </View>
  );
}

type PlacardProps = { title: string; body: string };

function Placard({ title, body }: PlacardProps) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.centered}>
      <Text variant="headline" style={styles.placardTitle}>
        {title}
      </Text>
      {body.length > 0 ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.placardBody}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

type QaPickRowItemProps = {
  row: QaPickRow;
  disabled: boolean;
  busy: boolean;
  onPress: (row: QaPickRow) => void;
  t: TFunction<'common'>;
};

// Memoized so scrolling the list doesn't re-render every row for one row's
// spinner (perf playbook rule 2). `t` is passed down from the screen rather
// than read via `useTranslation` here, so the list doesn't pay for a hook
// subscription per row.
const QaPickRowItem = memo(function QaPickRowItem({ row, disabled, busy, onPress, t }: QaPickRowItemProps) {
  const { systemColors, brandColors } = useTheme();
  // A separate context from `useTheme` on purpose — it only changes when the
  // user switches theme, so a row in a virtualized list is not re-rendered by
  // variant or spacing churn.
  const colorScheme = useAppColorScheme();
  const riskColor = riskColorFor(riskTone(row.risk), brandColors);
  const title = row.title ?? fallbackRowTitle(row.prNumber);

  return (
    <PressableSurface
      onPress={() => onPress(row)}
      feedback="opacity"
      // A building row stays pressable even though there is nothing to load:
      // `disabled` would kill onPress, and with it the toast that says why the
      // row is not going anywhere. Dimmed below, and `handlePick` refuses it.
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={`#${row.prNumber} ${title}`}
      // Says out loud what the dimming says visually, for a screen reader that
      // would otherwise hear an ordinary button.
      accessibilityHint={row.loadable ? undefined : t('qa.pick.buildingHint')}
      style={[
        styles.row,
        { backgroundColor: systemColors.elevatedSurface },
        // The busy row keeps full contrast — it is the one thing still
        // happening; everything it is blocking goes flat.
        (disabled && !busy) || !row.loadable ? styles.rowDimmed : null,
      ]}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {`#${row.prNumber}`}
          </Text>
          {row.risk !== null ? (
            <View style={[styles.riskChip, { backgroundColor: riskColor }]}>
              <Text variant="caption2" color={brandColors.onPrimary} style={styles.chipLabel}>
                {`${row.risk}/5`}
              </Text>
            </View>
          ) : null}
        </View>

        <Text variant="body" numberOfLines={2} style={styles.rowTitle}>
          {title}
        </Text>

        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
          {[row.author, formatRelativeTime(row.lastUpdateAt)].filter(Boolean).join(' · ')}
        </Text>

        <View style={styles.chipRow}>
          {row.isDraft ? <Chip label={t('qa.pick.draftChip')} /> : null}
          {row.myVerdict === 'approved' ? <Chip label={t('qa.pick.approvedChip')} tone={brandColors.success} /> : null}
          {row.myVerdict === 'declined' ? <Chip label={t('qa.pick.declinedChip')} tone={brandColors.error} /> : null}
          {row.verdictIsStale ? <Chip label={t('qa.pick.headChangedChip')} tone={brandColors.warning} /> : null}
          {row.refused ? <Chip label={t('qa.pick.crashedChip')} tone={brandColors.error} /> : null}
          {row.otaBuild === 'building' ? (
            <Chip
              label={row.loadable ? t('qa.pick.buildingNewerChip') : t('qa.pick.buildingChip')}
              tone={brandColors.warning}
            />
          ) : null}
          {visibleLabels(row.labels).map((label) => (
            <Chip key={label.name} label={label.name} tone={labelChipColor(label.color, colorScheme) ?? undefined} />
          ))}
        </View>
      </View>

      {busy ? <ActivityIndicator /> : null}
      {!busy && row.loadable ? <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} /> : null}
    </PressableSurface>
  );
});

type ChipProps = { label: string; tone?: string };

function Chip({ label, tone }: ChipProps) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.chip, { borderColor: tone ?? systemColors.separator }]}>
      <Text variant="caption2" color={tone ?? systemColors.secondaryLabel} style={styles.chipLabel}>
        {label}
      </Text>
    </View>
  );
}

function riskColorFor(tone: QaRiskTone, brandColors: { success: string; warning: string; error: string }): string {
  if (tone === 'low') return brandColors.success;
  if (tone === 'medium') return brandColors.warning;
  return brandColors.error;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[3],
  },
  headerTitle: {
    flex: 1,
    fontWeight: '700',
  },
  hint: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  searchWrap: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  trySurfWrap: {
    alignItems: 'center',
    paddingTop: spacing[4],
    gap: spacing[2],
  },
  trySurfButton: {
    marginTop: spacing[2],
    minHeight: 44,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
    gap: spacing[2],
  },
  placardTitle: {
    textAlign: 'center',
  },
  placardBody: {
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[8],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    marginBottom: spacing[2],
    borderRadius: borderRadius.lg,
  },
  rowDimmed: {
    opacity: 0.4,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  rowTitle: {
    fontWeight: '600',
  },
  riskChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  chip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: {
    fontWeight: '600',
  },
});
