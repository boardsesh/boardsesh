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
export interface CrewToolchainIdentity {
  developerDir: string;
  realDeveloperDir: string;
  realAppPath: string;
  realSdkPath: string;
  compilerPath: string;
  xcodeVersion: string;
  xcodeBuild: string;
  sdkVersion: string;
  sdkBuild: string;
  sdkPath: string;
  swiftVersion: string;
}
export const CREW_CROSS_FORMAT: string;
export const CREW_DEVELOPER_DIR: string;
export function assertCanonicalCrewToolchain(identity: unknown): CrewToolchainIdentity;
export function readCanonicalCrewToolchain(): CrewToolchainIdentity;
export function crewCrossBuildArchitecture(
  hostArchitecture: SimulatorArchitecture,
  receipt: unknown,
  sourceSha: string,
  observedToolchain: CrewToolchainIdentity,
): 'x86_64';
