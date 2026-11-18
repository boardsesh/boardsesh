import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpError } from './types';

const execute = promisify(execFile);

/** Paths enter through the environment, never PowerShell source or a shell. */
const PRIVATE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:BOARDSESH_MCP_ACL_PATH
$operation = $env:BOARDSESH_MCP_ACL_OPERATION
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$entry = Get-Item -LiteralPath $target -Force
if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not private storage' }
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.Value) { throw 'Storage belongs to another account' }
if ($operation -eq 'secure-directory') {
  if (-not $entry.PSIsContainer) { throw 'Storage must be a directory' }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
  $acl = Get-Acl -LiteralPath $target
  if (-not $acl.AreAccessRulesProtected) { throw 'Directory permissions are inherited' }
} elseif ($operation -ne 'check-file') { throw 'Unknown ACL operation' }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -lt 1) { throw 'No private access rule' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -ne $identity.Value -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'Storage permits another account' }
}
if ($operation -eq 'check-file' -and $entry.PSIsContainer) { throw 'Credentials must be a file' }
`;

async function runPrivateAcl(path: string, operation: 'secure-directory' | 'check-file'): Promise<void> {
  try {
    await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRIVATE_ACL_SCRIPT], {
      env: { ...process.env, BOARDSESH_MCP_ACL_PATH: path, BOARDSESH_MCP_ACL_OPERATION: operation },
      timeout: 15_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
  } catch {
    throw new McpError(
      'unsafe_permissions',
      'Windows private-storage permissions could not be verified. Use a directory owned by your Windows account with PowerShell available.',
    );
  }
}

export async function secureWindowsDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') await runPrivateAcl(path, 'secure-directory');
}

export async function assertPrivateWindowsFile(path: string): Promise<void> {
  if (process.platform === 'win32') await runPrivateAcl(path, 'check-file');
}
