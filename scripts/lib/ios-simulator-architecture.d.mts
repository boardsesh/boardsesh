export type SimulatorArchitecture = 'arm64' | 'x86_64';
export function simulatorArchitecture(
  nodeArchitecture?: string,
  runnerArchitecture?: string,
  ci?: boolean,
): SimulatorArchitecture;
export function assertSimulatorCacheArchitecture(cacheKey: string, architecture?: SimulatorArchitecture): void;
export function readMachOArchitectures(binaryPath: string): string[];
export function assertAppSimulatorArchitecture(
  appPath: string,
  architecture?: SimulatorArchitecture,
  requireDebug?: boolean,
  inspect?: (binaryPath: string) => string[],
): { architecture: SimulatorArchitecture; executables: { file: string; architectures: string[]; sha256: string }[] };
export function assertSimulatorBuildSource(sourceRoot: string): void;
export function architectureGuardMain(args?: string[]): unknown;
