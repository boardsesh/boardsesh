import release from './server.json';
import hosting from './hosting.json';

export type OtaHostingProvider = 'railway' | 'homelab';

if (
  release.repository !== 'ghcr.io/mercuretechnologies/expo-open-ota' ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version) ||
  !/^sha256:[0-9a-f]{64}$/.test(release.digest)
) {
  throw new Error('Invalid immutable OTA release in infra/ota/server.json');
}
if (hosting.provider !== 'railway' && hosting.provider !== 'homelab') {
  throw new Error('Unknown OTA hosting provider');
}

export const OTA_SERVER_VERSION = release.version;
export const OTA_IMAGE_REPOSITORY = release.repository;
export const OTA_IMAGE = `${release.repository}@${release.digest}`;
export const OTA_HOSTING_PROVIDER: OtaHostingProvider = hosting.provider;
