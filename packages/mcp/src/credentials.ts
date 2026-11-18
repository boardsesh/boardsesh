import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isMissing, type ProfileLock } from './profile-lock';
import { ISSUER, McpError } from './types';
import { assertPrivateWindowsFile, createPrivateWindowsFile } from './windows-security';

const CredentialsSchema = z.object({
  version: z.literal(1),
  issuer: z.literal(ISSUER),
  clientId: z.string().min(1),
  accountId: z.string().min(1),
  generation: z.string().uuid(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  refreshPending: z.boolean(),
  refreshOwnerPid: z.number().int().positive().optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export async function readCredentials(directory: string): Promise<Credentials | undefined> {
  // The writer atomically replaces this file while lock-free cache readers run.
  // Retry only that identity race; permissions and malformed data fail at once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readCredentialSnapshot(directory);
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== 'credentials_changed' || attempt === 2) throw error;
    }
  }
  throw new McpError('credentials_changed', 'Credentials changed while being opened. Retry the operation.');
}

async function readCredentialSnapshot(directory: string): Promise<Credentials | undefined> {
  const filename = join(directory, 'credentials.json');
  const attributes = await lstat(filename).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!attributes) return undefined;
  const assertSafe = (entry: typeof attributes) => {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > 65_536 ||
      (process.getuid && entry.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
    ) {
      throw new McpError(
        'unsafe_credentials',
        'Credentials must be an owner-readable regular file. Run login again after correcting its permissions.',
      );
    }
  };
  assertSafe(attributes);
  await assertPrivateWindowsFile(filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertSafe(opened);
    if (opened.ino !== attributes.ino || opened.dev !== attributes.dev) {
      throw new McpError('credentials_changed', 'Credentials changed while being opened. Retry the operation.');
    }
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    const result = CredentialsSchema.safeParse(parsed);
    if (!result.success) throw new Error('Invalid credential shape');
    return result.data;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError('invalid_credentials', 'Saved credentials are invalid. Run boardsesh-mcp login again.');
  } finally {
    await handle.close();
  }
}

export async function writeCredentials(directory: string, credentials: Credentials, guard: ProfileLock): Promise<void> {
  guard.assertHeld();
  const temporary = join(directory, `.credentials-${randomUUID()}.json`);
  if (process.platform === 'win32') await createPrivateWindowsFile(temporary);
  const handle = await open(temporary, process.platform === 'win32' ? 'r+' : 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(CredentialsSchema.parse(credentials)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    guard.assertHeld();
    await rename(temporary, join(directory, 'credentials.json'));
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeCredentials(directory: string, guard: ProfileLock): Promise<void> {
  guard.assertHeld();
  await rm(join(directory, 'credentials.json'), { force: true });
}
