import { useEffect, useRef, useState } from 'react';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { BOARD_LOOK_STEP_SEEN_KEY } from '@boardsesh/key-value-storage';
import { hasSeenTip } from '../../lib/onboarding/onboarding-storage';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { useBoardPreviewClimb } from '../../hooks/use-board-preview-climb';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';
import { getBoardseshRendererSupport, subscribeToBoardseshSupport } from '../../hooks/boardsesh-renderer-support';
import { decideBoardLookStep } from '../../lib/board-render/board-look-step-decision';

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
 */
export function BoardLookStepGate({ ready, tourDecided }: { ready: boolean; tourDecided: boolean }) {
  const segments = useSegments();
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];

  const { settings, loaded: settingsLoaded } = useBoardRenderSettings();
  const [armed, setArmed] = useState(false);
  const [stepSeen, setStepSeen] = useState<boolean | undefined>(undefined);
  const [launchedByDeepLink, setLaunchedByDeepLink] = useState<boolean | undefined>(undefined);
  const pushedRef = useRef(false);

  // The example climb and the capability probe are the two expensive inputs, so
  // neither is paid for until the cheap checks have passed.
  const { status: previewStatus } = useBoardPreviewClimb(armed);
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
      const [seen, initialUrl] = await Promise.all([
        hasSeenTip(BOARD_LOOK_STEP_SEEN_KEY),
        Linking.getInitialURL().catch(() => null),
      ]);
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
    if (!armed) return;
    ensureBoardseshSupportProbed();
    setRendererAvailable(getBoardseshRendererSupport());
    return subscribeToBoardseshSupport(() => {
      setRendererAvailable(getBoardseshRendererSupport());
    });
  }, [armed]);

  const decision = decideBoardLookStep({
    ready: ready && tourDecided,
    screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
    settingsLoaded,
    storedMode: settings.mode,
    stepSeen,
    launchedByDeepLink: launchedByDeepLink ?? false,
    topSegment: topSegmentRef.current,
    boardseshRendererAvailable: rendererAvailable,
    previewStatus,
  });

  useEffect(() => {
    // `launchedByDeepLink === undefined` means that read is still in flight; the
    // decision above substitutes `false` for it, which could show the step over
    // a deep-link landing, so hold until it has actually answered.
    if (!armed || pushedRef.current || launchedByDeepLink === undefined) return;
    if (decision !== 'show') return;
    pushedRef.current = true;
    router.push({ pathname: '/onboarding', params: { step: 'board-look' } });
  }, [armed, decision, launchedByDeepLink]);

  return null;
}
