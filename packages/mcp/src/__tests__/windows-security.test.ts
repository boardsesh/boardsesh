import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { readCredentials, writeCredentials } from '../credentials';
import { ensurePrivateDirectory, withProfileLock } from '../profile-lock';
import { ISSUER } from '../types';
import { assertPrivateWindowsFile } from '../windows-security';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function powershell(path: string, script: string): Promise<string> {
  const result = await execute(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$PSModuleAutoLoadingPreference = 'None'\n${script}`],
    {
      env: { ...process.env, BOARDSESH_MCP_ACL_TEST_PATH: path },
      timeout: 15_000,
      windowsHide: true,
    },
  );
  return result.stdout.trim();
}

describe.runIf(process.platform === 'win32')('Windows private storage ACLs', () => {
  it('protects storage without module autoload and rejects credentials readable by Everyone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'boardsesh-mcp-acl-'));
    directories.push(parent);
    const directory = join(parent, 'private-profile');
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(directory);
    const directoryVerdict = await powershell(
      directory,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = [System.IO.DirectoryInfo]::new($env:BOARDSESH_MCP_ACL_TEST_PATH).GetAccessControl()
      if (-not $acl.AreAccessRulesProtected) { throw 'Expected protected DACL' }
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value) { throw 'Unexpected access rules' }
      [Console]::WriteLine('private')
    `,
    );
    expect(directoryVerdict).toBe('private');
    const credentials = join(directory, 'credentials.json');
    await withProfileLock(directory, async (guard) => {
      await writeCredentials(
        directory,
        {
          version: 1,
          issuer: ISSUER,
          clientId: 'public-client',
          accountId: 'test-account',
          generation: randomUUID(),
          accessToken: 'test-access',
          refreshToken: 'test-refresh',
          refreshPending: false,
        },
        guard,
      );
    });
    expect(await readCredentials(directory)).toMatchObject({ clientId: 'public-client' });
    await expect(assertPrivateWindowsFile(credentials)).resolves.toBeUndefined();
    await powershell(
      credentials,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $entry = [System.IO.FileInfo]::new($env:BOARDSESH_MCP_ACL_TEST_PATH)
      $acl = $entry.GetAccessControl()
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      $entry.SetAccessControl($acl)
    `,
    );
    await expect(assertPrivateWindowsFile(credentials)).rejects.toMatchObject({
      code: 'unsafe_permissions',
      message: expect.stringContaining('(nonprivate-access)'),
      cause: expect.any(Error),
    });
  }, 30_000);

  it('rejects an existing Administrators-owned directory without changing its owner', async (context) => {
    const parent = await mkdtemp(join(tmpdir(), 'boardsesh-mcp-acl-owner-'));
    directories.push(parent);
    const directory = join(parent, 'existing-profile');
    await ensurePrivateDirectory(directory);
    const owner = await powershell(
      directory,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
      if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { [Console]::WriteLine('not-elevated'); exit }
      $entry = [System.IO.DirectoryInfo]::new($env:BOARDSESH_MCP_ACL_TEST_PATH)
      $acl = $entry.GetAccessControl()
      $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
      $entry.SetAccessControl($acl)
      [Console]::WriteLine('S-1-5-32-544')
    `,
    );
    if (owner === 'not-elevated') context.skip();
    expect(owner).toBe('S-1-5-32-544');
    await expect(ensurePrivateDirectory(directory)).rejects.toMatchObject({
      code: 'unsafe_permissions',
      message: expect.stringContaining('(wrong-owner)'),
      cause: expect.any(Error),
    });
    const remainingOwner = await powershell(
      directory,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $acl = [System.IO.DirectoryInfo]::new($env:BOARDSESH_MCP_ACL_TEST_PATH).GetAccessControl()
      [Console]::WriteLine($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
    `,
    );
    expect(remainingOwner).toBe(owner);
  }, 30_000);
});
