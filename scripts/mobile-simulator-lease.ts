import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaseEnvironment, resolveSimulatorUdid } from './lib/ios-simulator-lease';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2).filter((argument) => argument !== '--');
if (!command) throw new Error('Expected a command to run while holding the simulator lease.');
const inheritedToken = process.env.BOARDSESH_SIMULATOR_LEASE_TOKEN;
if (command === '--assert-only' && (!inheritedToken || !process.env.BOARDSESH_IOS_SIMULATOR_UDID)) {
  throw new Error('An inherited simulator lease requires both its token and exact UDID.');
}
const lease = leaseEnvironment(resolveSimulatorUdid(), root);
try {
  if (command === '--assert-only') {
    if (lease.env.BOARDSESH_SIMULATOR_LEASE_TOKEN !== inheritedToken) {
      throw new Error('The inherited simulator lease token is stale or invalid.');
    }
  } else {
    const result = spawnSync(command, args, { cwd: root, env: lease.env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
} finally {
  lease.release();
}
