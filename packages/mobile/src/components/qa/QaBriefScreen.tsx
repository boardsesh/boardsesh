import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Text } from '../Text';
import { useUserDrawer } from '../user-drawer/UserDrawerProvider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { openExternalUrl } from '../../lib/open-url';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { qaSurfingAvailable, readRunningPrNumber, surfToProduction } from '../../lib/qa/qa-surf';
import { riskTone, type QaRiskTone } from '../../lib/qa/qa-pick-rows';
import { useQaPreviews } from '../../lib/qa/use-qa-previews';
import { QA_PREVIEW_LEFT_EVENT, QA_SURF_FAILED_EVENT, surfFailureReason } from '../../lib/qa/qa-analytics';

// Tester-only screen: hardcoded English with `i18n-ignore`, like Feature Flags.

// i18n-ignore-next-line — tester-only screen
const SCREEN_TITLE = 'What to test';
// i18n-ignore-next-line
const START_LABEL = 'Start testing';
// i18n-ignore-next-line
const FINISH_LABEL = 'Finish testing';
// i18n-ignore-next-line
const GITHUB_LABEL = 'Open on GitHub';
// i18n-ignore-next-line
const LEAVE_LABEL = 'Leave preview';
// i18n-ignore-next-line
const NO_PLAN_TEXT = 'No test plan on this PR yet — open it on GitHub and use your judgement.';
// i18n-ignore-next-line
const UNKNOWN_PR_BODY = 'is closed or unknown. Nothing here to test.';
// i18n-ignore-next-line
const ON_PRODUCTION_TITLE = "You're on production";
// i18n-ignore-next-line
const ON_PRODUCTION_BODY = 'Pick a PR preview to start testing one.';
// i18n-ignore-next-line
const PICK_LABEL = 'Test a PR preview';
// i18n-ignore-next-line
const DEV_HINT = 'Surfing is unavailable in a dev build — Leave preview is disabled here.';
// i18n-ignore-next-line
const BACK_ON_PRODUCTION_TOAST = 'Back on production at the next update';
// The thrown message goes to Sentry and to the event's `reason`; the tester gets
// the one sentence that tells them what to do. (Before this, an empty-message
// Error surfaced as an empty toast and a non-Error surfaced the button label.)
// i18n-ignore-next-line
const LEAVE_FAILED_TOAST = 'Could not switch off this preview — try again';

/**
 * What this preview is and what to try — shown once per surfed bundle by
 * `QaTesterGate`, and reachable any time from the user drawer.
 *
 * The PR body's `## Test plan` is the whole point of the screen, but it must
 * degrade: a PR with no plan, or a backend that can't reach GitHub, still leaves
 * the tester with the PR number, a way to open it, and a way back to production.
 */
export function QaBriefScreen() {
  const insets = useSafeAreaInsets();
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { presentQaVerdict } = useUserDrawer();

  // Read once per mount: the running bundle cannot change without a reload.
  const runningPrNumber = useMemo(() => readRunningPrNumber(), []);
  const prNumbers = useMemo(() => (runningPrNumber === null ? [] : [runningPrNumber]), [runningPrNumber]);
  const previewsQuery = useQaPreviews(prNumbers);
  const preview = previewsQuery.data?.find((entry) => entry.prNumber === runningPrNumber) ?? null;

  const [leaving, setLeaving] = useState(false);
  const surfingAvailable = qaSurfingAvailable();

  // Same sequencing as the user-drawer route: the verdict sheet is mounted at
  // the drawer provider's root and presents off the root view controller, so it
  // can only be presented once THIS modal route's own controller is gone.
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      const after = pendingAfterCloseRef.current;
      pendingAfterCloseRef.current = null;
      if (after) requestAnimationFrame(after);
    },
    [],
  );

  const handleFinishTesting = useCallback(() => {
    pendingAfterCloseRef.current = () => presentQaVerdict();
    router.back();
  }, [presentQaVerdict]);

  const handleLeavePreview = useCallback(() => {
    if (!surfingAvailable || leaving) return;
    setLeaving(true);
    track(QA_PREVIEW_LEFT_EVENT, { prNumber: runningPrNumber });
    void surfToProduction()
      .then((outcome) => {
        setLeaving(false);
        // Production is not *newer* than a fresh pr-N bundle, so the running JS
        // usually stays until production publishes again. The pin is gone either
        // way, which is what actually matters.
        if (outcome === 'nothing-to-load') showToast(BACK_ON_PRODUCTION_TOAST, 'info');
      })
      .catch((error: unknown) => {
        setLeaving(false);
        reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-production' } });
        track(QA_SURF_FAILED_EVENT, { prNumber: null, reason: surfFailureReason(error) });
        showToast(LEAVE_FAILED_TOAST, 'error');
      });
  }, [leaving, runningPrNumber, showToast, surfingAvailable]);

  const containerStyle = [styles.root, { backgroundColor: systemColors.groupedBackground, paddingTop: insets.top }];

  if (runningPrNumber === null) {
    return (
      <View style={containerStyle}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text variant="title3" style={styles.title}>
            {ON_PRODUCTION_TITLE}
          </Text>
          <Text variant="body" color={systemColors.secondaryLabel}>
            {ON_PRODUCTION_BODY}
          </Text>
          <Button title={PICK_LABEL} onPress={() => router.replace('/qa/pick')} variant="filled" size="large" />
          {/* i18n-ignore-next-line */}
          <Button title="Close" onPress={() => router.back()} variant="text" size="large" />
        </ScrollView>
      </View>
    );
  }

  const showLoading = previewsQuery.isPending;
  const planSteps = preview?.testPlanSteps ?? [];
  const rawPlan = preview?.testPlan ?? null;

  return (
    <View style={containerStyle}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {`${SCREEN_TITLE} · #${runningPrNumber}`}
        </Text>

        {showLoading ? <ActivityIndicator /> : null}

        <Text variant="title3" style={styles.title}>
          {preview?.title ?? `pr-${runningPrNumber}`}
        </Text>

        {preview === null && !showLoading ? (
          <Text variant="body" color={systemColors.secondaryLabel}>
            {`PR #${runningPrNumber} ${UNKNOWN_PR_BODY}`}
          </Text>
        ) : null}

        {preview !== null ? (
          <View style={styles.metaRow}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {preview.author}
            </Text>
            {preview.risk !== null ? (
              <View style={[styles.riskChip, { backgroundColor: riskColorFor(riskTone(preview.risk), brandColors) }]}>
                <Text variant="caption2" color={brandColors.onPrimary} style={styles.chipLabel}>
                  {`Risk ${preview.risk}/5`}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {preview?.riskReason ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {preview.riskReason}
          </Text>
        ) : null}

        {planSteps.length > 0 ? (
          <View style={[styles.planCard, { backgroundColor: systemColors.elevatedSurface }]}>
            {/* Keyed on the position, not the text: a test plan may legitimately
                repeat a step ("Relaunch the app"), and duplicate keys drop the
                second copy from the render. */}
            {planSteps.map((step, index) => (
              <View key={`${String(index)}-${step}`} style={styles.planRow}>
                <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.planNumber}>
                  {`${index + 1}.`}
                </Text>
                <Text variant="subheadline" style={styles.planStep}>
                  {step}
                </Text>
              </View>
            ))}
          </View>
        ) : rawPlan !== null ? (
          <View style={[styles.planCard, { backgroundColor: systemColors.elevatedSurface }]}>
            <Text variant="subheadline">{rawPlan}</Text>
          </View>
        ) : !showLoading ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {NO_PLAN_TEXT}
          </Text>
        ) : null}

        {!surfingAvailable ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {DEV_HINT}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button title={START_LABEL} onPress={() => router.back()} variant="filled" size="large" />
          <Button title={FINISH_LABEL} onPress={handleFinishTesting} variant="tonal" size="large" />
          {preview?.url ? (
            <Button
              title={GITHUB_LABEL}
              onPress={() => void openExternalUrl(preview.url, 'qa-brief')}
              variant="outlined"
              size="large"
              icon="open.external"
            />
          ) : null}
          <Button
            title={LEAVE_LABEL}
            onPress={handleLeavePreview}
            variant="text"
            size="large"
            disabled={!surfingAvailable}
            loading={leaving}
          />
        </View>
      </ScrollView>
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
  content: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
    gap: spacing[3],
  },
  title: {
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  riskChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  chipLabel: {
    fontWeight: '600',
  },
  planCard: {
    borderRadius: borderRadius.lg,
    padding: spacing[3],
    gap: spacing[2],
  },
  planRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  planNumber: {
    minWidth: 20,
  },
  planStep: {
    flex: 1,
  },
  actions: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
});
