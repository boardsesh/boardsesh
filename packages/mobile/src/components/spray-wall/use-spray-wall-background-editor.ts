// The live wall's background, as the board edit screen changes it.
//
// The background is one field of the wall's stored look (`render_settings`),
// and `setSprayWallRenderSettings` replaces the whole object. So the save
// rebuilds it from the look as stored, read raw here rather than through the
// loader's sanitised cache: a failed read must not be mistaken for "no look"
// and overwrite the owner's look with the default.

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_SPRAY_WALL_LOOK, GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../../lib/graphql/client';
import {
  isSprayWallArtNotAvailableError,
  readSprayWallArtRefusalReason,
} from '../../lib/graphql/extract-error-message';
import { sanitizeBoardRenderDefault } from '../../lib/board-render-settings';
import {
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  SPRAY_WALL_LOOK_OPTIONS,
  boardLookOptionWallDefault,
} from '../../lib/board-render/board-look-options';
import { sprayWallBackgroundOf, type SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { useSprayWallArt } from '../../lib/spray/use-spray-wall-art';
import { useSetSprayWallRenderSettings } from '../../lib/spray/use-create-spray-wall';
import {
  RENDER_DATA_STALE_TIME_MS,
  requestMissingSprayArt,
  sprayWallPublishedRenderDataQueryKey,
} from '../../lib/spray/spray-wall-loader';
import { sprayWallViewerGeneration } from '../../lib/spray/spray-wall-registry';
import { lookPreviewSourceFromRenderData } from '../../lib/spray/spray-look-preview';
import { sprayPrivacyGeneration } from '../../lib/spray/spray-privacy-generation';
import { canPickBackground, sprayBackgroundGate } from './spray-background-gate';

type SprayWallLookResponse = { sprayWall: { uuid: string; renderSettings?: unknown } | null };
type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

/**
 * `refused` carries the server's reason (`no-pins`, `keystone`, `small-frame`)
 * so the screen can say which; see `sprayArtRefusalMessageKey`.
 */
export type SprayBackgroundSaveOutcome =
  | { outcome: 'unchanged' | 'saved' | 'failed' }
  | { outcome: 'refused'; reason: string | null };

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
  // The published version's photo, pins and holds, for the tiles drawn on the
  // phone while its art is not ready. The loader's own key and request, so a
  // wall already on the board costs no second read.
  const viewerGeneration = sprayWallViewerGeneration();
  const renderDataQuery = useQuery({
    queryKey: sprayWallPublishedRenderDataQueryKey(wallUuid, viewerGeneration),
    queryFn: () => getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, { uuid: wallUuid }),
    enabled,
    staleTime: RENDER_DATA_STALE_TIME_MS,
    retry: false,
  });
  const renderData = renderDataQuery.data?.sprayWallRenderData;
  const previewSource = useMemo(
    () => lookPreviewSourceFromRenderData(renderData, { layoutId, versionId: renderData?.wall?.currentVersion?.id }),
    [renderData, layoutId],
  );

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
  // A generated look whose last render failed is re-sent on Save even when it
  // is already the stored choice: choosing it again is what re-queues the job,
  // and it is what the picker's "Save it again to retry" asks for.
  const retryFailedArt = gate.kind === 'open' && gate.status === 'failed' && value !== 'photo';
  const changed = (picked !== null && picked !== storedBackground) || retryFailedArt;

  const lookStatus = lookQuery.status;
  const refetchLook = lookQuery.refetch;
  const setRenderSettings = useSetSprayWallRenderSettings();
  const setRenderSettingsAsync = setRenderSettings.mutateAsync;

  /** Store the picked background. Resolves an outcome, never rejects. */
  const save = useCallback(async (): Promise<SprayBackgroundSaveOutcome> => {
    if (!changed || lookStatus !== 'success') return { outcome: 'unchanged' };
    if (!canPickBackground(gate, value)) {
      return { outcome: 'refused', reason: gate.kind === 'locked' && gate.reason === 'no-pins' ? 'no-pins' : null };
    }
    // A wall stored without a look (its first save failed) takes the default
    // one: the server will not store a background on its own.
    const look =
      sanitizeBoardRenderDefault(storedSettings) ??
      boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID, SPRAY_WALL_LOOK_OPTIONS);
    if (!look) return { outcome: 'failed' };
    // `background` is sent for a generated look, and as `photo` only when
    // leaving one: an omitted key keeps whatever is stored, and a backend older
    // than generated looks refuses the key outright, so a wall that never had a
    // background keeps sending the shape every backend accepts.
    const renderSettings = { ...look, background: value };
    try {
      await setRenderSettingsAsync({ layoutId, uuid: wallUuid, renderSettings });
    } catch (error) {
      return isSprayWallArtNotAvailableError(error)
        ? { outcome: 'refused', reason: readSprayWallArtRefusalReason(error) }
        : { outcome: 'failed' };
    }
    void refetchLook();
    // The live wall swaps onto the look as soon as its art is on disk; while
    // the job is still running it keeps its photo, and the picker's poll swaps
    // it when the art lands (`useSprayWallArt`).
    requestMissingSprayArt(layoutId);
    return { outcome: 'saved' };
  }, [changed, value, lookStatus, gate, storedSettings, setRenderSettingsAsync, layoutId, wallUuid, refetchLook]);

  return { gate, art: artQuery.data, value, onChange: setPicked, changed, save, previewSource };
}
