import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeSprayLedConfiguration } from './spray-led-config-events';
import { getSprayWall, SPRAY_BOARD_NAME, subscribeToSprayWalls } from './spray-wall-registry';
import { loadSprayWallTnutLayout } from './spray-wall-tnut-store';
import { loadSprayWallLedSettings } from './use-spray-wall-led-settings';

type AdjacentLightingAnswer = { wallUuid: string; eligible: boolean };

/**
 * Only below/alternating LED layouts can add a dimmer light above a hold.
 * Keep the answer tied to its wall and read generation: switching walls or
 * editing LED setup must hide the switch until the current setup is known.
 * Hidden sheets disable reads until opened; Board settings reads when mounted.
 */
export function useSprayWallAdjacentLightingEligible(
  boardName: string | null | undefined,
  layoutId: number | null | undefined,
  enabled = true,
): boolean {
  const readWallUuid = useCallback(
    () =>
      enabled && boardName === SPRAY_BOARD_NAME && layoutId != null ? (getSprayWall(layoutId)?.wallUuid ?? null) : null,
    [boardName, layoutId, enabled],
  );
  const wallUuid = useSyncExternalStore(subscribeToSprayWalls, readWallUuid, readWallUuid);
  const [answer, setAnswer] = useState<AdjacentLightingAnswer | null>(null);

  useEffect(() => {
    if (wallUuid === null) return undefined;
    let latestRead = 0;
    const read = () => {
      const thisRead = ++latestRead;
      setAnswer(null);
      Promise.all([loadSprayWallLedSettings(wallUuid), loadSprayWallTnutLayout(wallUuid)]).then(
        ([settings, layout]) => {
          if (thisRead !== latestRead) return;
          setAnswer({
            wallUuid,
            eligible:
              settings.enabled &&
              settings.controller.url !== '' &&
              (layout?.ledPlacement === 'below' || layout?.ledPlacement === 'alternating'),
          });
        },
        () => {
          if (thisRead === latestRead) setAnswer({ wallUuid, eligible: false });
        },
      );
    };
    read();
    const unsubscribe = subscribeSprayLedConfiguration((changedWallUuid) => {
      if (changedWallUuid === wallUuid) read();
    });
    return () => {
      latestRead = -1;
      unsubscribe();
    };
  }, [wallUuid]);

  return wallUuid !== null && answer?.wallUuid === wallUuid && answer.eligible;
}
