import { useEffect, useState } from 'react';
import { bleControllerTarget } from '@boardsesh/led-controller';
import { getPreference, removePreference, setPreference } from '../preference-store';
import { notifySprayLedConfiguration } from './spray-led-config-events';
import {
  serializeSprayWallLedCacheWrite,
  sprayWallLedBleDeviceKey,
  subscribeSprayWallLedCacheErased,
} from './spray-wall-led-cache';

/** The Bluetooth controller this phone drives a Spraywall with. */
export type SprayWallBleDevice = { id: string; name: string };

/** Called with the wall (null: every wall) and what it now has. */
const listeners = new Set<(wallUuid: string | null, device: SprayWallBleDevice | null) => void>();
subscribeSprayWallLedCacheErased((wallUuid) => {
  for (const listener of listeners) listener(wallUuid, null);
});

function readDevice(stored: unknown): SprayWallBleDevice | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const { id, name } = stored as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  try {
    bleControllerTarget(id);
  } catch {
    return null;
  }
  return { id, name: name.slice(0, 64) };
}

export async function loadSprayWallBleDevice(wallUuid: string): Promise<SprayWallBleDevice | null> {
  try {
    return readDevice(await getPreference<unknown>(sprayWallLedBleDeviceKey(wallUuid)));
  } catch {
    return null;
  }
}

/**
 * Remember (or with null, forget) this phone's controller for the wall. Never
 * uploaded. `restartLighting: false` is for the route sender adopting the only
 * controller nearby: it is about to light that one, so nothing needs restarting.
 */
export async function saveSprayWallBleDevice(
  wallUuid: string,
  device: SprayWallBleDevice | null,
  { restartLighting = true }: { restartLighting?: boolean } = {},
): Promise<void> {
  await serializeSprayWallLedCacheWrite(wallUuid, () =>
    device
      ? setPreference(sprayWallLedBleDeviceKey(wallUuid), { id: device.id, name: device.name })
      : removePreference(sprayWallLedBleDeviceKey(wallUuid)),
  );
  for (const listener of listeners) listener(wallUuid, device);
  if (restartLighting) notifySprayLedConfiguration(wallUuid);
}

/** The phone's controller for this wall, kept current across screens. */
export function useSprayWallBleDevice(wallUuid: string) {
  const [state, setState] = useState<{ wallUuid: string; device: SprayWallBleDevice | null; loading: boolean }>({
    wallUuid,
    device: null,
    loading: true,
  });
  useEffect(() => {
    let active = true;
    const load = () => {
      void loadSprayWallBleDevice(wallUuid).then((device) => {
        if (active) setState({ wallUuid, device, loading: false });
      });
    };
    const listener = (changed: string | null, device: SprayWallBleDevice | null) => {
      if (active && (changed === null || changed === wallUuid)) setState({ wallUuid, device, loading: false });
    };
    listeners.add(listener);
    load();
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, [wallUuid]);
  return state.wallUuid === wallUuid ? state : { wallUuid, device: null, loading: true };
}
