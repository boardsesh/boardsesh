// The add-a-board wizard's step 1, "Where's the board?" (flag `add-board-wizard`):
// at a gym, at home, or a spray wall. Every + opens it; an entry that already
// knows the answer skips it (src/lib/boards/add-board-wizard.ts). The bar has an
// X and the title; the steps after it have a back chevron and no title.

import { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ChoiceCard } from '../../../src/components/board-discovery/FirstBoardChoice';
import { WizardStepHeader } from '../../../src/components/board-discovery/add-board-wizard/WizardStepHeader';
import { trackBoardKindChosen } from '../../../src/lib/boards/board-picker-add-analytics';
import { trackWizardStepViewed, wizardBoardHref, wizardGymHref } from '../../../src/lib/boards/add-board-wizard';
import { useAddBoardWizardStep } from '../../../src/lib/boards/use-add-board-wizard-step';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { spacing } from '../../../src/theme/tokens';

export default function AddBoardWhere() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const bottomChrome = useBottomChromeMetrics();
  const { entry, nextContext, markHandedOff, clearHandedOff } = useAddBoardWizardStep({
    step: 'where',
    path: null,
    abandonStep: 'choice',
    abandonKind: null,
  });
  // Back from the add-a-wall wizard: this screen is the climber's again.
  useFocusEffect(clearHandedOff);

  const onGym = useCallback(() => {
    trackBoardKindChosen({ kind: 'gym', surface: 'where', preAnswered: false });
    router.push(wizardGymHref(nextContext));
  }, [router, nextContext]);
  const onHome = useCallback(() => {
    trackBoardKindChosen({ kind: 'home', surface: 'where', preAnswered: false });
    router.push(wizardBoardHref(nextContext, 'home'));
  }, [router, nextContext]);
  // The add-a-wall wizard, unchanged: it counts its own steps and reports its
  // own funnel, so this screen stays quiet if the climber finishes there.
  const onSpray = useCallback(() => {
    trackBoardKindChosen({ kind: 'spray', surface: 'where', preAnswered: false });
    trackWizardStepViewed({ step: 'spray', path: 'spray', entry });
    markHandedOff();
    const params: Record<string, string> = {};
    if (nextContext.returnTo !== undefined) params.returnTo = nextContext.returnTo;
    if (nextContext.source !== undefined) params.source = nextContext.source;
    router.push({ pathname: '/boards/spray/new', params });
  }, [router, nextContext, entry, markHandedOff]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.flex}
      contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding }]}
      testID="add-board-where"
    >
      <WizardStepHeader stepLabel={null} title={t('mobile.addWizard.whereTitle')} />
      <View style={styles.cards}>
        <ChoiceCard icon="gym" title={t('mobile.addWizard.gym')} hint={t('mobile.addWizard.gymHint')} onPress={onGym} />
        <ChoiceCard
          icon="home"
          title={t('mobile.addWizard.home')}
          hint={t('mobile.addWizard.homeHint')}
          onPress={onHome}
        />
        <ChoiceCard
          icon="camera"
          title={t('mobile.addWizard.spray')}
          hint={t('mobile.addWizard.sprayHint')}
          onPress={onSpray}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingTop: spacing[4],
    gap: spacing[5],
  },
  cards: {
    gap: spacing[3],
  },
});
