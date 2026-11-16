import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface BootCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Persist command evidence before throwing, including failures before app launch. */
export function bootIosCaptureDevice({
  device,
  debugDir,
  run,
}: {
  device: { udid: string; state: string };
  debugDir: string;
  run: (args: string[], timeoutMs: number) => BootCommandResult;
}): string {
  mkdirSync(debugDir, { recursive: true });
  const evidenceDir = mkdtempSync(join(debugDir, 'ios-boot-'));
  const checked = (operation: string, args: string[], timeoutMs: number) => {
    const startedAt = Date.now();
    // Save the intended command first: external cancellation may prevent its return.
    const evidencePath = join(evidenceDir, `${operation}.json`);
    const command = { args, timeoutMs, startedAt };
    writeFileSync(evidencePath, JSON.stringify(command, null, 2));
    let result: BootCommandResult;
    try {
      result = run(args, timeoutMs);
    } catch (error) {
      result = { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
    writeFileSync(evidencePath, JSON.stringify({ ...command, durationMs: Date.now() - startedAt, ...result }, null, 2));
    if (result.status !== 0)
      throw new Error(
        `Simulator ${operation} failed: ${result.stderr || result.stdout || result.status}; evidence: ${evidenceDir}`,
      );
  };
  if (device.state !== 'Booted') checked('boot', ['simctl', 'boot', device.udid], 120_000);
  checked('bootstatus', ['simctl', 'bootstatus', device.udid, '-b'], 180_000);
  return evidenceDir;
}
