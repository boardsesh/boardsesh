import { useCallback, useMemo, useRef } from 'react';
import { useEffectiveBoardRenderSettings } from '../../hooks/use-native-climb-render';
import { useBoardPreviewClimb } from '../../hooks/use-board-preview-climb';
import {
  requestedBoardRenderMode,
  resolveEffectiveRenderSettings,
  setBoardRenderSettingsPreference,
  useBoardRenderSettings,
  type BoardRenderModeSetting,
  type BoardRenderSettings,
  type BoardseshRenderSettings,
} from '../board-render-settings';
import { mergePresetPreservingAccessibility } from '../board-render-presets';
import {
  BOARD_LOOK_SETTINGS_OPTIONS,
  applyBoardLookOption,
  matchingBoardLookOptionId,
  type BoardLookOptionId,
} from './board-look-options';
import { clearCustomBoardLook, loadCustomBoardLook, rememberCustomBoardLook } from './custom-board-look';
import {
  trackBoardLookApplied,
  trackBoardRenderSettingChanged,
  type BoardRenderSettingField,
} from './board-look-analytics';

/**
 * Everything the three Board look screens share, in one place — because the
 * thing they share is a WRITER, and the bug this hook exists to prevent is
 * having two of them.
 *
 * Board look used to be one screen, so the mirroring writer (every knob change
 * also remembered as the climber's custom look) could live in the screen and be
 * passed down. It was passed down inconsistently: the role-glyphs toggle got the
 * raw setter instead, so toggling it never reached the remembered bundle — tune a
 * look, toggle glyphs, try a preset, come back, and the glyph state was gone.
 *
 * Splitting one screen into three would have turned that into three chances to
 * get it wrong, so instead there is exactly one `setBoardseshField` in the app
 * and no raw setter to pass by mistake.
 */
export type BoardLookSettings = {
  settings: BoardRenderSettings;
  loaded: boolean;
  effectiveRenderSettings: ReturnType<typeof useEffectiveBoardRenderSettings>['effectiveRenderSettings'];
  /** `null` = the capability probe has not answered; `false` = this build cannot draw Boardsesh. */
  boardseshRendererAvailable: boolean | null;
  requestedMode: 'classic' | 'aura';
  /** Which look the settings actually sit on. Drives the carousel and both nav-row subtitles. */
  matchingOptionId: BoardLookOptionId;
  setMode: (mode: BoardRenderModeSetting) => void;
  /** The one mirroring writer. Every knob on every Board look screen goes through this. */
  setBoardseshField: <F extends keyof BoardseshRenderSettings>(field: F, value: BoardseshRenderSettings[F]) => void;
  applyPreset: (id: BoardLookOptionId) => void;
  restoreCustomLook: () => Promise<void>;
  /** Render settings and the remembered look only — never the hold-colour overrides. */
  resetBoardLook: () => void;
};

export function useBoardLookSettings(): BoardLookSettings {
  const {
    settings,
    loaded,
    setMode: rawSetMode,
    setBoardseshField: rawSetBoardseshField,
    reset,
  } = useBoardRenderSettings();
  const { effectiveRenderSettings, boardseshRendererAvailable } = useEffectiveBoardRenderSettings();
  const { preview } = useBoardPreviewClimb();

  // The live bundle, for the one caller that reads it AFTER an await. Everything
  // else here resolves settings synchronously; `restoreCustomLook` cannot, so it
  // reads through this rather than through a closure captured a render ago.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const requestedMode = requestedBoardRenderMode(settings);
  const matchingOptionId = matchingBoardLookOptionId(settings);

  const analyticsContext = useMemo(
    () => (preview ? { boardName: preview.boardName, layoutId: preview.layoutId, sizeId: preview.sizeId } : null),
    [preview],
  );

  // Held in a ref for the same reason the settings are: the trackers below run
  // inside stable callbacks and must report against the CURRENT board, not the
  // one mounted when the callback was built.
  const rendererAvailableRef = useRef(boardseshRendererAvailable);
  rendererAvailableRef.current = boardseshRendererAvailable;
  const analyticsContextRef = useRef(analyticsContext);
  analyticsContextRef.current = analyticsContext;

  /**
   * Report one knob change, against the settings it produces.
   *
   * Silent without a preview board: the common props are built around a board
   * identity, and an event with no `board_name` cannot be stratified — the one
   * rule `docs/board-render-analytics.md` says never to break. Same bail
   * `applyPreset` makes.
   */
  const reportFieldChange = useCallback(
    (field: BoardRenderSettingField, value: string | number | boolean, next: BoardRenderSettings) => {
      const context = analyticsContextRef.current;
      if (!context) return;
      trackBoardRenderSettingChanged(
        field,
        value,
        resolveEffectiveRenderSettings(next, rendererAvailableRef.current === true),
        context,
      );
    },
    [],
  );

  const setMode = useCallback<BoardLookSettings['setMode']>(
    (mode) => {
      rawSetMode(mode);
      const next = { ...settingsRef.current, mode };
      settingsRef.current = next;
      reportFieldChange('mode', mode, next);
    },
    [rawSetMode, reportFieldChange],
  );

  const setBoardseshField = useCallback<BoardLookSettings['setBoardseshField']>(
    (field, value) => {
      rawSetBoardseshField(field, value);
      // Read the CURRENT bundle, not the one this callback closed over — the
      // mirror has to record the look as it now is, or a later restore brings
      // back a half-old bundle.
      // Built on the ref and written BACK to it, so a second change made before
      // React re-renders builds on the first instead of spreading the same
      // pre-change snapshot and dropping it. The next render overwrites the ref
      // with the store's own value, which is the truth once the write lands.
      const nextLook = { ...settingsRef.current.boardsesh, [field]: value };
      const next = { ...settingsRef.current, boardsesh: nextLook };
      settingsRef.current = next;
      void rememberCustomBoardLook(nextLook);
      reportFieldChange(field, value, next);
    },
    [rawSetBoardseshField, reportFieldChange],
  );

  const applyPreset = useCallback(
    (id: BoardLookOptionId) => {
      void applyBoardLookOption(id);
      if (!analyticsContext) return;
      // Report the settings the choice PRODUCES: the write above is async and
      // the store has not caught up, so resolve them here rather than re-reading.
      // No `custom` case: both surfaces route that id elsewhere before it gets
      // here — settings to `restoreCustomLook` (which reports it itself) and
      // onboarding to its own apply — so a branch for it here would be dead code
      // that looks live.
      const applied =
        id === 'classic'
          ? { ...settings, mode: 'classic' as const }
          : mergePresetPreservingAccessibility(
              BOARD_LOOK_SETTINGS_OPTIONS.find((option) => option.id === id)?.previewSettings ?? settings,
              settings,
            );
      trackBoardLookApplied(
        id,
        resolveEffectiveRenderSettings(applied, boardseshRendererAvailable === true),
        analyticsContext,
        'settings',
      );
    },
    [analyticsContext, boardseshRendererAvailable, settings],
  );

  const restoreCustomLook = useCallback(async () => {
    const custom = await loadCustomBoardLook();
    // Reported even with nothing to restore. Picking Custom is the decision the
    // funnel measures; whether a remembered bundle happened to exist is an
    // implementation detail, and skipping the event there would under-count the
    // climbers who go custom for the first time — the ones most worth seeing.
    // The settings reported are the ones that result either way.
    const report = (applied: BoardRenderSettings) => {
      const context = analyticsContextRef.current;
      if (!context) return;
      trackBoardLookApplied(
        'custom',
        resolveEffectiveRenderSettings(applied, rendererAvailableRef.current === true),
        context,
        'settings',
      );
    };
    if (!custom) {
      report(settingsRef.current);
      return;
    }
    // Through the same merge every preset apply obeys, not a raw write. A restore
    // may raise the accessibility-owned fields but never lower them — otherwise
    // coming back to Custom could silently switch someone's role glyphs off.
    //
    // Read AFTER the await, not from the closure: the settings captured when this
    // callback was built may be a render old by the time the storage read lands,
    // and merging against a stale bundle is exactly how the glyph the merge
    // exists to protect would get dropped. Same rule `setBoardseshField` follows.
    const restored = mergePresetPreservingAccessibility({ mode: 'aura', boardsesh: custom }, settingsRef.current);
    await setBoardRenderSettingsPreference(restored);
    report(restored);
  }, []);

  // Deliberately does NOT touch the hold-colour overrides. Those are colours and
  // shapes the climber set on the Accessibility screen, they drive the physical
  // board's LEDs, and nothing on this screen shows them — so a button labelled
  // "Reset board look" has no business clearing them.
  const resetBoardLook = useCallback(() => {
    reset();
    void clearCustomBoardLook();
  }, [reset]);

  return {
    settings,
    loaded,
    effectiveRenderSettings,
    boardseshRendererAvailable,
    requestedMode,
    matchingOptionId,
    setMode,
    setBoardseshField,
    applyPreset,
    restoreCustomLook,
    resetBoardLook,
  };
}
