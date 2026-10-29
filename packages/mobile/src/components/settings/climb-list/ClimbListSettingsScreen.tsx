import { useCallback, useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../providers/theme-provider';
import { climbRowPreviewLayout } from './climb-row-preview-layout';
import { MoreForm } from '../../MoreForm';
import { MoreFormRN } from '../../MoreForm.rn';
import { buildClimbListSettingsModel } from './climb-list-settings-model';
import { useClimbRowDisplayControls } from './use-climb-row-display-controls';
import { ClimbRowSettingsPreview } from './ClimbRowSettingsPreview';
import { useClimbListLayout, useClimbListTwoColumnsPossible } from '../../../hooks/use-climb-list-layout';
import { hapticSelection } from '../../../lib/haptics';
import type { ClimbListLayoutPreference } from '../../climb-list-thumbnail-metrics';

export function ClimbListSettingsScreen() {
  const { t } = useTranslation('common');
  const { fontScale } = useWindowDimensions();
  const { textStyles } = useTheme();
  const previewLayout = useMemo(() => climbRowPreviewLayout(fontScale, textStyles), [fontScale, textStyles]);
  const { display, activePreset, hasLastCustom, setField, selectPreset } = useClimbRowDisplayControls();
  const [listLayout, setListLayout] = useClimbListLayout();
  const twoColumnsPossible = useClimbListTwoColumnsPossible();
  const handleLayoutChange = useCallback(
    (value: ClimbListLayoutPreference) => {
      hapticSelection();
      setListLayout(value);
    },
    [setListLayout],
  );
  const layout = useMemo(
    () => (twoColumnsPossible ? { value: listLayout, onChange: handleLayoutChange } : null),
    [twoColumnsPossible, listLayout, handleLayoutChange],
  );
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
        layout,
      }),
    [display, setField, t, preview, previewLayout.height, layout],
  );
  return Platform.OS === 'android' ? <MoreFormRN model={model} /> : <MoreForm model={model} />;
}
