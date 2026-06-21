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
  },
  web: {
    dockerfile: 'Dockerfile.web',
    rootPackageName: '@boardsesh/web',
  },
  sync: {
    dockerfile: 'Dockerfile.sync',
    // All sync CLIs in one image. The source layer is the union of these roots'
    // transitive workspace deps; the daemon/CLI to run is chosen by the container
    // command, not baked into the image.
    rootPackageNames: ['@boardsesh/kilter-sync', '@boardsesh/aurora-sync', '@boardsesh/moonboard-sync'],
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

const toPosix = (filePath) => filePath.split(sep).join(posix.sep);
const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

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
  const rootPackage = readJson(join(repoRoot, 'package.json'));
  const workspaces = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  return [...new Set(workspaces.flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern)))].sort((left, right) =>
    left.localeCompare(right),
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

function shouldSkipSourceEntry(entryName, entryRelativePath, isDirectory) {
  if (ignoredFileNames.has(entryName)) return true;
  if (isDirectory && ignoredDirectoryNames.has(entryName)) return true;
  if (entryRelativePath.endsWith('.tsbuildinfo')) return true;
  return false;
}

function copyDirectory(sourceDirectory, destinationDirectory, rootSourceDirectory = sourceDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });

  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    const relativeSourcePath = toPosix(relative(rootSourceDirectory, sourcePath));
    if (shouldSkipSourceEntry(entry.name, relativeSourcePath, entry.isDirectory())) continue;

    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, rootSourceDirectory);
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

  for (const rootFile of ['package.json', 'bun.lock']) {
    copyFileCreatingParent(join(absoluteRepoRoot, rootFile), join(absoluteOutputDir, 'manifests', rootFile));
    copyFileCreatingParent(join(absoluteRepoRoot, rootFile), join(absoluteOutputDir, 'source', rootFile));
  }

  // Bun resolves `patchedDependencies` paths relative to the package.json that
  // declares them, so the install layer needs the patch files next to the copied
  // root manifest. Without them `bun install --frozen-lockfile` aborts with
  // "Couldn't find patch file" and the image build fails.
  const rootPackageJson = readJson(join(absoluteRepoRoot, 'package.json'));
  for (const patchRelativePath of Object.values(rootPackageJson.patchedDependencies ?? {}).map(String)) {
    const absolutePatchPath = join(absoluteRepoRoot, patchRelativePath);
    if (!existsSync(absolutePatchPath)) {
      throw new Error(`package.json patchedDependencies references ${patchRelativePath}, but that file is missing`);
    }
    copyFileCreatingParent(absolutePatchPath, join(absoluteOutputDir, 'manifests', patchRelativePath));
    copyFileCreatingParent(absolutePatchPath, join(absoluteOutputDir, 'source', patchRelativePath));
  }

  for (const packageJsonPath of getWorkspacePackageJsonPaths(absoluteRepoRoot)) {
    copyFileCreatingParent(
      join(absoluteRepoRoot, packageJsonPath),
      join(absoluteOutputDir, 'manifests', packageJsonPath),
    );
  }

  for (const packageDirectory of getServiceSourcePackageDirs(serviceName, absoluteRepoRoot)) {
    copyDirectory(join(absoluteRepoRoot, packageDirectory), join(absoluteOutputDir, 'source', packageDirectory));
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
  getServiceSourcePackageDirs,
  getWorkspacePackageJsonPaths,
  getWorkspacePackageMap,
  services,
};
