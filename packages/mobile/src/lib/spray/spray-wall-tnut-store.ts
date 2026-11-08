import { readTnutLayout, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import { getPreference, setPreference } from '../preference-store';
import { notifySprayLedConfiguration } from './spray-led-config-events';

const keyFor = (wallUuid: string) => `sprayWallTnutLayout:${wallUuid}`;
const pendingWrites = new Map<string, Promise<void>>();

/** Separate from controller settings: opening either editor cannot overwrite the other. */
export async function loadSprayWallTnutLayout(wallUuid: string): Promise<TnutLayout | null> {
  await pendingWrites.get(wallUuid)?.catch(() => undefined);
  const stored = await getPreference<unknown>(keyFor(wallUuid), { strictParsing: true });
  if (stored === null) return null;
  const layout = readTnutLayout(stored);
  if (!layout) throw new Error('Invalid saved T-nut layout');
  return layout;
}

export async function saveSprayWallTnutLayout(wallUuid: string, layout: TnutLayout): Promise<void> {
  const validated = readTnutLayout(layout);
  if (!validated) throw new Error('Invalid T-nut layout');
  const preceding = pendingWrites.get(wallUuid);
  const write = Promise.resolve(preceding)
    .catch(() => undefined)
    .then(() => setPreference(keyFor(wallUuid), validated));
  pendingWrites.set(wallUuid, write);
  try {
    await write;
    notifySprayLedConfiguration(wallUuid);
  } finally {
    if (pendingWrites.get(wallUuid) === write) pendingWrites.delete(wallUuid);
  }
}
