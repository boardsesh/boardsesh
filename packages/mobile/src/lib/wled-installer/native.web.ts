import { WledInstallerError, type InstallerIO } from './engine';
const unavailable = async (): Promise<never> => {
  throw new WledInstallerError('unavailable');
};
/** Installation stays on an owner's Android or iOS phone. */
export const nativeInstallerIO: InstallerIO = {
  readJson: unavailable,
  checkUpdateAccess: unavailable,
  saveBackup: unavailable,
  exportBackup: unavailable,
  download: unavailable,
  upload: unavailable,
  readJournal: unavailable,
  writeJournal: unavailable,
  clearJournal: unavailable,
  awake: async () => undefined,
  wait: unavailable,
};
