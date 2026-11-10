// Runs one server for the partner e2e and makes sure it never outlives the
// test run. Usage: node watchdog.mjs <parent pid> <command> [args...]
//
// The global setup starts it as a process group leader, and the server runs in
// its group. The whole group ends when any of these happens:
// - the global setup's teardown signals the group;
// - the Playwright runner that started it disappears, even by SIGKILL, which no
//   handler can catch: the watchdog checks every second;
// - the server itself exits: whatever it left behind in the group goes too.
// SIGTERM first, SIGKILL 10 seconds later for anything still there, the
// watchdog included.
import { spawn } from 'node:child_process';

const [parentArgument, command, ...args] = process.argv.slice(2);
const parentPid = Number(parentArgument);
if (!Number.isInteger(parentPid) || parentPid <= 1 || !command) {
  console.error('usage: node watchdog.mjs <parent pid> <command> [args...]');
  process.exit(2);
}

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch {
    // The group is already gone.
  }
}

let ending = false;
function endGroup() {
  if (ending) return;
  ending = true;
  clearInterval(parentWatch);
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 10_000);
}

// The group SIGTERM reaches the watchdog too; it stays to send the SIGKILL.
process.on('SIGTERM', endGroup);
process.on('SIGINT', endGroup);

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    endGroup();
  }
}, 1_000);

const child = spawn(command, args, { stdio: 'inherit' });
child.on('exit', () => {
  clearInterval(parentWatch);
  setTimeout(() => signalGroup('SIGKILL'), ending ? 2_000 : 500);
});
