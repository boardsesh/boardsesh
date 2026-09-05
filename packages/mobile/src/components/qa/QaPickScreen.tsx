import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useProfile } from '../../lib/graphql/hooks';
import { useTheme } from '../../providers/theme-provider';
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
  labelChipColor,
  riskTone,
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
  surfFailureReason,
} from '../../lib/qa/qa-analytics';

// Tester-only screen: every string is hardcoded English with `i18n-ignore`,
// matching Feature Flags and the branch switcher.

// i18n-ignore-next-line — tester-only screen
const SCREEN_TITLE = 'Test a PR';
// i18n-ignore-next-line
const SKIP_LABEL = 'Skip';
// i18n-ignore-next-line
const EMPTY_TITLE = 'Nothing to test right now';
// i18n-ignore-next-line
const EMPTY_BODY = 'No PR has published a preview for this build yet. Check back after the next push.';
// i18n-ignore-next-line
const SURFING_OFF_TITLE = 'Previews are switched off';
// i18n-ignore-next-line
const SURFING_OFF_BODY = 'This channel is not serving PR previews at the moment.';
// i18n-ignore-next-line
const UNREACHABLE_TITLE = 'Could not reach the update server';
// i18n-ignore-next-line
const DEV_HINT = 'Surfing is unavailable in a dev build — the list is read-only here.';
// i18n-ignore-next-line
const DRAFT_CHIP = 'Draft';
// i18n-ignore-next-line
const APPROVED_CHIP = 'You approved';
// i18n-ignore-next-line
const DECLINED_CHIP = 'You declined';
// i18n-ignore-next-line
const HEAD_CHANGED_CHIP = 'Head changed since';
// i18n-ignore-next-line
const CRASHED_CHIP = 'Crashed on launch';
// i18n-ignore-next-line
const BUILDING_CHIP = 'Building';
// i18n-ignore-next-line
const BUILDING_NEWER_CHIP = 'Building newer';
// i18n-ignore-next-line
const BUILDING_TOAST = 'Still publishing — it appears here when the bundle lands';

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
        showToast(BUILDING_TOAST, 'info');
        return;
      }
      surfInFlightRef.current = true;
      setSurfingPrNumber(row.prNumber);
      pickedRef.current = true;
      track(QA_PREVIEW_PICKED_EVENT, { prNumber: row.prNumber, risk: row.risk });
      void surfToPr(row.prNumber)
        .then((outcome) => {
          // 'reloading' never gets here in practice — the app restarts onto the
          // new bundle mid-promise.
          if (outcome === 'nothing-to-load') {
            surfInFlightRef.current = false;
            setSurfingPrNumber(null);
            showToast(
              // i18n-ignore-next-line
              `Nothing new for #${row.prNumber} on this build — its next publish applies on relaunch`,
              'info',
            );
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
          const message = error instanceof Error && error.message.length > 0 ? error.message : UNREACHABLE_TITLE;
          showToast(message, 'error');
        });
    },
    [showToast, surfingAvailable],
  );

  // Every row goes flat while a surf is in flight, not just the one that was
  // tapped: the app is on its way to another bundle and a second choice cannot
  // be honoured, so offering it would be a lie.
  const rowsDisabled = !surfingAvailable || surfingPrNumber !== null;

  const renderItem = useCallback(
    ({ item }: { item: QaPickRow }) => (
      <QaPickRowItem row={item} disabled={rowsDisabled} busy={surfingPrNumber === item.prNumber} onPress={handlePick} />
    ),
    [handlePick, rowsDisabled, surfingPrNumber],
  );

  const surfingDisabledForChannel = branchesQuery.isSuccess && branches === null;
  const listFailed = branchesQuery.isError;
  const listLoading = branchesQuery.isPending;

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text variant="title3" style={styles.headerTitle}>
          {SCREEN_TITLE}
        </Text>
        <PressableSurface
          onPress={() => router.back()}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={SKIP_LABEL}
        >
          <Text variant="subheadline" color={brandColors.primary}>
            {SKIP_LABEL}
          </Text>
        </PressableSurface>
      </View>

      {!surfingAvailable ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hint}>
          {DEV_HINT}
        </Text>
      ) : null}

      {listLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : null}

      {surfingDisabledForChannel ? <Placard title={SURFING_OFF_TITLE} body={SURFING_OFF_BODY} /> : null}

      {listFailed ? (
        <Placard
          title={UNREACHABLE_TITLE}
          body={branchesQuery.error instanceof Error ? branchesQuery.error.message : ''}
        />
      ) : null}

      {!listLoading && !listFailed && !surfingDisabledForChannel && rows.length === 0 ? (
        <Placard title={EMPTY_TITLE} body={EMPTY_BODY} />
      ) : null}

      <FlashList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
      />
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
};

// Memoized so scrolling the list doesn't re-render every row for one row's
// spinner (perf playbook rule 2).
const QaPickRowItem = memo(function QaPickRowItem({ row, disabled, busy, onPress }: QaPickRowItemProps) {
  const { systemColors, brandColors } = useTheme();
  const riskColor = riskColorFor(riskTone(row.risk), brandColors);
  const title = row.title ?? fallbackRowTitle(row.prNumber);

  return (
    <PressableSurface
      onPress={() => onPress(row)}
      feedback="opacity"
      disabled={disabled || busy || !row.loadable}
      accessibilityRole="button"
      accessibilityLabel={`#${row.prNumber} ${title}`}
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
          {row.isDraft ? <Chip label={DRAFT_CHIP} /> : null}
          {row.myVerdict === 'approved' ? <Chip label={APPROVED_CHIP} tone={brandColors.success} /> : null}
          {row.myVerdict === 'declined' ? <Chip label={DECLINED_CHIP} tone={brandColors.error} /> : null}
          {row.verdictIsStale ? <Chip label={HEAD_CHANGED_CHIP} tone={brandColors.warning} /> : null}
          {row.refused ? <Chip label={CRASHED_CHIP} tone={brandColors.error} /> : null}
          {row.otaBuild === 'building' ? (
            <Chip label={row.loadable ? BUILDING_NEWER_CHIP : BUILDING_CHIP} tone={brandColors.warning} />
          ) : null}
          {visibleLabels(row.labels).map((label) => (
            <Chip key={label.name} label={label.name} tone={labelChipColor(label.color) ?? undefined} />
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
