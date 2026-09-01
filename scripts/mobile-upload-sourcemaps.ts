/// <reference types="node" />

/**
 * Uploads source maps from one self-hosted Expo OTA export to Sentry.
 *
 * `@sentry/react-native`'s official Expo uploader intentionally skips incomplete
 * bundle/map groups and still exits zero. That is convenient interactively but
 * unsafe for a production OTA gate, so this wrapper validates the complete Expo
 * artifact first and only then invokes the pinned installed uploader.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MOBILE_DIR = resolve(REPO_ROOT, 'packages', 'mobile');
const SUPPORTED_SENTRY_REACT_NATIVE_VERSION = '7.11.0';
const VALID_DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MobilePlatform = 'ios' | 'android';

type JsonObject = Record<string, unknown>;

type SpawnUploader = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' },
) => { status: number | null; error?: Error };

export interface UploadSourceMapsOptions {
  platform: MobilePlatform;
  mobileDir?: string;
  outputDir?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface UploadSourceMapsDependencies {
  resolveUploader?: (mobileDir: string) => string;
  spawnUploader?: SpawnUploader;
}

export interface ValidatedSourceMapArtifact {
  bundlePath: string;
  sourceMapPath: string;
  relativeBundlePath: string;
  relativeSourceMapPath: string;
  debugId: string;
}

interface DeclaredMetadataPath {
  absolutePath: string;
  extension: string;
  relativePath: string;
  type: 'asset' | 'bundle';
}

function isJsonObject(input: unknown): input is JsonObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function parseJsonObject(filePath: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${reason}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return parsed;
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

function existingPathWithin(rootPath: string, candidatePath: string, label: string): string {
  const realRootPath = realpathSync(rootPath);
  const realCandidatePath = realpathSync(candidatePath);
  if (!pathIsWithin(realRootPath, realCandidatePath)) {
    throw new Error(`${label} escapes ${realRootPath}: ${candidatePath}`);
  }
  return realCandidatePath;
}

function normalizeDeclaredPath(outputDir: string, declaredPath: string, label: string): string {
  if (
    !declaredPath ||
    isAbsolute(declaredPath) ||
    declaredPath.includes('\0') ||
    declaredPath.includes('\\') ||
    /^[a-z]:[/\\]/i.test(declaredPath)
  ) {
    throw new Error(`${label} is invalid: ${JSON.stringify(declaredPath)}.`);
  }
  const candidatePath = resolve(outputDir, declaredPath);
  if (!pathIsWithin(resolve(outputDir), candidatePath)) {
    throw new Error(`${label} escapes the output directory: ${declaredPath}.`);
  }
  const normalizedPath = relative(resolve(outputDir), candidatePath).split(sep).join('/');
  if (normalizedPath !== declaredPath) {
    throw new Error(`${label} must be a normalized relative path: ${declaredPath}.`);
  }
  return normalizedPath;
}

function assertRegularFileWithoutSymbolicLinks(outputDir: string, relativePath: string, label: string): string {
  let currentPath = outputDir;
  for (const pathSegment of relativePath.split('/')) {
    currentPath = join(currentPath, pathSegment);
    if (!existsSync(currentPath)) {
      throw new Error(`${label} does not exist in the output directory: ${relativePath}.`);
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${relativePath}.`);
    }
  }
  if (!statSync(currentPath).isFile()) {
    throw new Error(`${label} is not a regular file: ${relativePath}.`);
  }
  return existingPathWithin(outputDir, currentPath, label);
}

function extensionFromExecutablePath(relativePath: string): 'js' | 'hbc' | null {
  if (relativePath.endsWith('.js')) return 'js';
  if (relativePath.endsWith('.hbc')) return 'hbc';
  return null;
}

function parseDeclaredMetadataPaths(
  outputDir: string,
  platformMetadata: JsonObject,
): { executablePaths: DeclaredMetadataPath[]; declaredMapPaths: Set<string>; allDeclaredPaths: Set<string> } {
  if (typeof platformMetadata.bundle !== 'string') {
    throw new Error('metadata.json has no platform bundle.');
  }
  if (!Array.isArray(platformMetadata.assets)) {
    throw new Error('metadata.json platform assets must be an array.');
  }

  const executablePaths: DeclaredMetadataPath[] = [];
  const declaredMapPaths = new Set<string>();
  const allDeclaredPaths = new Set<string>();
  const caseInsensitivePaths = new Map<string, string>();

  const addDeclaredPath = (relativePathInput: string, extension: string, type: 'asset' | 'bundle'): void => {
    const label = type === 'bundle' ? 'metadata.json bundle path' : 'metadata.json asset path';
    const relativePath = normalizeDeclaredPath(outputDir, relativePathInput, label);
    if (allDeclaredPaths.has(relativePath)) {
      throw new Error(`metadata.json declares a duplicate path: ${relativePath}.`);
    }
    const caseInsensitivePath = relativePath.toLocaleLowerCase('en-US');
    const collidingPath = caseInsensitivePaths.get(caseInsensitivePath);
    if (collidingPath) {
      throw new Error(`metadata.json paths collide: ${collidingPath} and ${relativePath}.`);
    }
    allDeclaredPaths.add(relativePath);
    caseInsensitivePaths.set(caseInsensitivePath, relativePath);

    const absolutePath = assertRegularFileWithoutSymbolicLinks(outputDir, relativePath, label);
    const executableExtension = extensionFromExecutablePath(relativePath);
    const declaresExecutable = extension === 'js' || extension === 'hbc';
    if (
      declaresExecutable !== Boolean(executableExtension) ||
      (executableExtension && extension !== executableExtension)
    ) {
      throw new Error(`metadata.json executable extension does not match its path: ${relativePath} (${extension}).`);
    }
    const declaresSourceMap = extension === 'map' || relativePath.endsWith('.map');
    if (declaresSourceMap && (extension !== 'map' || !relativePath.endsWith('.map'))) {
      throw new Error(`metadata.json source-map extension does not match its path: ${relativePath} (${extension}).`);
    }
    if (declaresExecutable && executableExtension) {
      executablePaths.push({ absolutePath, extension, relativePath, type });
    } else if (declaresSourceMap) {
      declaredMapPaths.add(relativePath);
    }
  };

  const bundleExtension = extensionFromExecutablePath(platformMetadata.bundle);
  if (!bundleExtension) {
    throw new Error(`metadata.json platform bundle must end in .js or .hbc: ${platformMetadata.bundle}.`);
  }
  addDeclaredPath(platformMetadata.bundle, bundleExtension, 'bundle');

  for (const [assetIndex, assetInput] of platformMetadata.assets.entries()) {
    if (!isJsonObject(assetInput) || typeof assetInput.path !== 'string' || typeof assetInput.ext !== 'string') {
      throw new Error(`metadata.json asset ${assetIndex} must contain string path and ext fields.`);
    }
    addDeclaredPath(assetInput.path, assetInput.ext, 'asset');
  }

  return { executablePaths, declaredMapPaths, allDeclaredPaths };
}

function readDebugId(sourceMapPath: string): string {
  const sourceMap = parseJsonObject(sourceMapPath, `Source map ${sourceMapPath}`);
  const camelCaseDebugId = sourceMap.debugId;
  const snakeCaseDebugId = sourceMap.debug_id;
  if (
    typeof camelCaseDebugId === 'string' &&
    typeof snakeCaseDebugId === 'string' &&
    camelCaseDebugId !== snakeCaseDebugId
  ) {
    throw new Error(`Source map has mismatched debugId and debug_id values: ${sourceMapPath}`);
  }
  const debugId = typeof camelCaseDebugId === 'string' ? camelCaseDebugId : snakeCaseDebugId;
  if (typeof debugId !== 'string' || !VALID_DEBUG_ID.test(debugId)) {
    throw new Error(`Source map has no valid Debug ID: ${sourceMapPath}`);
  }
  return debugId;
}

export function validateSourceMapOutput(
  mobileDirInput: string,
  outputDirInput: string,
  platform: MobilePlatform,
): ValidatedSourceMapArtifact[] {
  const mobileDir = realpathSync(resolve(mobileDirInput));
  const outputDir = resolve(outputDirInput);
  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) {
    throw new Error(`Source-map output directory does not exist: ${outputDir}`);
  }
  if (lstatSync(outputDir).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link source-map output directory: ${outputDir}`);
  }
  const realOutputDir = existingPathWithin(mobileDir, outputDir, 'Source-map output directory');

  const metadataPath = join(realOutputDir, 'metadata.json');
  if (!existsSync(metadataPath) || !statSync(metadataPath).isFile()) {
    throw new Error(`Expo export metadata is missing: ${metadataPath}`);
  }
  if (lstatSync(metadataPath).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link metadata.json: ${metadataPath}`);
  }

  const metadata = parseJsonObject(metadataPath, 'metadata.json');
  if (metadata.version !== 0 || metadata.bundler !== 'metro') {
    throw new Error('metadata.json must be Expo Metro metadata version 0.');
  }
  if (!isJsonObject(metadata.fileMetadata)) {
    throw new Error('metadata.json must contain a fileMetadata object.');
  }
  const metadataPlatforms = Object.keys(metadata.fileMetadata);
  if (metadataPlatforms.length !== 1 || metadataPlatforms[0] !== platform) {
    throw new Error(
      `metadata.json must contain exactly the requested platform "${platform}"; found: ${metadataPlatforms.join(', ') || '(none)'}.`,
    );
  }
  const platformMetadata = metadata.fileMetadata[platform];
  if (!isJsonObject(platformMetadata)) {
    throw new Error(`metadata.json has no bundle for platform "${platform}".`);
  }
  const { executablePaths, declaredMapPaths, allDeclaredPaths } = parseDeclaredMetadataPaths(
    realOutputDir,
    platformMetadata,
  );
  const executablePathSet = new Set(executablePaths.map(({ relativePath }) => relativePath));
  for (const declaredMapPath of declaredMapPaths) {
    if (!executablePathSet.has(declaredMapPath.slice(0, -'.map'.length))) {
      throw new Error(`Metadata-declared source map has no matching executable: ${declaredMapPath}.`);
    }
  }

  // eoas delegates to Expo 57's external-map export. Metro names the
  // initial pair `<name>.js` + `<name>.js.map`; Hermes then changes both suffixes
  // to `<name>.hbc` + `<name>.hbc.map`. In either case the official Sentry
  // uploader groups the pair by the exact `${bundlePath}.map` convention.
  return executablePaths.map(({ absolutePath: bundlePath, relativePath: relativeBundlePath, type }) => {
    if (statSync(bundlePath).size === 0) {
      throw new Error(`Bundle is empty: ${bundlePath}`);
    }
    const relativeSourceMapPath = `${relativeBundlePath}.map`;
    if (allDeclaredPaths.has(relativeSourceMapPath) && !declaredMapPaths.has(relativeSourceMapPath)) {
      throw new Error(`Metadata path collides with the required source map: ${relativeSourceMapPath}.`);
    }
    if (!existsSync(join(realOutputDir, relativeSourceMapPath))) {
      const executableLabel = type === 'bundle' ? 'Primary OTA bundle' : 'Metadata-declared executable asset';
      throw new Error(
        `${executableLabel} requires an exact adjacent source map at ${relativeSourceMapPath}. ` +
          'The installed Sentry 7.11 uploader cannot safely group an independently named map.',
      );
    }
    const sourceMapPath = assertRegularFileWithoutSymbolicLinks(realOutputDir, relativeSourceMapPath, 'Source map');
    if (statSync(sourceMapPath).size === 0) {
      throw new Error(`Source map is empty: ${sourceMapPath}`);
    }
    return {
      bundlePath,
      sourceMapPath,
      relativeBundlePath,
      relativeSourceMapPath,
      debugId: readDebugId(sourceMapPath),
    };
  });
}

function stageValidatedArtifacts(artifacts: ValidatedSourceMapArtifact[], stagingDirectory: string): void {
  const stagedPaths = new Set<string>();
  for (const artifact of artifacts) {
    for (const [sourcePath, relativePath] of [
      [artifact.bundlePath, artifact.relativeBundlePath],
      [artifact.sourceMapPath, artifact.relativeSourceMapPath],
    ] as const) {
      const destinationPath = resolve(stagingDirectory, relativePath);
      if (!pathIsWithin(stagingDirectory, destinationPath) || stagedPaths.has(destinationPath)) {
        throw new Error(`Validated source-map staging path collides or escapes: ${relativePath}.`);
      }
      stagedPaths.add(destinationPath);
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

export function resolveInstalledSentryUploader(mobileDirInput: string): string {
  const requestedMobileDir = resolve(mobileDirInput);
  if (!existsSync(requestedMobileDir) || !statSync(requestedMobileDir).isDirectory()) {
    throw new Error(`Mobile directory does not exist or is not a directory: ${requestedMobileDir}`);
  }
  const mobileDir = realpathSync(requestedMobileDir);
  const requireFromMobile = createRequire(join(mobileDir, 'package.json'));
  let sentryPackageJsonPath: string;
  try {
    sentryPackageJsonPath = requireFromMobile.resolve('@sentry/react-native/package.json');
  } catch {
    throw new Error(
      `Could not resolve installed @sentry/react-native from ${mobileDir}. Run the workspace install first.`,
    );
  }
  const sentryPackage = parseJsonObject(sentryPackageJsonPath, '@sentry/react-native package.json');
  if (sentryPackage.version !== SUPPORTED_SENTRY_REACT_NATIVE_VERSION) {
    throw new Error(
      `Unsupported @sentry/react-native version ${String(sentryPackage.version)}; expected ${SUPPORTED_SENTRY_REACT_NATIVE_VERSION}.`,
    );
  }
  const packageRoot = realpathSync(dirname(sentryPackageJsonPath));
  const uploaderPath = join(packageRoot, 'scripts', 'expo-upload-sourcemaps.js');
  if (!existsSync(uploaderPath) || !statSync(uploaderPath).isFile()) {
    throw new Error(`Official Sentry Expo source-map uploader is missing: ${uploaderPath}`);
  }
  return existingPathWithin(packageRoot, uploaderPath, 'Official Sentry uploader');
}

/** Shared by the OTA source-map upload and the iOS dSYM upload (mobile-upload-dsyms.ts). */
export function createSentryUploadEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const authToken = environment.SENTRY_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error('SENTRY_AUTH_TOKEN is required to upload to Sentry.');
  }
  const uploaderEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    SENTRY_AUTH_TOKEN: authToken,
    SENTRY_ORG: 'boardsesh',
    SENTRY_PROJECT: 'boardsesh',
    SENTRY_URL: 'https://sentry.io/',
  };
  delete uploaderEnvironment.SENTRY_RELEASE;
  delete uploaderEnvironment.SENTRY_DIST;
  delete uploaderEnvironment.SENTRY_CLI_EXECUTABLE;
  return uploaderEnvironment;
}

export function uploadMobileSourceMaps(
  options: UploadSourceMapsOptions,
  dependencies: UploadSourceMapsDependencies = {},
): ValidatedSourceMapArtifact[] {
  const mobileDir = resolve(options.mobileDir ?? DEFAULT_MOBILE_DIR);
  const outputDir = resolve(options.outputDir ?? join(mobileDir, 'dist'));
  const uploaderEnvironment = createSentryUploadEnvironment(options.environment ?? process.env);
  const validatedArtifacts = validateSourceMapOutput(mobileDir, outputDir, options.platform);
  const uploaderPath = (dependencies.resolveUploader ?? resolveInstalledSentryUploader)(mobileDir);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'boardsesh-sentry-upload-'));
  const temporaryWorkingDirectory = join(temporaryRoot, 'cwd');
  const stagingDirectory = join(temporaryRoot, 'artifacts');

  console.log(
    `[mobile:upload-sourcemaps] Uploading ${validatedArtifacts.length} ${options.platform} bundle/map pair(s) by Debug ID.`,
  );
  try {
    mkdirSync(temporaryWorkingDirectory);
    mkdirSync(stagingDirectory);
    stageValidatedArtifacts(validatedArtifacts, stagingDirectory);
    const spawnUploader: SpawnUploader =
      dependencies.spawnUploader ?? ((executable, args, spawnOptions) => spawnSync(executable, args, spawnOptions));
    // Sentry ships this uploader as a Node/CommonJS entrypoint. GitHub runners
    // and local vp installs provide Node, so keep the uploader runtime explicit
    // and identical on both paths.
    const uploadResult = spawnUploader('node', [uploaderPath, stagingDirectory], {
      cwd: temporaryWorkingDirectory,
      env: uploaderEnvironment,
      stdio: 'inherit',
    });
    if (uploadResult.error) {
      throw new Error(`Could not start the official Sentry uploader: ${uploadResult.error.message}`);
    }
    if (uploadResult.status !== 0) {
      throw new Error(`Official Sentry uploader failed with exit code ${uploadResult.status ?? 'unknown'}.`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log(`[mobile:upload-sourcemaps] Uploaded ${options.platform} OTA source maps successfully.`);
  return validatedArtifacts;
}

export function parseUploadArgs(args: string[]): MobilePlatform {
  let platform: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--platform' || argument === '-p') {
      platform = args[++index] ?? null;
      continue;
    }
    if (argument.startsWith('--platform=')) {
      platform = argument.slice('--platform='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('--platform is required and must be either ios or android.');
  }
  return platform;
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    uploadMobileSourceMaps({ platform: parseUploadArgs(process.argv.slice(2)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mobile:upload-sourcemaps] ${reason}`);
    process.exitCode = 1;
  }
}
