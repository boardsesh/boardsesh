#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '..');

const services = {
  backend: {
    dockerfile: 'Dockerfile.backend',
    rootPackageName: 'boardsesh-backend',
    // The OG climb renderer (GET /og/climb) composites board photos onto the
    // social card, so the backend image needs the board images tree (~70MB).
    // The prebuilt .wasm rides in automatically via the
    // @boardsesh/board-renderer-wasm workspace-dep walk.
    extraSourceDirs: ['packages/web/public/images'],
  },
  web: {
    dockerfile: 'Dockerfile.web',
    // @boardsesh/mobile used to ride along because Dockerfile.web's builder
    // stage ran the static Expo web export. W-24 (#4438) deleted that step, so
    // the mobile workspace and the export script below are now dead weight in
    // this context — retained only until W-26 (#4442) does the slimming pass.
    // Nothing in the image invokes either.
    rootPackageNames: ['@boardsesh/web', '@boardsesh/mobile'],
    // Repo-root scripts copied under source/scripts. `tailscale-hostname.ts` is
    // load-bearing: packages/web/scripts/dev-with-tailscale.ts imports it and
    // Next's production type-check covers packages/web/scripts, so the module
    // must resolve inside the build context. The export script (and the manifest
    // patcher it shells out to) is no longer invoked by the Dockerfile — kept as
    // a pair so the copied script stays runnable, and both go in W-26 (#4442).
    extraSourceFiles: [
      'scripts/build-expo-web-export.sh',
      'scripts/lib/patch-expo-web-pwa-manifest.mjs',
      'scripts/lib/tailscale-hostname.ts',
    ],
  },
  sync: {
    dockerfile: 'Dockerfile.sync',
    // All sync CLIs plus the cron scheduler in one image. The source layer is
    // the union of these roots' transitive workspace deps; the daemon/CLI to run
    // is chosen by the container command, not baked into the image. The
    // scheduler rides along because it is another long-lived Node CLI with the
    // same shape — see docs/scheduler.md for the split-it-out follow-up.
    rootPackageNames: [
      '@boardsesh/kilter-sync',
      '@boardsesh/aurora-sync',
      '@boardsesh/moonboard-sync',
      '@boardsesh/scheduler',
    ],
  },
};

const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const ignoredDirectoryNames = new Set([
  '.cache',
  '.expo',
  '.gradle',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const ignoredFileNames = new Set(['.DS_Store']);
// Repo-relative directory paths to keep out of every context. Unlike
// `ignoredDirectoryNames` (matched by basename, so it can't target `public/app`
// without also dropping `packages/web/app` / `packages/mobile/app`), these match
// the exact path from the repo root.
//
// These are the two DEFAULT_OUTPUT_DIR values of
// scripts/build-expo-web-export.sh: `packages/web/public/app` (the default
// baseUrl-/app export, written by `vp run build:expo-web` and
// `vp run dev:mobile:web-static`) and `packages/web/public/app-standalone` (the
// --subdomain export, the exact command production-deploy.yml runs and the
// natural way to verify a change locally). Both are gitignored, so a stale copy
// sits in a working tree invisibly.
//
// This exclusion is load-bearing on its own since W-24 (#4438): the builder
// stage no longer rebuilds any export, so a stale local copy riding into the
// context would be copied verbatim to the runner's `public/` and served as real
// files under /app or /app-standalone — the exact second-SPA-copy problem the
// retirement closes, and the one #3795 must not reintroduce. The walk is a
// plain fs walk with no gitignore awareness, so the exclusion has to be
// explicit. Guarded by scripts/__tests__/dockerfile-web-no-expo-export.test.ts,
// which reads the export script's own defaults rather than trusting this list.
const ignoredRepoRelativePaths = new Set(['packages/web/public/app', 'packages/web/public/app-standalone']);

const toPosix = (filePath) => filePath.split(sep).join(posix.sep);
const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

// Root inputs for every pnpm install layer. pnpm 11 stores workspace globs,
// overrides and patchedDependencies in pnpm-workspace.yaml.
const requiredRootManifestFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const optionalRootManifestFiles = ['.npmrc'];
const workspaceConfigFileName = 'pnpm-workspace.yaml';

// This context generator runs before dependencies are installed in several CI
// jobs, so it intentionally uses a narrow, fail-closed YAML reader instead of
// importing the `yaml` package. Only the block scalar forms emitted by this
// repository are accepted.
function stripYamlComment(line) {
  let openQuote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (openQuote !== null) {
      if (character === openQuote) openQuote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      openQuote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

const unsupportedScalarPrefixes = ['&', '*', '<<', '|', '>', '[', '{', '!', '?'];

function unquoteYamlScalar(rawValue, context) {
  const value = rawValue.trim();
  if (value === '') {
    throw new Error(`${context}: empty value; only non-empty plain or quoted scalars are supported`);
  }
  for (const prefix of unsupportedScalarPrefixes) {
    if (value.startsWith(prefix)) {
      throw new Error(
        `${context}: unsupported YAML construct ${JSON.stringify(value)}. ` +
          'This reader only handles plain block scalars — no flow style, anchors, aliases or block scalars.',
      );
    }
  }
  const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
  const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  if (isSingleQuoted || isDoubleQuoted) return value.slice(1, -1);
  if (value.includes("'") || value.includes('"')) {
    throw new Error(`${context}: cannot read partially quoted scalar ${JSON.stringify(value)}`);
  }
  return value;
}

function readYamlTopLevelBlockLines(yamlText, topLevelKey, filePath) {
  const blockLines = [];
  let insideBlock = false;
  let sawKey = false;

  for (const rawLine of yamlText.split('\n')) {
    const line = stripYamlComment(rawLine).replace(/\s+$/, '');
    if (line === '') continue;
    if (/^\s/.test(line)) {
      if (insideBlock) blockLines.push(line);
      continue;
    }
    if (insideBlock) break;

    const topLevelMatch = line.match(/^([^:\s][^:]*):(.*)$/);
    if (!topLevelMatch) {
      throw new Error(`${filePath}: cannot read top-level line ${JSON.stringify(rawLine)} as "key:"`);
    }
    if (topLevelMatch[1] !== topLevelKey) continue;
    if (topLevelMatch[2].trim() !== '') {
      throw new Error(
        `${filePath}: "${topLevelKey}" must use block style; got the inline value ` +
          `${JSON.stringify(topLevelMatch[2].trim())}`,
      );
    }
    insideBlock = true;
    sawKey = true;
  }

  return sawKey ? blockLines : null;
}

function readYamlBlockSequence(yamlText, topLevelKey, filePath) {
  const blockLines = readYamlTopLevelBlockLines(yamlText, topLevelKey, filePath);
  if (blockLines === null) return null;

  let itemIndent = null;
  return blockLines.map((line) => {
    const itemMatch = line.match(/^(\s+)-\s+(.*)$/);
    if (!itemMatch) {
      throw new Error(`${filePath}: "${topLevelKey}" must be a block sequence of scalars; got ${JSON.stringify(line)}`);
    }
    if (itemIndent === null) itemIndent = itemMatch[1].length;
    else if (itemMatch[1].length !== itemIndent) {
      throw new Error(
        `${filePath}: "${topLevelKey}" mixes indentation at ${JSON.stringify(line)}; nesting is not supported`,
      );
    }
    return unquoteYamlScalar(itemMatch[2], `${filePath} "${topLevelKey}"`);
  });
}

function readYamlBlockMapping(yamlText, topLevelKey, filePath) {
  const blockLines = readYamlTopLevelBlockLines(yamlText, topLevelKey, filePath);
  if (blockLines === null) return null;

  const mapping = {};
  let entryIndent = null;
  for (const line of blockLines) {
    const entryMatch = line.match(/^(\s+)('[^']*'|"[^"]*"|[^:\s'"][^:]*):(.*)$/);
    if (!entryMatch) {
      throw new Error(
        `${filePath}: "${topLevelKey}" must be a block mapping of scalar to scalar; got ${JSON.stringify(line)}`,
      );
    }
    if (entryIndent === null) entryIndent = entryMatch[1].length;
    else if (entryMatch[1].length !== entryIndent) {
      throw new Error(
        `${filePath}: "${topLevelKey}" mixes indentation at ${JSON.stringify(line)}; nesting is not supported`,
      );
    }
    const entryKey = unquoteYamlScalar(entryMatch[2], `${filePath} "${topLevelKey}" key`);
    mapping[entryKey] = unquoteYamlScalar(entryMatch[3], `${filePath} "${topLevelKey}.${entryKey}"`);
  }
  return mapping;
}

function readWorkspaceConfig(repoRoot) {
  const workspaceConfigPath = join(repoRoot, workspaceConfigFileName);
  if (!existsSync(workspaceConfigPath)) {
    throw new Error(
      `${workspaceConfigFileName} is missing from ${repoRoot}. pnpm 11 keeps the workspace globs, overrides and ` +
        'patchedDependencies there, so the Docker context cannot be generated without it.',
    );
  }
  return readFileSync(workspaceConfigPath, 'utf8');
}

function getWorkspacePatterns(repoRoot) {
  const patterns = readYamlBlockSequence(readWorkspaceConfig(repoRoot), 'packages', workspaceConfigFileName);
  if (patterns === null || patterns.length === 0) {
    throw new Error(`${workspaceConfigFileName} has no "packages:" entries; every workspace manifest would be missing`);
  }
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      throw new Error(
        `${workspaceConfigFileName}: negated workspace pattern ${JSON.stringify(pattern)} is not supported here`,
      );
    }
  }
  return patterns;
}

function getPatchedDependencies(repoRoot) {
  return readYamlBlockMapping(readWorkspaceConfig(repoRoot), 'patchedDependencies', workspaceConfigFileName) ?? {};
}

function requireKnownService(serviceName) {
  const service = services[serviceName];
  if (!service) {
    const names = Object.keys(services).join(', ');
    throw new Error(`unknown service ${JSON.stringify(serviceName)}; expected one of: ${names}`);
  }
  return service;
}

function expandWorkspacePattern(repoRoot, workspacePattern) {
  const starCount = [...workspacePattern].filter((char) => char === '*').length;
  if (starCount > 1) {
    throw new Error(`workspace pattern ${workspacePattern} is not supported; expected at most one *`);
  }

  if (starCount === 0) {
    const packageJsonPath = posix.join(workspacePattern, 'package.json');
    return existsSync(join(repoRoot, packageJsonPath)) ? [packageJsonPath] : [];
  }

  const [workspaceRoot, workspaceSuffix = ''] = workspacePattern.split('*');
  const normalizedRoot = workspaceRoot.endsWith('/') ? workspaceRoot.slice(0, -1) : workspaceRoot;
  const normalizedSuffix = workspaceSuffix.startsWith('/') ? workspaceSuffix.slice(1) : workspaceSuffix;
  const absoluteWorkspaceRoot = join(repoRoot, normalizedRoot);
  if (!existsSync(absoluteWorkspaceRoot)) return [];

  return readdirSync(absoluteWorkspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDirectory = normalizedSuffix
        ? posix.join(normalizedRoot, entry.name, normalizedSuffix)
        : posix.join(normalizedRoot, entry.name);
      return posix.join(packageDirectory, 'package.json');
    })
    .filter((packageJsonPath) => existsSync(join(repoRoot, packageJsonPath)));
}

function getWorkspacePackageJsonPaths(repoRoot = defaultRepoRoot) {
  const workspacePatterns = getWorkspacePatterns(repoRoot);
  return [...new Set(workspacePatterns.flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function getWorkspacePackageMap(repoRoot = defaultRepoRoot) {
  const packageJsonPaths = getWorkspacePackageJsonPaths(repoRoot);
  const workspacesByName = new Map();

  for (const packageJsonPath of packageJsonPaths) {
    const packageDirectory = posix.dirname(packageJsonPath);
    const packageJson = readJson(join(repoRoot, packageJsonPath));
    if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
      throw new Error(`${String(packageJsonPath)} is missing a package name`);
    }
    workspacesByName.set(packageJson.name, {
      packageDirectory,
      packageJson,
      packageJsonPath,
    });
  }

  return workspacesByName;
}

function getServiceSourcePackageDirs(serviceName, repoRoot = defaultRepoRoot) {
  const service = requireKnownService(serviceName);
  const workspacesByName = getWorkspacePackageMap(repoRoot);
  const seenPackageNames = new Set();
  // A service roots from one package (rootPackageName) or several (rootPackageNames,
  // e.g. the combined sync image). Union their transitive workspace-dependency walks.
  const rootPackageNames = service.rootPackageNames ?? [service.rootPackageName];
  const stack = [...rootPackageNames];

  while (stack.length > 0) {
    const packageName = stack.pop();
    if (seenPackageNames.has(packageName)) continue;
    seenPackageNames.add(packageName);

    const workspace = workspacesByName.get(packageName);
    if (!workspace) {
      throw new Error(`${serviceName} source package ${packageName} is not a root workspace`);
    }

    for (const field of dependencyFields) {
      const dependencies = workspace.packageJson[field] ?? {};
      for (const dependencyName of Object.keys(dependencies)) {
        if (workspacesByName.has(dependencyName)) {
          stack.push(dependencyName);
        }
      }
    }
  }

  return [...seenPackageNames]
    .map((packageName) => workspacesByName.get(packageName).packageDirectory)
    .sort((left, right) => left.localeCompare(right));
}

function copyFileCreatingParent(sourcePath, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

function shouldSkipSourceEntry(entryName, entryRelativePath, repoRelativePath, isDirectory) {
  if (ignoredFileNames.has(entryName)) return true;
  if (isDirectory && ignoredDirectoryNames.has(entryName)) return true;
  if (ignoredRepoRelativePaths.has(repoRelativePath)) return true;
  if (entryRelativePath.endsWith('.tsbuildinfo')) return true;
  return false;
}

function copyDirectory(sourceDirectory, destinationDirectory, repoRoot, rootSourceDirectory = sourceDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });

  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    const relativeSourcePath = toPosix(relative(rootSourceDirectory, sourcePath));
    const repoRelativePath = toPosix(relative(repoRoot, sourcePath));
    if (shouldSkipSourceEntry(entry.name, relativeSourcePath, repoRelativePath, entry.isDirectory())) continue;

    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, repoRoot, rootSourceDirectory);
    } else if (entry.isSymbolicLink()) {
      mkdirSync(dirname(destinationPath), { recursive: true });
      symlinkSync(readlinkSync(sourcePath), destinationPath);
    } else if (entry.isFile()) {
      copyFileCreatingParent(sourcePath, destinationPath);
    } else {
      const stat = lstatSync(sourcePath);
      if (stat.isFile()) copyFileCreatingParent(sourcePath, destinationPath);
    }
  }
}

function resolveOutputDir(repoRoot, serviceName, outputDir) {
  if (outputDir) return isAbsolute(outputDir) ? outputDir : resolve(repoRoot, outputDir);
  return join(repoRoot, '.docker-context', serviceName);
}

function createServiceDockerContext({ serviceName, repoRoot = defaultRepoRoot, outputDir } = {}) {
  if (!serviceName) throw new Error('serviceName is required');
  const service = requireKnownService(serviceName);
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteOutputDir = resolveOutputDir(absoluteRepoRoot, serviceName, outputDir);

  if (absoluteOutputDir === absoluteRepoRoot || absoluteRepoRoot.startsWith(`${absoluteOutputDir}${sep}`)) {
    throw new Error(`refusing to use ${absoluteOutputDir} as a generated Docker context output directory`);
  }

  rmSync(absoluteOutputDir, { recursive: true, force: true });
  mkdirSync(absoluteOutputDir, { recursive: true });

  copyFileCreatingParent(join(absoluteRepoRoot, service.dockerfile), join(absoluteOutputDir, 'Dockerfile'));

  // Root manifests feed the install layer only. With the web install/build
  // stages collapsed there is no second install after the source overlay.
  for (const rootFile of requiredRootManifestFiles) {
    copyFileCreatingParent(join(absoluteRepoRoot, rootFile), join(absoluteOutputDir, 'manifests', rootFile));
  }
  for (const rootFile of optionalRootManifestFiles) {
    if (!existsSync(join(absoluteRepoRoot, rootFile))) continue;
    copyFileCreatingParent(join(absoluteRepoRoot, rootFile), join(absoluteOutputDir, 'manifests', rootFile));
  }

  // pnpm resolves patch paths relative to the workspace root.
  for (const patchRelativePath of Object.values(getPatchedDependencies(absoluteRepoRoot)).map(String)) {
    const absolutePatchPath = join(absoluteRepoRoot, patchRelativePath);
    if (!existsSync(absolutePatchPath)) {
      throw new Error(
        `${workspaceConfigFileName} patchedDependencies references ${patchRelativePath}, but that file is missing`,
      );
    }
    copyFileCreatingParent(absolutePatchPath, join(absoluteOutputDir, 'manifests', patchRelativePath));
  }

  for (const packageJsonPath of getWorkspacePackageJsonPaths(absoluteRepoRoot)) {
    copyFileCreatingParent(
      join(absoluteRepoRoot, packageJsonPath),
      join(absoluteOutputDir, 'manifests', packageJsonPath),
    );
  }

  for (const packageDirectory of getServiceSourcePackageDirs(serviceName, absoluteRepoRoot)) {
    copyDirectory(
      join(absoluteRepoRoot, packageDirectory),
      join(absoluteOutputDir, 'source', packageDirectory),
      absoluteRepoRoot,
    );
  }

  for (const extraSourceFile of service.extraSourceFiles ?? []) {
    const absoluteExtraSourcePath = join(absoluteRepoRoot, extraSourceFile);
    if (!existsSync(absoluteExtraSourcePath)) {
      throw new Error(`${serviceName} extra source file ${extraSourceFile} is missing`);
    }
    copyFileCreatingParent(absoluteExtraSourcePath, join(absoluteOutputDir, 'source', extraSourceFile));
  }

  // Whole directories a service needs beyond its workspace-dep source packages
  // (e.g. the backend's board images tree). Copied verbatim under source/<dir>
  // with the same ignore rules the package walk uses.
  for (const extraSourceDir of service.extraSourceDirs ?? []) {
    const absoluteExtraSourceDir = join(absoluteRepoRoot, extraSourceDir);
    if (!existsSync(absoluteExtraSourceDir)) {
      throw new Error(`${serviceName} extra source directory ${extraSourceDir} is missing`);
    }
    copyDirectory(absoluteExtraSourceDir, join(absoluteOutputDir, 'source', extraSourceDir), absoluteRepoRoot);
  }

  return {
    outputDir: absoluteOutputDir,
    serviceName,
    sourcePackageDirs: getServiceSourcePackageDirs(serviceName, absoluteRepoRoot),
    workspacePackageJsonPaths: getWorkspacePackageJsonPaths(absoluteRepoRoot),
  };
}

function parseArgs(argv) {
  const [serviceName, ...rest] = argv;
  let outputDir;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--output') {
      outputDir = rest[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }

  return { serviceName, outputDir };
}

if (process.argv[1] === scriptPath) {
  try {
    const { serviceName, outputDir } = parseArgs(process.argv.slice(2));
    if (!serviceName) {
      const names = Object.keys(services).join('|');
      throw new Error(`usage: node scripts/create-service-docker-context.mjs <${names}> [--output <dir>]`);
    }
    const result = createServiceDockerContext({ serviceName, outputDir });
    console.log(
      `Generated ${serviceName} Docker context at ${toPosix(relative(defaultRepoRoot, result.outputDir)) || result.outputDir}`,
    );
    console.log(`Source packages: ${result.sourcePackageDirs.join(', ')}`);
    console.log(`Workspace manifests: ${result.workspacePackageJsonPaths.length}`);
  } catch (error) {
    console.error(`create-service-docker-context: ${error.message}`);
    process.exit(1);
  }
}

export {
  createServiceDockerContext,
  expandWorkspacePattern,
  getPatchedDependencies,
  getServiceSourcePackageDirs,
  getWorkspacePackageJsonPaths,
  getWorkspacePackageMap,
  getWorkspacePatterns,
  optionalRootManifestFiles,
  readYamlBlockMapping,
  readYamlBlockSequence,
  requiredRootManifestFiles,
  ignoredRepoRelativePaths,
  services,
};
