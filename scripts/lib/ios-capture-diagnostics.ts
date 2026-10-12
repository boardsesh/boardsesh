import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface IosDiagnosticReport {
  path: string;
  modifiedMs: number;
  bytes: number;
}

export function iosDiagnosticReportDirectories(udid: string): string[] {
  return [
    join(homedir(), 'Library/Logs/DiagnosticReports'),
    join(homedir(), 'Library/Developer/CoreSimulator/Devices', udid, 'data/Library/Logs/DiagnosticReports'),
  ];
}

/** Snapshot before launch, so an earlier attempt's report cannot explain this failure. */
export function snapshotIosDiagnosticReports(directories: readonly string[]): IosDiagnosticReport[] {
  const reports: IosDiagnosticReport[] = [];
  for (const directory of directories) {
    let filenames: string[];
    try {
      filenames = readdirSync(directory);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      if (!/^(?:Boardsesh|JetsamEvent)[-_].*\.(?:ips|crash)$/.test(filename)) continue;
      const path = join(directory, filename);
      try {
        const metadata = statSync(path);
        if (metadata.isFile()) reports.push({ path, modifiedMs: metadata.mtimeMs, bytes: metadata.size });
      } catch {
        // macOS may rotate/remove a report between listing and inspecting it.
      }
    }
  }
  return reports;
}

type DiagnosticCommandResult = { status: number; stdout: string };

/** Call while this exact simulator is booted; never launch/relaunch the app to diagnose it. */
export function preserveIosCaptureDiagnostics(input: {
  udid: string;
  debugDir: string;
  nativeLogPath: string;
  reportDirectories: readonly string[];
  baseline: readonly IosDiagnosticReport[];
  runCommand: (args: string[]) => DiagnosticCommandResult;
}): string {
  mkdirSync(input.debugDir, { recursive: true });
  // Keep every failed attempt separately; a retry must not overwrite its process/crash evidence.
  const target = mkdtempSync(join(input.debugDir, 'ios-native-'));
  try {
    if (existsSync(input.nativeLogPath)) copyFileSync(input.nativeLogPath, join(target, 'live-device.log'));
  } catch {
    // A failed log copy must not prevent collecting process/report evidence.
  }
  const processResult = input.runCommand(['simctl', 'spawn', input.udid, 'launchctl', 'list']);
  // launchctl's labels establish whether an app process remains, without dumping other apps' state.
  const processLines = processResult.stdout.split(/\r?\n/).filter((line) => /Boardsesh|com\.boardsesh\./.test(line));
  writeFileSync(
    join(target, 'process-state.json'),
    JSON.stringify({ udid: input.udid, commandStatus: processResult.status, processLines }, null, 2),
  );
  const previous = new Map(input.baseline.map((report) => [report.path, report]));
  const freshReports = snapshotIosDiagnosticReports(input.reportDirectories)
    .filter((report) => {
      const existing = previous.get(report.path);
      return !existing || existing.modifiedMs !== report.modifiedMs || existing.bytes !== report.bytes;
    })
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
  let copiedBytes = 0;
  let copiedCount = 0;
  for (const report of freshReports) {
    if (copiedCount >= 5 || report.bytes > 10 * 1024 * 1024 - copiedBytes) continue;
    try {
      // Jetsam reports cover many processes. Keep one only if this app actually appears.
      if (
        basename(report.path).startsWith('JetsamEvent') &&
        !/Boardsesh|com\.boardsesh\./.test(readFileSync(report.path, 'utf8'))
      )
        continue;
      copyFileSync(report.path, join(target, `${copiedCount + 1}-${basename(report.path)}`));
      copiedBytes += report.bytes;
      copiedCount += 1;
    } catch {
      // Reports rotate while the simulator runs. Preserve any other fresh reports.
    }
  }
  return target;
}
