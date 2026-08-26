import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
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
  riskTone,
  type QaPickRow,
  type QaRiskTone,
} from '../../lib/qa/qa-pick-rows';
import { useQaPreviews } from '../../lib/qa/use-qa-previews';
import { QA_PREVIEW_PICKED_EVENT, QA_PREVIEW_SKIPPED_EVENT, QA_SURF_FAILED_EVENT } from '../../lib/qa/qa-analytics';

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
  const params = useLocalSearchParams<{ prNumbers?: string }>();
  const { data: profile, isLoading: profileLoading } = useProfile();

  // Seed from the gate's already-paid-for listing so the metadata request starts
  // on the first render instead of waiting for a second round-trip.
  const seedPrNumbers = useMemo(() => parsePrNumberList(params.prNumbers), [params.prNumbers]);

  const branchesQuery = useQuery({
    queryKey: ['qaPrBranches'],
    queryFn: () => listPrBranches(),
    staleTime: 30_000,
    retry: 1,
  });
  const branches = branchesQuery.data ?? null;

  const prNumbers = branches === null ? seedPrNumbers : branches.map((entry) => entry.prNumber);
  const previewsQuery = useQaPreviews(prNumbers);

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
  useEffect(
    () => () => {
      if (!pickedRef.current) track(QA_PREVIEW_SKIPPED_EVENT, {});
    },
    [],
  );

  const surfingAvailable = qaSurfingAvailable();

  const handlePick = useCallback(
    (row: QaPickRow) => {
      if (!surfingAvailable) return;
      setSurfingPrNumber(row.prNumber);
      pickedRef.current = true;
      track(QA_PREVIEW_PICKED_EVENT, { prNumber: row.prNumber, risk: row.risk });
      void surfToPr(row.prNumber)
        .then((outcome) => {
          // 'reloading' never gets here in practice — the app restarts onto the
          // new bundle mid-promise.
          if (outcome === 'nothing-to-load') {
            setSurfingPrNumber(null);
            showToast(
              // i18n-ignore-next-line
              `Nothing new for #${row.prNumber} on this build — its next publish applies on relaunch`,
              'info',
            );
          }
        })
        .catch((error: unknown) => {
          setSurfingPrNumber(null);
          pickedRef.current = false;
          reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-pr' } });
          track(QA_SURF_FAILED_EVENT, { prNumber: row.prNumber });
          showToast(error instanceof Error ? error.message : UNREACHABLE_TITLE, 'error');
        });
    },
    [showToast, surfingAvailable],
  );

  const renderItem = useCallback(
    ({ item }: { item: QaPickRow }) => (
      <QaPickRowItem
        row={item}
        disabled={!surfingAvailable}
        busy={surfingPrNumber === item.prNumber}
        onPress={handlePick}
      />
    ),
    [handlePick, surfingAvailable, surfingPrNumber],
  );

  // Route guard: hiding the drawer row is not a guard, since the route is
  // reachable directly. __DEV__ always passes (the profile may not resolve in a
  // dev build), otherwise wait for the profile and keep non-testers out.
  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
          <ActivityIndicator />
        </View>
      );
    }
    if (!profile?.isTester) {
      return <Redirect href="/(tabs)/profile/more" />;
    }
  }

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
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={`#${row.prNumber} ${title}`}
      style={[styles.row, { backgroundColor: systemColors.elevatedSurface }]}
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
        </View>
      </View>

      {busy ? <ActivityIndicator /> : <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />}
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
