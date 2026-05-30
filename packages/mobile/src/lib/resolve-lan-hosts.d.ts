import type { NetworkInterfaceInfo } from 'node:os';

export type ResolveLanHostsEnv = {
  CI?: string;
  EAS_BUILD?: string;
  EAS_BUILD_RUNNER?: string;
};

export type ResolveLanHostsOptions = {
  env?: ResolveLanHostsEnv;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
};

export function resolveLanHosts(options?: ResolveLanHostsOptions): string[];
