import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeSprayLedConfiguration } from './spray-led-config-events';
import { getSprayWall, SPRAY_BOARD_NAME, subscribeToSprayWalls } from './spray-wall-registry';
import { loadSprayWallLedSettings } from './use-spray-wall-led-settings';

type LedSetupAnswer = { wallUuid: string; enabled: boolean };

/**
 * Whether a spray wall has a working LED setup for this phone: the switch is on
 * and a controller address is saved. The setup lives with the wall (read from the
 * server, with a copy on the phone), so the board's own flags can't say this.
 *
 * Fails closed: false while the wall or its settings are still loading, on a
 * read error, and for every board that isn't a spray wall, which reads nothing.
 * An answer is only believed for the wall it was read for, so a late read of the
 * previous wall can't light this one.
 */
export function useSprayWallLedsEnabled(
  boardName: string | null | undefined,
  layoutId: number | null | undefined,
): boolean {
  // The wall is on its way when the player opens, so its uuid can arrive after
  // the first render. A string, so an unrelated registration wakes nothing.
  const readWallUuid = () =>
    boardName === SPRAY_BOARD_NAME && layoutId != null ? (getSprayWall(layoutId)?.wallUuid ?? null) : null;
  const wallUuid = useSyncExternalStore(subscribeToSprayWalls, readWallUuid, readWallUuid);
  const [answer, setAnswer] = useState<LedSetupAnswer | null>(null);

  useEffect(() => {
    if (wallUuid === null) return undefined;
    let latestRead = 0;
    const read = () => {
      const thisRead = ++latestRead;
      setAnswer(null);
      loadSprayWallLedSettings(wallUuid).then(
        (settings) => {
          if (thisRead !== latestRead) return;
          setAnswer({ wallUuid, enabled: settings.enabled && settings.controller.url !== '' });
        },
        () => {
          if (thisRead === latestRead) setAnswer({ wallUuid, enabled: false });
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

  return wallUuid !== null && answer?.wallUuid === wallUuid && answer.enabled;
}
