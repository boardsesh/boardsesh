import type { CrewToolchainIdentity } from './ios-simulator-architecture.mjs';
export interface CrewContext {
  sourceSha: string;
  workflowSha: string;
  runId: string;
  runAttempt: string;
  toolingSha256: string;
}
export interface CrewReceipt extends CrewContext {
  format: string;
  hostArchitecture: string;
  targetArchitecture: string;
  toolchain: CrewToolchainIdentity;
  sdkSupportVerified: boolean;
  sdkInventorySha256: string;
}
export interface CrewMachOBuild {
  platform: string;
  minOS: string;
  sdk: string;
  form: string;
}
export interface CrewBinary extends CrewMachOBuild {
  path: string;
  sha256: string;
  architectures: string[];
}
export interface CrewAppIdentity {
  treeSha256: string;
  entryCount: number;
  binaries: CrewBinary[];
  deploymentTarget: string;
}
export interface CrewManifest extends CrewReceipt {
  consumerRuntime: string;
  archiveSha256: string;
  app: CrewAppIdentity;
}
export interface CrewTreeEntry {
  path: string;
  mode: number;
  kind: string;
  target?: string;
  sha256?: string;
  size?: number;
}
export type CrewInspect = (path: string) => CrewMachOBuild & { architectures: string[] };
export type CrewPlistReader = (path: string) => Record<string, unknown>;
export function compareVersions(first: string, second: string): number;
export function parseCrewMachOBuild(output: string, architecture?: string): CrewMachOBuild;
export function crewAppTree(appPath: string): CrewTreeEntry[];
export function inspectCrewApp(appPath: string, inspect?: CrewInspect, plistReader?: CrewPlistReader): CrewAppIdentity;
export function assertCrewContext(context: unknown): asserts context is CrewContext;
export function assertCrewSdkInventory(
  settings: unknown,
  interfaces: { exists: boolean; sha256: string | null }[],
  stubs: { x86Simulator: boolean; sha256: string }[],
  compatibilityArchitectures: string[],
  target: unknown,
): string;
export function preflightCrewCrossBuild(sourceRoot: string): CrewReceipt;
export function assertCrewManifest(manifest: unknown, expected: CrewContext): CrewManifest;
export function packCrewApp(
  appPath: string,
  receipt: CrewReceipt,
  outputDirectory: string,
  inspect?: CrewInspect,
  plistReader?: CrewPlistReader,
): { manifest: CrewManifest; archiveSha256: string; manifestSha256: string };
export function verifyCrewArtifact(
  artifactDirectory: string,
  appOutput: string,
  expected: CrewContext,
  digests: { archiveSha256: string; manifestSha256: string },
  inspect?: CrewInspect,
  plistReader?: CrewPlistReader,
): CrewManifest;
export function assertSelectedCrewRuntime(udid: string, devices: unknown, runtimes: unknown, expected?: string): string;
export function assertCrewConsumerRuntime(runtimes: unknown): void;
export function crewCrossArtifactMain(args?: string[]): unknown;
