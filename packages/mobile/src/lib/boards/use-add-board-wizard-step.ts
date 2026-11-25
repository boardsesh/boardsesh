// What every add-a-board wizard screen reads from its route and reports: the
// entry and trail it was handed, "Step N of M", `Add Board Wizard Step
// Viewed` on mount, and `Board Builder Abandoned` when the climber leaves the
// flow from it (one per flow, board-create-flow.ts; Back to the step under it
// is not leaving, use-stepped-back-in-wizard.ts). A step that opened as the
// stack's first screen (a gym page pushes Boards at {gym} into a fresh boards
// modal) has no back chevron, so it gets an X.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { useHeaderActions } from '../../hooks/use-header-actions';
import { boardFlowTicket, builderOpenedFrom, claimBoardFlowAbandonment } from './board-create-flow';
import { useSteppedBackInWizard } from './use-stepped-back-in-wizard';
import {
  parseWizardEntry,
  parseWizardTrail,
  trackWizardStepViewed,
  wizardStepPosition,
  type AddBoardWizardEntry,
  type AddBoardWizardPath,
  type AddBoardWizardStep,
  type WizardRouteContext,
} from './add-board-wizard';

/** `Board Builder Abandoned`'s `step` for a wizard screen. */
export type WizardAbandonStep = 'choice' | 'find' | 'board';

export type AddBoardWizardStepState = {
  entry: AddBoardWizardEntry;
  /** The steps before this one, plus this one: what the next screen is handed. */
  nextContext: WizardRouteContext;
  /** "Step 2 of 4", translated, or null when this screen isn't counted. */
  stepLabel: string | null;
  /**
   * The climber left the wizard from here for a flow that reports itself (the
   * add-a-wall wizard): this screen's unmount stays quiet until it is shown
   * again.
   */
  markHandedOff: () => void;
  /** This screen is in front again (Back from the hand-off): it may report again. */
  clearHandedOff: () => void;
};

type WizardRouteParams = { entry?: string; trail?: string; returnTo?: string; source?: string };

export function useAddBoardWizardStep({
  step,
  path,
  abandonStep,
  abandonKind,
  boardTypeKnown = false,
}: {
  step: AddBoardWizardStep;
  /** The branch this screen is on, or null for step 1. */
  path: AddBoardWizardPath | null;
  abandonStep: WizardAbandonStep;
  /** `Board Builder Abandoned`'s `kind`: home, gym, or null before it is answered. */
  abandonKind: 'home' | 'gym' | null;
  /** The board type is already chosen, so Which board? is skipped (Add your gym counts on it). */
  boardTypeKnown?: boolean;
}): AddBoardWizardStepState {
  const params = useLocalSearchParams<WizardRouteParams>();
  const { t } = useTranslation('boards');
  const entry = parseWizardEntry(params.entry);
  const trailParam = params.trail;
  const trail = useMemo(() => parseWizardTrail(trailParam), [trailParam]);
  const position = wizardStepPosition(step, trail, { boardTypeKnown });
  const stepLabel = position ? t('mobile.addWizard.stepCounter', position) : null;
  const { returnTo, source } = params;
  const nextContext = useMemo<WizardRouteContext>(
    () => ({ returnTo, source, entry, trail: [...trail, step] }),
    [returnTo, source, entry, trail, step],
  );

  // The first screen of its stack (a gym page's entry) has no chevron: an X,
  // which closes the modal. Step 1 has its own X from the layout.
  const router = useRouter();
  const navigation = useNavigation();
  const [isStackRoot] = useState(() => (navigation.getState()?.index ?? 0) === 0);
  useHeaderActions({
    leading: isStackRoot && step !== 'where' ? { kind: 'close', onPress: () => router.back() } : null,
  });

  const reportUnlessSteppedBack = useSteppedBackInWizard();
  const handedOffRef = useRef(false);
  const markHandedOff = useCallback(() => {
    handedOffRef.current = true;
  }, []);
  const clearHandedOff = useCallback(() => {
    handedOffRef.current = false;
  }, []);

  useEffect(() => {
    trackWizardStepViewed({ step, path, entry });
    const openedAtMs = Date.now();
    const ticket = boardFlowTicket();
    return () => {
      // Off to the add-a-wall wizard, or (checked a tick later) back to the
      // step under this one: the climber hasn't left yet.
      if (handedOffRef.current) return;
      const secondsOpen = Math.round((Date.now() - openedAtMs) / 1000);
      reportUnlessSteppedBack(() => {
        if (!claimBoardFlowAbandonment(ticket)) return;
        track(SHARED_EVENTS.BoardBuilderAbandoned, {
          kind: abandonKind,
          step: abandonStep,
          openedFrom: builderOpenedFrom(source),
          wizardEntry: entry,
          wizardPath: path,
          secondsOpen,
        });
      });
    };
    // Once per screen: the route's params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { entry, nextContext, stepLabel, markHandedOff, clearHandedOff };
}
