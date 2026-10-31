import { spawn } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import {
  parseDarwinMemoryPressure,
  parseDarwinSwapUsage,
  parseDarwinVmStat,
  topResidentProcesses,
} from '../../store-video-measure';
export type ObservationSensor = (command: string, args: string[], timeout: number) => Promise<string | null>;
/** Small query-only subprocesses; their deadlines never block the trace server. */
export const boundedObservationSensor: ObservationSensor = (command, args, timeout) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '',
      settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1024 * 1024) {
        child.kill('SIGKILL');
        finish(null);
      } else output += chunk;
    });
    child.once('error', () => finish(null));
    child.once('exit', (status) => finish(status === 0 ? output : null));
  });
export async function observationMemorySnapshot(
  phase: string,
  attempt: number,
  sample: ObservationSensor = boundedObservationSensor,
) {
  const startedAt = new Date().toISOString();
  const [processes, vm, swap, pressure, simulatorList] = await Promise.all([
    sample('ps', ['-axo', 'pid=,ppid=,rss=,comm='], 2000),
    sample('vm_stat', [], 1000),
    sample('sysctl', ['vm.swapusage'], 1000),
    sample('memory_pressure', ['-Q'], 1000),
    sample('xcrun', ['simctl', 'list', 'devices', '--json'], 2000),
  ]);
  let booted: string[] | null = null;
  try {
    const listing = JSON.parse(simulatorList ?? '{}') as {
      devices?: Record<string, { udid: string; state: string }[]>;
    };
    booted = Object.values(listing.devices ?? {})
      .flat()
      .filter((device) => device.state === 'Booted')
      .map((device) => device.udid);
  } catch {
    /* optional sensor */
  }
  return {
    attempt,
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    totalMiB: totalmem() / 1024 ** 2,
    nonFreeMiB: (totalmem() - freemem()) / 1024 ** 2,
    vm: vm ? parseDarwinVmStat(vm) : null,
    swap: swap ? parseDarwinSwapUsage(swap) : null,
    pressureFreePercent: pressure ? parseDarwinMemoryPressure(pressure) : null,
    topProcesses: processes ? topResidentProcesses(processes) : null,
    topology: { primarySimulators: 1, metros: 1, metroWorkers: 1, secondary: false, bootedUdid: booted },
  };
}
