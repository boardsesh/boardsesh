/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) throw new Error(`missing ${key} mapping`);

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join('\n');
}

describe('PR workflow capacity controls', () => {
  it.each([
    ['claude-code-review.yml', 'cancel-in-progress: true'],
    ['dev-db-docker.yml', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
    ['service-deploy-inputs.yml', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
    ['postgres-image-publisher-contract.yml', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
    ['firmware-tests.yml', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"],
  ])('cancels superseded PR-head runs in %s', (name, cancellation) => {
    const source = workflow(name);
    expect(source).toContain('concurrency:');
    expect(source).toContain(cancellation);
  });

  it('caps every PR test matrix without serializing main', () => {
    const source = workflow('ci.yml');
    const defaultTests = mappingEntry(source, 'test-default', 2);
    const backendTests = mappingEntry(source, 'test-backend', 2);
    expect(defaultTests).toContain("max-parallel: ${{ github.event_name == 'pull_request' && 2 || 3 }}");
    expect(backendTests).toContain("max-parallel: ${{ github.event_name == 'pull_request' && 1 || 2 }}");
  });

  it('runs iOS CI once per PR instead of duplicating every branch push', () => {
    const source = workflow('ios-rn-ci.yml');
    const trigger = source.slice(0, source.indexOf('concurrency:'));
    expect(trigger).toContain('  pull_request:');
    expect(trigger).not.toContain('  push:');
    expect(source).toContain('group: ios-rn-ci-${{ github.head_ref || github.ref_name }}');
  });
});

describe('heavy job path filters', () => {
  it('does not treat database and sync packages as mobile dependencies', () => {
    const source = workflow('ci.yml');
    const changes = mappingEntry(source, 'changes', 2);
    const mobileDependencies = mappingEntry(changes, 'mobileDeps', 12);
    const mobileBundle = mappingEntry(source, 'mobile-bundle', 2);

    expect(mobileDependencies).toContain("- 'packages/shared/**'");
    expect(mobileDependencies).toContain("- 'packages/shared-schema/**'");
    expect(mobileDependencies).toContain("- 'packages/board-constants/**'");
    expect(mobileDependencies).not.toContain('packages/db');
    expect(mobileDependencies).not.toContain('packages/sync-runtime');
    expect(mobileBundle).toContain("needs.changes.outputs.mobileDeps == 'true'");
    expect(mobileBundle).not.toContain("needs.changes.outputs.sharedDeps == 'true'");
  });

  it('runs OCR only for OCR or CI workflow changes', () => {
    const ocr = mappingEntry(workflow('ci.yml'), 'test-ocr', 2);
    expect(ocr).toContain("needs.changes.outputs.ocr == 'true'");
    expect(ocr).not.toContain("needs.changes.outputs.sharedDeps == 'true'");
  });

  it('does not start iOS native CI for a root test-config edit', () => {
    const source = workflow('ios-rn-ci.yml');
    expect(source).not.toContain("- 'vite.config.ts'");
    expect(source).toContain("- 'scripts/mobile-framework-abi-check.ts'");
  });

  it('limits dev-database image rebuilds to scripts executed by the image', () => {
    const source = workflow('dev-db-docker.yml');
    expect(source).not.toContain("- 'packages/db/scripts/**'");
    expect(source).not.toContain("- 'vite.config.ts'");
    expect(source).toContain("- 'scripts/postgres18-contract.sh'");
    for (const seedScript of [
      'create-test-user.ts',
      'db-connection.ts',
      'load-board-snapshots.ts',
      'seed-playlist-climbs.ts',
      'seed-social.ts',
    ]) {
      expect(source).toContain(`- 'packages/db/scripts/${seedScript}'`);
    }
  });

  it('keeps the lightweight Vite+ task wired to the extracted database contract', () => {
    const viteConfig = readFileSync('vite.config.ts', 'utf8');
    expect(viteConfig).toContain(
      "'test:postgres18-contract': {\n        command: 'bash scripts/postgres18-contract.sh',",
    );
    expect(viteConfig).toContain(
      "'check:service-deploy-inputs': {\n        command: 'node scripts/check-service-deploy-inputs.mjs',",
    );
    expect(workflow('service-deploy-inputs.yml')).not.toContain("- 'vite.config.ts'");
  });

  it('treats root task additions as JavaScript changes, not every CI domain', () => {
    const changes = mappingEntry(workflow('ci.yml'), 'changes', 2);
    const rootCi = mappingEntry(changes, 'rootCi', 12);
    expect(rootCi).not.toContain("- 'vite.config.ts'");
    expect(mappingEntry(changes, 'anyJs', 12)).toContain("- '**/*.ts'");
  });
});
