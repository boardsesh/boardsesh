import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function assertSuccessfulBuild(status: number, appPath: string): void {
  if (status !== 0)
    throw new Error(`Xcode build failed (exit ${status}); refusing any pre-existing .app at ${appPath}.`);
  if (!existsSync(join(appPath, 'Info.plist')) || !existsSync(join(appPath, 'Boardsesh'))) {
    throw new Error(`Xcode did not produce a complete Boardsesh.app at ${appPath}.`);
  }
  if (statSync(join(appPath, 'Boardsesh')).size === 0) throw new Error('Built executable is empty.');
}

/** Publish only a fully copied product; rollback preserves the last good export. */
export function exportBuiltApp(status: number, appPath: string, appOut: string): string {
  assertSuccessfulBuild(status, appPath);
  mkdirSync(appOut, { recursive: true });
  const destination = join(appOut, 'Boardsesh.app');
  const stage = join(appOut, `.Boardsesh-${randomUUID()}.app`);
  const previous = join(appOut, `.Boardsesh-previous-${randomUUID()}.app`);
  try {
    cpSync(appPath, stage, { recursive: true });
    assertSuccessfulBuild(0, stage);
    // Ensure the copy has the same executable before replacing a working export.
    if (!readFileSync(join(stage, 'Boardsesh')).equals(readFileSync(join(appPath, 'Boardsesh')))) {
      throw new Error('Staged executable differs from the built executable.');
    }
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return destination;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
