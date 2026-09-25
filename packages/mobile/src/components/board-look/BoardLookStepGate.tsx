import { useEffect, useRef, useState } from 'react';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { hasSeenBoardLookStep } from '../../lib/board-render/board-look-step-seen';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { useBoardPreviewClimb } from '../../hooks/use-board-preview-climb';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';
import { getBoardseshRendererSupport, subscribeToBoardseshSupport } from '../../hooks/boardsesh-renderer-support';
import {
  decideBoardLookStep,
  explainBoardLookStep,
  isSettledBoardLookReason,
} from '../../lib/board-render/board-look-step-decision';
import { reportBoardLookStepEvaluationOnce } from '../../lib/board-render/board-look-step-evaluation-log';

/**
 * The launch-time gate for the one-time "pick your board look" step, rendered by
 * `OnboardingGate` as its second, lower-priority branch.
 *
 * Its own module rather than more code inside that gate for two reasons: the
 * hooks it needs (the example-climb query, the renderer capability latch) pull
 * in the native render graph, which the first-run tour has no business
 * importing; and `tourDecided` is a single prop, which keeps the ordering
 * between the two surfaces explicit instead of implied.
 *
 * Two passes, mirroring `QaTesterGate`. The first uses optimistic stand-ins for
 * the values only readable asynchronously, purely to rule the climber out
 * cheaply; only if that survives does it arm the query and the probe and decide
 * for real. The decision itself is `decideBoardLookStep`, a pure function, so
 * the policy is testable without a renderer.
 *
 * **`present={false}` evaluates and logs, and never pushes (#5654).** This gate
 * never ran from 2.2.0 until #5654 (its `ready` input was frozen behind the
 * database provider), and nobody has decided yet whether the step should reach
 * the climbers it would now wake up for. So `OnboardingGate` mounts it in
 * log-only mode: the cheap reads still run, the example-climb query and the
 * renderer probe do not (there is nothing to preview for), and the verdict goes
 * out once per device as `Board Look Step Evaluated`. `present` restores the
 * full two-pass behaviour below.
 */
export function BoardLookStepGate({
  ready,
  tourDecided,
  present,
}: {
  ready: boolean;
  tourDecided: boolean;
  present: boolean;
}) {
  const segments = useSegments();
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];

  const { settings, loaded: settingsLoaded } = useBoardRenderSettings();
  const [armed, setArmed] = useState(false);
  const [stepSeen, setStepSeen] = useState<boolean | undefined>(undefined);
  const [launchedByDeepLink, setLaunchedByDeepLink] = useState<boolean | undefined>(undefined);
  const pushedRef = useRef(false);
  const reportedRef = useRef(false);
  const lastLoggedRef = useRef<string>('');

  // The example climb and the capability probe are the two expensive inputs, so
  // neither is paid for until the cheap checks have passed, and never at all
  // when the step is only being evaluated.
  const expensiveInputsArmed = armed && present;
  const { status: previewStatus } = useBoardPreviewClimb(expensiveInputsArmed);
  const [rendererAvailable, setRendererAvailable] = useState<boolean | null>(() => getBoardseshRendererSupport());

  const preflight = decideBoardLookStep({
    ready: ready && tourDecided,
    screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
    settingsLoaded,
    storedMode: settings.mode,
    // Optimistic stand-ins: a `show` here only means "not ruled out yet".
    stepSeen: false,
    launchedByDeepLink: false,
    topSegment: topSegmentRef.current,
    boardseshRendererAvailable: true,
    previewStatus: 'ready',
  });

  // Arming and reading are separate effects on purpose. Doing both in one —
  // `setArmed(true)` followed by the async reads, keyed on `[preflight, armed]`
  // — makes the state change re-run the very effect that started them, and the
  // cleanup then cancels the reads before they can land. The step would arm and
  // then never decide.
  useEffect(() => {
    if (preflight !== 'show') return;
    setArmed(true);
  }, [preflight]);

  useEffect(() => {
    if (!armed) return;

    let cancelled = false;
    void (async () => {
      const [seen, initialUrl] = await Promise.all([hasSeenBoardLookStep(), Linking.getInitialURL().catch(() => null)]);
      if (cancelled) return;
      setStepSeen(seen);
      setLaunchedByDeepLink(initialUrl !== null);
    })();

    return () => {
      cancelled = true;
    };
  }, [armed]);

  // The probe answers from inside a promise, so subscribing is what lets the
  // gate pick the answer up. Forced here rather than waited on: the render path
  // only probes once something asks for the Boardsesh drawing, and this step is
  // the thing that asks.
  useEffect(() => {
    if (!expensiveInputsArmed) return;
    ensureBoardseshSupportProbed();
    setRendererAvailable(getBoardseshRendererSupport());
    return subscribeToBoardseshSupport(() => {
      setRendererAvailable(getBoardseshRendererSupport());
    });
  }, [expensiveInputsArmed]);

  const verdict = explainBoardLookStep({
    ready: ready && tourDecided,
    screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
    settingsLoaded,
    storedMode: settings.mode,
    stepSeen,
    launchedByDeepLink: launchedByDeepLink ?? false,
    topSegment: topSegmentRef.current,
    // Log-only mode never reads the two expensive inputs, so it stands in the
    // same optimistic values the preflight uses: "would present" then means
    // "every cheap check passed".
    boardseshRendererAvailable: present ? rendererAvailable : true,
    previewStatus: present ? previewStatus : 'ready',
  });
  const decision = verdict.decision;

  // Dev-only: why the step did or didn't fire. The gate reads device-wide state
  // that is invisible from the UI (the stored mode, the seen flag, the renderer
  // probe), so without this "it just doesn't show up" is unfalsifiable. Strips
  // in release builds.
  if (__DEV__) {
    const inputs = JSON.stringify({
      decision,
      preflight,
      armed,
      present,
      ready,
      tourDecided,
      settingsLoaded,
      storedMode: settings.mode,
      stepSeen,
      launchedByDeepLink,
      topSegment: topSegmentRef.current,
      rendererAvailable,
      previewStatus,
    });
    if (inputs !== lastLoggedRef.current) {
      lastLoggedRef.current = inputs;
      // eslint-disable-next-line no-console
      console.warn(`[board-look-gate] ${inputs}`);
    }
  }

  useEffect(() => {
    // `launchedByDeepLink === undefined` means that read is still in flight; the
    // decision above substitutes `false` for it, which could show the step over
    // a deep-link landing, so hold until it has actually answered.
    if (!present || !armed || pushedRef.current || launchedByDeepLink === undefined) return;
    if (decision !== 'show') return;
    pushedRef.current = true;
    router.push({ pathname: '/onboarding', params: { step: 'board-look' } });
  }, [present, armed, decision, launchedByDeepLink]);

  // Log-only mode: report the first verdict that describes the climber rather
  // than this launch. A verdict reached without arming (a look already chosen)
  // is final at once; an armed one waits for the reads like the push does.
  const reason = verdict.reason;
  useEffect(() => {
    if (present || reportedRef.current) return;
    if (armed && launchedByDeepLink === undefined) return;
    if (!isSettledBoardLookReason(reason)) return;
    reportedRef.current = true;
    void reportBoardLookStepEvaluationOnce(reason);
  }, [present, armed, launchedByDeepLink, reason]);

  return null;
}
