import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePrivateDirectory } from '../profile-lock';
import { assertPrivateWindowsFile } from '../windows-security';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function powershell(path: string, script: string): Promise<string> {
  const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, BOARDSESH_MCP_ACL_TEST_PATH: path },
    timeout: 15_000,
    windowsHide: true,
  });
  return result.stdout.trim();
}

describe.runIf(process.platform === 'win32')('Windows private storage ACLs', () => {
  it('protects a private directory and rejects credentials readable by Everyone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-mcp-acl-'));
    directories.push(directory);
    await ensurePrivateDirectory(directory);
    const directoryVerdict = await powershell(
      directory,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = Get-Acl -LiteralPath $env:BOARDSESH_MCP_ACL_TEST_PATH
      if (-not $acl.AreAccessRulesProtected) { throw 'Expected protected DACL' }
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value) { throw 'Unexpected access rules' }
      Write-Output 'private'
    `,
    );
    expect(directoryVerdict).toBe('private');
    const credentials = join(directory, 'credentials.json');
    await writeFile(credentials, '{}');
    await expect(assertPrivateWindowsFile(credentials)).resolves.toBeUndefined();
    await powershell(
      credentials,
      String.raw`
      $ErrorActionPreference = 'Stop'
      $acl = Get-Acl -LiteralPath $env:BOARDSESH_MCP_ACL_TEST_PATH
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $env:BOARDSESH_MCP_ACL_TEST_PATH -AclObject $acl
    `,
    );
    await expect(assertPrivateWindowsFile(credentials)).rejects.toMatchObject({ code: 'unsafe_permissions' });
  }, 30_000);
});
