import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpError } from './types';

const execute = promisify(execFile);

/** Paths enter through the environment, never PowerShell source or a shell. */
const PRIVATE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent can pass an incompatible PSModulePath to Windows
# PowerShell 5.1. Use .NET Framework directly and require no module autoload.
$PSModuleAutoLoadingPreference = 'None'
$target = $env:BOARDSESH_MCP_ACL_PATH
$operation = $env:BOARDSESH_MCP_ACL_OPERATION
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directoryAcl = [System.Security.AccessControl.DirectorySecurity]::new()
$directoryAcl.SetOwner($identity)
$directoryAcl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$directoryRule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$directoryAcl.AddAccessRule($directoryRule)
if ($operation -eq 'secure-directory' -and -not [System.IO.Directory]::Exists($target)) {
  # Specify the security descriptor at creation. An elevated token's default
  # owner may be Administrators rather than WindowsIdentity.User.
  [void][System.IO.Directory]::CreateDirectory($target, $directoryAcl)
} elseif ($operation -eq 'create-file') {
  $fileAcl = [System.Security.AccessControl.FileSecurity]::new()
  $fileAcl.SetOwner($identity)
  $fileAcl.SetAccessRuleProtection($true, $false)
  $fileRule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  $fileAcl.AddAccessRule($fileRule)
  $stream = [System.IO.FileStream]::new($target, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $fileAcl)
  $stream.Dispose()
}
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'mcp-acl:reparse-point' }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if ($isDirectory) { $entry = [System.IO.DirectoryInfo]::new($target) }
else { $entry = [System.IO.FileInfo]::new($target) }
$acl = $entry.GetAccessControl()
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.Value) { throw 'mcp-acl:wrong-owner' }
if ($operation -eq 'secure-directory') {
  if (-not $isDirectory) { throw 'mcp-acl:not-directory' }
  $entry.SetAccessControl($directoryAcl)
  $acl = $entry.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected) { throw 'mcp-acl:inherited-directory' }
} elseif ($operation -ne 'check-file' -and $operation -ne 'create-file') { throw 'mcp-acl:unknown-operation' }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -lt 1) { throw 'mcp-acl:no-access-rules' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -ne $identity.Value -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'mcp-acl:nonprivate-access' }
}
if ($operation -ne 'secure-directory' -and $isDirectory) { throw 'mcp-acl:not-file' }
`;

async function runPrivateAcl(
  path: string,
  operation: 'secure-directory' | 'check-file' | 'create-file',
): Promise<void> {
  try {
    await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRIVATE_ACL_SCRIPT], {
      env: { ...process.env, BOARDSESH_MCP_ACL_PATH: path, BOARDSESH_MCP_ACL_OPERATION: operation },
      timeout: 15_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : '';
    const reason = /mcp-acl:([a-z-]+)/.exec(stderr)?.[1] ?? 'powershell-failed';
    const failure = new McpError(
      'unsafe_permissions',
      `Windows private-storage permissions could not be verified (${reason}). Use a directory owned by your Windows account with PowerShell available.`,
    );
    // Test runners can print the underlying script failure. User-facing CLI and
    // MCP errors emit only the sanitized message above; no credential contents
    // are ever passed to PowerShell.
    Object.defineProperty(failure, 'cause', {
      value: new Error(stderr || 'PowerShell could not be executed.'),
      enumerable: false,
    });
    throw failure;
  }
}

export async function secureWindowsDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') await runPrivateAcl(path, 'secure-directory');
}

export async function assertPrivateWindowsFile(path: string): Promise<void> {
  if (process.platform === 'win32') await runPrivateAcl(path, 'check-file');
}

/** Exclusive empty-file creation with an explicit current-user owner and DACL. */
export async function createPrivateWindowsFile(path: string): Promise<void> {
  if (process.platform === 'win32') await runPrivateAcl(path, 'create-file');
}
