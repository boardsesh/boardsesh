import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMatchingIdentity, readAppIdentity } from './lib/ios-profile-identity';
import { guardSimulatorCommand, resolveSimulatorUdid } from './lib/ios-simulator-lease';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appPath = process.argv[2];
if (!appPath) throw new Error('Pass the existing simulator app export for the smoke check.');
const configuration = existsSync(join(appPath, 'main.jsbundle')) ? 'Release' : 'Debug';
const identity = readAppIdentity(resolve(appPath), configuration);
const udid = resolveSimulatorUdid();
const simctl = (args: string[]) => {
  guardSimulatorCommand('xcrun', ['simctl', ...args], root);
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
};
const listing = JSON.parse(simctl(['list', 'devices', '--json'])) as {
  devices: Record<string, { udid: string; state: string }[]>;
};
if (
  Object.values(listing.devices)
    .flat()
    .find((device) => device.udid === udid)?.state !== 'Booted'
) {
  simctl(['boot', udid]);
}
simctl(['bootstatus', udid, '-b']);
simctl(['install', udid, resolve(appPath)]);
const installedPath = simctl(['get_app_container', udid, identity.bundleIdentifier, 'app']);
assertMatchingIdentity(identity, readAppIdentity(installedPath, configuration));
simctl(['launch', udid, identity.bundleIdentifier]);
console.log(`[mobile-sim] Launched verified ${configuration} export ${identity.bundleIdentifier} on ${udid}.`);
