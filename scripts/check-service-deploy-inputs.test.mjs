import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServiceDeployInputFailures } from './check-service-deploy-inputs.mjs';

function writeFixtureFile(repoRoot, relativePath, contents) {
  const absolutePath = join(repoRoot, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

function writePackage(repoRoot, directory, packageJson) {
  writeFixtureFile(repoRoot, `${directory}/package.json`, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFixtureFile(repoRoot, `${directory}/src/index.ts`, 'export {};\n');
}

function createFixtureRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'boardsesh-service-check-fixture-'));
  writeFixtureFile(
    repoRoot,
    'package.json',
    `${JSON.stringify({ workspaces: ['packages/*', 'packages/shared/*'] }, null, 2)}\n`,
  );
  writeFixtureFile(repoRoot, 'bun.lock', '');
  writeFixtureFile(repoRoot, '.dockerignore', '**/node_modules\n**/dist\n.docker-context\n');
  writeFixtureFile(repoRoot, 'railway.toml', '[deploy]\nstartCommand = "echo ok"\n');

  writePackage(repoRoot, 'packages/backend', {
    name: 'boardsesh-backend',
    dependencies: { '@boardsesh/shared-lib': 'workspace:*' },
    devDependencies: { '@boardsesh/dev-only': 'workspace:*' },
  });
  writePackage(repoRoot, 'packages/web', {
    name: '@boardsesh/web',
    dependencies: { '@boardsesh/ui-lib': 'workspace:*' },
  });
  writePackage(repoRoot, 'packages/mobile', { name: '@boardsesh/mobile' });
  writePackage(repoRoot, 'packages/new-workspace', { name: '@boardsesh/new-workspace' });
  writePackage(repoRoot, 'packages/shared/shared-lib', { name: '@boardsesh/shared-lib' });
  writePackage(repoRoot, 'packages/shared/ui-lib', { name: '@boardsesh/ui-lib' });
  writePackage(repoRoot, 'packages/shared/dev-only', { name: '@boardsesh/dev-only' });

  const dockerfile = [
    'FROM node:22-alpine',
    'COPY manifests/package.json manifests/bun.lock ./',
    'COPY manifests/packages ./packages',
    'RUN bun install --frozen-lockfile',
    'COPY source/packages ./packages',
    '',
  ].join('\n');
  writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfile);
  writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfile);

  writeFixtureFile(
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    [
      'run: case "$file" in packages/*|Dockerfile.backend|scripts/create-service-docker-context.mjs|bun.lock|package.json)',
      'run: vp run docker-context:web',
      'context: .docker-context/web',
      'file: .docker-context/web/Dockerfile',
      'run: vp run docker-context:backend',
      'context: .docker-context/backend',
      'file: .docker-context/backend/Dockerfile',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    repoRoot,
    '.github/workflows/production-deploy.yml',
    [
      'concurrency:',
      '  group: production-deploy',
      '  cancel-in-progress: false',
      'run: case "$file" in packages/*|Dockerfile.backend|scripts/create-service-docker-context.mjs|scripts/railway-deployment-status.mjs|railway.toml|bun.lock|package.json|.github/workflows/production-deploy.yml)',
      'run: vp run docker-context:backend',
      'context: .docker-context/backend',
      'file: .docker-context/backend/Dockerfile',
      'node scripts/railway-deployment-status.mjs capture-previous railway-before.json',
      'node scripts/railway-deployment-status.mjs find-new railway-deployments.json',
      'deploymentRollback',
      '',
    ].join('\n'),
  );
  writeFixtureFile(repoRoot, '.github/workflows/e2e-tests.yml', 'find packages -type d -name dist -prune\n');

  return repoRoot;
}

function withFixtureRepo(callback) {
  const repoRoot = createFixtureRepo();
  try {
    callback(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

void test('passes for generated Docker context inputs, including newly added workspaces', () => {
  withFixtureRepo((repoRoot) => {
    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('rejects hand-maintained workspace manifest COPY lines in Dockerfiles', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'Dockerfile.backend',
      [
        'FROM node:22-alpine',
        'COPY manifests/package.json manifests/bun.lock ./',
        'COPY manifests/packages ./packages',
        'COPY packages/backend/package.json ./packages/backend/',
        'RUN bun install --frozen-lockfile',
        'COPY source/packages ./packages',
        '',
      ].join('\n'),
    );

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /Workspace manifest copies must be generated/);
  });
});

void test('rejects patchedDependencies without a patches COPY in the install layer', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'package.json',
      `${JSON.stringify(
        {
          workspaces: ['packages/*', 'packages/shared/*'],
          patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' },
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /missing COPY manifests\/patches \.\/patches/);
  });
});

void test('passes when patchedDependencies are wired into the install layer', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'package.json',
      `${JSON.stringify(
        {
          workspaces: ['packages/*', 'packages/shared/*'],
          patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' },
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');

    const dockerfile = [
      'FROM node:22-alpine',
      'COPY manifests/package.json manifests/bun.lock ./',
      'COPY manifests/packages ./packages',
      'COPY manifests/patches ./patches',
      'RUN bun install --frozen-lockfile',
      'COPY source/packages ./packages',
      '',
    ].join('\n');
    writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfile);

    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('rejects source package COPY instructions before bun install', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'Dockerfile.web',
      [
        'FROM node:22-alpine',
        'COPY packages/ ./packages/',
        'COPY manifests/package.json manifests/bun.lock ./',
        'COPY manifests/packages ./packages',
        'RUN bun install --frozen-lockfile',
        'COPY source/packages ./packages',
        '',
      ].join('\n'),
    );

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /appears before bun install/);
  });
});

void test('passes when Dockerfile.sync and the sync packages are present', () => {
  withFixtureRepo((repoRoot) => {
    // Dockerfile.sync is optional, so the base fixture skips it. Add the sync
    // workspaces the `sync` service roots from plus a valid Dockerfile.sync so
    // the optional sync validation (requireDockerContextFile + the generated
    // `sync` context) actually runs and is asserted green.
    writePackage(repoRoot, 'packages/kilter-sync', {
      name: '@boardsesh/kilter-sync',
      dependencies: { '@boardsesh/shared-lib': 'workspace:*' },
    });
    writePackage(repoRoot, 'packages/aurora-sync', { name: '@boardsesh/aurora-sync' });
    writePackage(repoRoot, 'packages/moonboard-sync', { name: '@boardsesh/moonboard-sync' });

    const dockerfile = [
      'FROM node:22-alpine',
      'COPY manifests/package.json manifests/bun.lock ./',
      'COPY manifests/packages ./packages',
      'RUN bun install --frozen-lockfile',
      'COPY source/packages ./packages',
      '',
    ].join('\n');
    writeFixtureFile(repoRoot, 'Dockerfile.sync', dockerfile);

    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});
