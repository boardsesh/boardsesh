import { readTnutLayout, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import { getPreference, setPreference } from '../preference-store';
import { notifySprayLedConfiguration } from './spray-led-config-events';
import { sprayWallLedLayoutKey } from './spray-wall-led-cache';
import { markSprayWallLedSaveStarted, prepareSprayWallLedRead, queueSprayWallLedUpload } from './spray-wall-led-sync';

const pendingWrites = new Map<string, Promise<void>>();

/**
 * Separate from controller settings: opening either editor cannot overwrite the
 * other. Each is saved to the wall on its own, and the phone keeps a copy of each.
 */
export async function loadSprayWallTnutLayout(wallUuid: string): Promise<TnutLayout | null> {
  await pendingWrites.get(wallUuid)?.catch(() => undefined);
  await prepareSprayWallLedRead(wallUuid, 'layout');
  const stored = await getPreference<unknown>(sprayWallLedLayoutKey(wallUuid), { strictParsing: true });
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
    .then(() => markSprayWallLedSaveStarted(wallUuid, 'layout'))
    .then(() => setPreference(sprayWallLedLayoutKey(wallUuid), validated));
  pendingWrites.set(wallUuid, write);
  try {
    await write;
    notifySprayLedConfiguration(wallUuid);
    queueSprayWallLedUpload(wallUuid, 'layout');
  } finally {
    if (pendingWrites.get(wallUuid) === write) pendingWrites.delete(wallUuid);
  }
}
