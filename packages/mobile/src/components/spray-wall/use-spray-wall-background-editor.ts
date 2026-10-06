// The live wall's background, as the board edit screen changes it.
//
// The background is one field of the wall's stored look (`render_settings`),
// and `setSprayWallRenderSettings` replaces the whole object. So the save
// rebuilds it from the look as stored, read raw here rather than through the
// loader's sanitised cache: a failed read must not be mistaken for "no look"
// and overwrite the owner's look with the default.

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_SPRAY_WALL_LOOK } from '@boardsesh/graphql/operations/spray-walls';
import { getHttpClient } from '../../lib/graphql/client';
import { isSprayWallArtNotAvailableError } from '../../lib/graphql/extract-error-message';
import { sanitizeBoardRenderDefault } from '../../lib/board-render-settings';
import {
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  SPRAY_WALL_LOOK_OPTIONS,
  boardLookOptionWallDefault,
} from '../../lib/board-render/board-look-options';
import { sprayWallBackgroundOf, type SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { useSprayWallArt } from '../../lib/spray/use-spray-wall-art';
import { useSetSprayWallRenderSettings } from '../../lib/spray/use-create-spray-wall';
import { requestMissingSprayArt } from '../../lib/spray/spray-wall-loader';
import { sprayPrivacyGeneration } from '../../lib/spray/spray-privacy-generation';
import { canPickBackground, sprayBackgroundGate } from './spray-background-gate';

type SprayWallLookResponse = { sprayWall: { uuid: string; renderSettings?: unknown } | null };

export type SprayBackgroundSaveOutcome = 'unchanged' | 'saved' | 'refused' | 'failed';

export function useSprayWallBackgroundEditor({
  wallUuid,
  layoutId,
  enabled,
}: {
  wallUuid: string;
  layoutId: number;
  enabled: boolean;
}) {
  const lookQuery = useQuery({
    queryKey: ['sprayWallStoredLook', wallUuid, sprayPrivacyGeneration(layoutId)],
    queryFn: () => getHttpClient().request<SprayWallLookResponse>(GET_SPRAY_WALL_LOOK, { uuid: wallUuid }),
    enabled,
    retry: false,
  });
  const artQuery = useSprayWallArt(enabled ? wallUuid : null, null, layoutId);

  const storedSettings = lookQuery.data?.sprayWall?.renderSettings;
  const storedBackground = sprayWallBackgroundOf(storedSettings);
  // Both reads have to answer: the art read says whether a generated look may
  // be offered, the look read is what the save is built on.
  const gate = useMemo(() => {
    if (lookQuery.status !== 'success') {
      return sprayBackgroundGate({ status: lookQuery.status === 'error' ? 'error' : 'pending', art: null });
    }
    return sprayBackgroundGate({ status: artQuery.status, art: artQuery.data });
  }, [lookQuery.status, artQuery.status, artQuery.data]);

  const [picked, setPicked] = useState<SprayWallBackground | null>(null);
  const value = picked ?? storedBackground;
  const changed = picked !== null && picked !== storedBackground;

  const lookStatus = lookQuery.status;
  const refetchLook = lookQuery.refetch;
  const setRenderSettings = useSetSprayWallRenderSettings();
  const setRenderSettingsAsync = setRenderSettings.mutateAsync;

  /** Store the picked background. Resolves an outcome, never rejects. */
  const save = useCallback(async (): Promise<SprayBackgroundSaveOutcome> => {
    if (!changed || picked === null || lookStatus !== 'success') return 'unchanged';
    if (!canPickBackground(gate, picked)) return 'refused';
    // A wall stored without a look (its first save failed) takes the default
    // one: the server will not store a background on its own.
    const look =
      sanitizeBoardRenderDefault(storedSettings) ??
      boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID, SPRAY_WALL_LOOK_OPTIONS);
    if (!look) return 'failed';
    // `background` is sent for a generated look, and as `photo` only when
    // leaving one: an omitted key keeps whatever is stored, and a backend older
    // than generated looks refuses the key outright, so a wall that never had a
    // background keeps sending the shape every backend accepts.
    const renderSettings = { ...look, background: picked };
    try {
      await setRenderSettingsAsync({ layoutId, uuid: wallUuid, renderSettings });
    } catch (error) {
      return isSprayWallArtNotAvailableError(error) ? 'refused' : 'failed';
    }
    void refetchLook();
    // The live wall swaps onto the look as soon as its art is on disk; while
    // the job is still running it keeps its photo, and the picker's poll swaps
    // it when the art lands (`useSprayWallArt`).
    requestMissingSprayArt(layoutId);
    return 'saved';
  }, [changed, picked, lookStatus, gate, storedSettings, setRenderSettingsAsync, layoutId, wallUuid, refetchLook]);

  return { gate, art: artQuery.data, value, onChange: setPicked, changed, save };
}
