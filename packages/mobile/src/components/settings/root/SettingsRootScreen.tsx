import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useEffectiveBoardRenderSettings } from '../../../hooks/use-native-climb-render';
import { renderedBoardLookOption } from '../../../lib/board-render/board-look-options';
import { useBoardRenderSettings } from '../../../lib/board-render-settings';
import { hapticLight } from '../../../lib/haptics';
import { useQaMenu } from '../../../lib/qa/use-qa-menu';
import { useAuth } from '../../../providers/auth-provider';
import { gradeFormatOptions } from '../climbs/climbs-model';
import { useDeveloperSettingsAccess } from '../developer/use-developer-settings-access';
import { SETTINGS_ROOT_ROUTES } from './settings-pages';
import { buildSettingsRootModel } from './settings-root-model';
import { useSyncIssuesSection } from './use-sync-issues';

/**
 * The Settings root: a short list of pages. It owns the hooks that decide which
 * pages show and what value each row carries; everything a page holds lives on
 * that page.
 */
export function SettingsRootScreen() {
  const { t } = useTranslation('common');
  // Auth state, not the profile: an offline signed-in climber has no profile
  // document but must still be able to reach Sign out.
  const { isAuthenticated } = useAuth();
  const syncIssues = useSyncIssuesSection();
  const { gradeFormat } = useGradeFormat();
  const { settings: boardRenderSettings, loaded: boardRenderSettingsLoaded } = useBoardRenderSettings();
  const { allowed: showDeveloper } = useDeveloperSettingsAccess();
  const { show: showQaPreviews } = useQaMenu();

  // Whether this build can draw the Boardsesh look at all. Without it every
  // board renders Classic, so the value must say Classic, not the Aura look
  // picked but never shown.
  const { boardseshRendererAvailable } = useEffectiveBoardRenderSettings();

  // Only once the settings have loaded: before that the match is the default
  // look, which would flash the wrong name.
  const boardLookLabel = useMemo(() => {
    if (!boardRenderSettingsLoaded) return undefined;
    const option = renderedBoardLookOption(boardRenderSettings, boardseshRendererAvailable);
    return option ? t(option.labelI18nKey) : undefined;
  }, [boardRenderSettingsLoaded, boardRenderSettings, boardseshRendererAvailable, t]);

  const model = useMemo(
    () =>
      buildSettingsRootModel({
        t,
        syncIssues,
        visible: {
          account: isAuthenticated,
          earlyAccess: showQaPreviews,
          developer: showDeveloper,
        },
        values: {
          board: boardLookLabel,
          climbs: gradeFormatOptions(t).find((option) => option.key === gradeFormat)?.label,
        },
        onOpen: (page) => {
          hapticLight();
          router.push(SETTINGS_ROOT_ROUTES[page]);
        },
      }),
    [t, syncIssues, isAuthenticated, showQaPreviews, showDeveloper, boardLookLabel, gradeFormat],
  );

  return <MoreForm model={model} />;
}
