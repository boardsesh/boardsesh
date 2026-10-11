import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../providers/theme-provider';
import { climbRowPreviewLayout } from './climb-row-preview-layout';
import { MoreForm } from '../../MoreForm';
import { buildClimbListSettingsModel } from './climb-list-settings-model';
import { useClimbRowDisplayControls } from './use-climb-row-display-controls';
import { ClimbRowSettingsPreview } from './ClimbRowSettingsPreview';

export function ClimbListSettingsScreen() {
  const { t } = useTranslation('common');
  const { fontScale } = useWindowDimensions();
  const { textStyles } = useTheme();
  const previewLayout = useMemo(() => climbRowPreviewLayout(fontScale, textStyles), [fontScale, textStyles]);
  const { display, activePreset, hasLastCustom, setField, selectPreset } = useClimbRowDisplayControls();
  const preview = useMemo(
    () => (
      <ClimbRowSettingsPreview
        display={display}
        activePreset={activePreset}
        hasLastCustom={hasLastCustom}
        selectPreset={selectPreset}
        windowHeight={previewLayout.windowHeight}
      />
    ),
    [display, activePreset, hasLastCustom, selectPreset, previewLayout.windowHeight],
  );
  const model = useMemo(
    () =>
      buildClimbListSettingsModel({
        display,
        setField,
        t,
        preview,
        previewHeight: previewLayout.height,
      }),
    [display, setField, t, preview, previewLayout.height],
  );
  return <MoreForm model={model} />;
}
