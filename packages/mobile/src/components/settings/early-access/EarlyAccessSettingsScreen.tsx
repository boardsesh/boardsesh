import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useProfile } from '../../../lib/graphql/hooks';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { useQaMenu } from '../../../lib/qa/use-qa-menu';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useSetting } from '../../../settings';
import { buildEarlyAccessModel } from './early-access-model';

export function EarlyAccessSettingsScreen() {
  const { t } = useTranslation('common');
  const { data: profile } = useProfile();
  // PR previews (docs/crowdsourced-qa-mobile.md). Open to every climber; `show`
  // is the binary's ability to surf, so a build that cannot load a preview
  // still hides it.
  const { show: showQaPreviews, prNumber: qaPrNumber } = useQaMenu();
  const [qaPromptOnLaunch, setQaPromptOnLaunch] = useSetting('qaPromptOnLaunch');
  const isTester = Boolean(profile?.isTester);

  const model = useMemo(
    () =>
      withSettingTracking(
        buildEarlyAccessModel({
          t,
          previews: showQaPreviews
            ? {
                prNumber: qaPrNumber,
                onOpenTestPlan: () => {
                  hapticLight();
                  router.push('/qa/brief');
                },
                onOpenPicker: () => {
                  hapticLight();
                  router.push('/qa/pick');
                },
                promptOnLaunch: isTester
                  ? {
                      enabled: qaPromptOnLaunch,
                      onChange: (enabled) => {
                        hapticSelection();
                        setQaPromptOnLaunch(enabled);
                      },
                    }
                  : null,
              }
            : null,
        }),
        'early-access',
      ),
    [t, showQaPreviews, qaPrNumber, isTester, qaPromptOnLaunch, setQaPromptOnLaunch],
  );

  return <MoreForm model={model} />;
}
