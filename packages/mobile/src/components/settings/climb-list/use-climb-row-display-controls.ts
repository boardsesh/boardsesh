import { useCallback } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { hapticSelection } from '../../../lib/haptics';
import { matchClimbRowPreset, type ClimbRowFieldId, type ClimbRowPresetId } from '../../../lib/climb-row-display';
import {
  applyClimbRowPreset,
  restoreLastCustomClimbRow,
  setClimbRowField,
  useClimbRowDisplay,
  useClimbRowHasLastCustom,
} from '../../../lib/climb-row-display-preference';

/** The only interaction writer: rows and previews never emit preference analytics. */
export function useClimbRowDisplayControls() {
  const display = useClimbRowDisplay();
  const hasLastCustom = useClimbRowHasLastCustom();
  const activePreset = matchClimbRowPreset(display);
  const setField = useCallback((field: ClimbRowFieldId, value: boolean) => {
    hapticSelection();
    setClimbRowField(field, value);
    track(SHARED_EVENTS.ClimbRowDisplayChanged, { kind: 'field', field, value });
  }, []);
  const selectPreset = useCallback((preset: ClimbRowPresetId | 'custom') => {
    hapticSelection();
    if (preset === 'custom') restoreLastCustomClimbRow();
    else applyClimbRowPreset(preset);
    track(SHARED_EVENTS.ClimbRowDisplayChanged, { kind: 'preset', preset });
  }, []);
  return { display, activePreset, hasLastCustom, setField, selectPreset };
}
