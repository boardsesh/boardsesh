import { describe, expect, it } from 'vitest';
import { resolveNativeBuildSource, type NativeSourceRuntime } from '../mobile-native-build-source';

const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const receipt = {
  schemaVersion: 1,
  platform: 'ios',
  sourceSha,
  workflowSha,
  sourceRunId: '123',
  version: '2.7.1',
  buildNumber: '9',
  buildTag: 'build-ios-v2.7.1-9-abcdef123456',
};
const run = {
  id: 123,
  path: '.github/workflows/ios-testflight-rn.yml',
  head_branch: 'main',
  head_repository: { full_name: 'boardsesh/boardsesh' },
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  head_sha: workflowSha,
  run_attempt: 2,
};
const runtime: NativeSourceRuntime = {
  readRun: () => run,
  readArtifact: () => receipt,
  tagCommit: () => sourceSha,
  isAncestor: () => true,
};

describe('uploaded native binary provenance', () => {
  it('pins a recovered binary independently of newer workflow tooling', () => {
    expect(resolveNativeBuildSource(runtime, '123', 'boardsesh/boardsesh')).toEqual(receipt);
  });
  it('does not mistake a green skipped native workflow for an uploaded binary', () => {
    expect(resolveNativeBuildSource({ ...runtime, readArtifact: () => null }, '123', 'boardsesh/boardsesh')).toBeNull();
  });
  it.each([
    { head_branch: 'release/next' },
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { path: '.github/workflows/ci.yml' },
    { head_repository: { full_name: 'fork/repo' } },
  ])('rejects untrusted native runs: %j', (invalid) => {
    expect(() =>
      resolveNativeBuildSource({ ...runtime, readRun: () => ({ ...run, ...invalid }) }, '123', 'boardsesh/boardsesh'),
    ).toThrow();
  });
  it.each([
    { workflowSha: sourceSha },
    { sourceRunId: '999' },
    { platform: 'android' },
    { sourceSha: 'main' },
    { buildNumber: '10' },
    { buildTag: 'fingerprint-ios-abcdef' },
  ])('rejects unrelated receipt identities: %j', (invalid) => {
    expect(() =>
      resolveNativeBuildSource(
        { ...runtime, readArtifact: () => ({ ...receipt, ...invalid }) },
        '123',
        'boardsesh/boardsesh',
      ),
    ).toThrow();
  });
  it('rejects a rewritten build tag or source outside main', () => {
    expect(() =>
      resolveNativeBuildSource({ ...runtime, tagCommit: () => workflowSha }, '123', 'boardsesh/boardsesh'),
    ).toThrow();
    expect(() =>
      resolveNativeBuildSource({ ...runtime, isAncestor: () => false }, '123', 'boardsesh/boardsesh'),
    ).toThrow();
  });
  it('requires pushed source and workflow commit to agree', () => {
    expect(() =>
      resolveNativeBuildSource(
        { ...runtime, readRun: () => ({ ...run, event: 'push' }) },
        '123',
        'boardsesh/boardsesh',
      ),
    ).toThrow('pushed source');
  });
});
