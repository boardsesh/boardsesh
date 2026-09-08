import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SimulatorLeaseOwner {
  token: string;
  pid: number;
  worktree: string;
  udid: string;
  startedAt: string;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function acquireSimulatorLease(
  udid: string,
  worktree: string,
  directory = join(homedir(), 'Library', 'Caches', 'boardsesh', 'simulator-leases'),
  inheritedToken = process.env.BOARDSESH_SIMULATOR_LEASE_TOKEN,
): { owner: SimulatorLeaseOwner; release(): void } {
  if (!/^[0-9a-f-]{36}$/i.test(udid))
    throw new Error('A simulator lease requires an explicit UDID; "booted" is unsafe.');
  const leasePath = join(directory, `${udid.toUpperCase()}.lock`);
  mkdirSync(directory, { recursive: true });
  const owner: SimulatorLeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    worktree: realpathSync(worktree),
    udid,
    startedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(leasePath);
  } catch {
    let existing: SimulatorLeaseOwner;
    try {
      existing = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8')) as SimulatorLeaseOwner;
    } catch {
      throw new Error(`Simulator ${udid} has an incomplete lease at ${leasePath}; refusing to steal it.`);
    }
    if (
      existing.token === inheritedToken &&
      existing.udid.toUpperCase() === udid.toUpperCase() &&
      processIsAlive(existing.pid)
    ) {
      return { owner: existing, release() {} };
    }
    // Never steal a live lease, even when a long run exceeds a time threshold.
    if (processIsAlive(existing.pid)) {
      throw new Error(`Simulator ${udid} is leased by ${existing.worktree} (PID ${existing.pid}).`);
    }
    throw new Error(
      `Simulator ${udid} has a stopped owner. Remove only the stale lease at ${leasePath} before retrying.`,
    );
  }
  writeFileSync(join(leasePath, 'owner.json'), JSON.stringify(owner));
  return {
    owner,
    release() {
      try {
        const current = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8')) as SimulatorLeaseOwner;
        if (current.token === owner.token) rmSync(leasePath, { recursive: true });
      } catch {
        /* Already released. */
      }
    },
  };
}

const heldLeases = new Map<string, ReturnType<typeof acquireSimulatorLease>>();

export function holdSimulatorLease(udid: string, worktree: string): void {
  const selected = process.env.BOARDSESH_IOS_SIMULATOR_UDID;
  if (selected && selected.toUpperCase() !== udid.toUpperCase()) {
    throw new Error(`Requested simulator ${udid} differs from selected simulator ${selected}.`);
  }
  if (heldLeases.has(udid)) return;
  const lease = acquireSimulatorLease(udid, worktree);
  heldLeases.set(udid, lease);
  process.once('exit', () => lease.release());
}

/** Shared boundary for screenshot, status-bar, launch, navigation and shutdown. */
export function guardSimulatorCommand(command: string, args: readonly string[], worktree: string): void {
  if (command === 'maestro') {
    const deviceIndex = args.indexOf('--device');
    if (deviceIndex >= 0 && /^[0-9a-f-]{36}$/i.test(args[deviceIndex + 1])) {
      holdSimulatorLease(args[deviceIndex + 1], worktree);
    }
    return;
  }
  if (command !== 'xcrun' || args[0] !== 'simctl') return;
  if (['list', 'help', 'create'].includes(args[1])) return;
  const device = args[2];
  if (!device) throw new Error('Simulator action is missing its explicit UDID.');
  holdSimulatorLease(device, worktree);
}

export function resolveSimulatorUdid(requested = process.env.BOARDSESH_IOS_SIMULATOR_UDID): string {
  const listing = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      encoding: 'utf8',
    }),
  ) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
  return selectSimulatorUdid(Object.values(listing.devices).flat(), requested);
}

export function selectSimulatorUdid(
  devices: readonly { udid: string; name: string; state: string }[],
  requested?: string,
): string {
  const matches = requested
    ? devices.filter((device) => device.udid.toUpperCase() === requested.toUpperCase() || device.name === requested)
    : devices.filter((device) => device.state === 'Booted');
  if (matches.length !== 1)
    throw new Error('Select exactly one simulator with BOARDSESH_IOS_SIMULATOR_UDID or --device.');
  return matches[0].udid;
}

/** Shell wrappers execute their entire flow under one inherited lease. */
export function leaseEnvironment(
  udid: string,
  worktree: string,
): {
  env: NodeJS.ProcessEnv;
  release(): void;
} {
  const lease = acquireSimulatorLease(udid, resolve(worktree));
  return {
    env: { ...process.env, BOARDSESH_IOS_SIMULATOR_UDID: udid, BOARDSESH_SIMULATOR_LEASE_TOKEN: lease.owner.token },
    release: () => lease.release(),
  };
}
