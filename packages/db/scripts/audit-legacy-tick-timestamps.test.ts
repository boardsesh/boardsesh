import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CliUsageError,
  EXPLICIT_OFFSET_SUFFIX_FIX_SOURCE_REVISION,
  JSON_BUG_INTRO_SOURCE_REVISION,
  JSON_IMPORT_MOVE_SOURCE_REVISION,
  JSON_NAIVE_UTC_FIX_SOURCE_REVISION,
  LEGACY_WEB_SAVE_ASCENT_NORMALIZER_FIX_SOURCE_REVISION,
  LIVE_PULL_SHARED_NORMALIZER_FIX_SOURCE_REVISION,
  AUDIT_SCAN_QUERY,
  buildAuditSummary,
  parseArgs,
  parseDatabaseRow,
  runAuditCommand,
  validateOutputPath,
  writeAuditArtifact,
} from './audit-legacy-tick-timestamps.js';

function validArgs(outputPath: string): string[] {
  return [
    '--output',
    outputPath,
    '--policy-id',
    'verified-deploy-test',
    '--live-old-code-active-through',
    '2026-07-08T00:00:00Z',
    '--live-fixed-code-active-from',
    '2026-07-08T01:00:00Z',
    '--json-old-code-active-through',
    '2026-07-08T00:00:00Z',
    '--json-fixed-code-active-from',
    '2026-07-08T01:00:00Z',
    '--origin-writers-active-from',
    '2026-07-08T01:00:00Z',
    '--native-safe-generation-active-from',
    '2026-07-08T01:00:00Z',
  ];
}

async function withProcessEnvironment(name: string, replacement: string, action: () => Promise<void>): Promise<void> {
  const original = process.env[name];
  process.env[name] = replacement;
  try {
    await action();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

void describe('legacy timestamp audit CLI', () => {
  void it('parses a complete verified deployment policy', () => {
    const parsed = parseArgs(validArgs('/tmp/audit.jsonl'));
    assert.equal(parsed.outputPath, '/tmp/audit.jsonl');
    assert.equal(parsed.policy.policyId, 'verified-deploy-test');
    assert.ok(parsed.policy.liveOldCodeActiveThroughEpochSeconds < parsed.policy.liveFixedCodeActiveFromEpochSeconds);
  });

  void it("tolerates vp's standalone argument separator", () => {
    assert.deepEqual(parseArgs(['--', ...validArgs('/tmp/a.jsonl')]), parseArgs(validArgs('/tmp/a.jsonl')));
  });

  void it('rejects apply, unknown, duplicate, missing and stdout arguments', () => {
    assert.throws(() => parseArgs(['--apply', ...validArgs('/tmp/a.jsonl')]), /permanently audit-only/);
    assert.throws(() => parseArgs([...validArgs('/tmp/a.jsonl'), '--mystery', 'x']), /Unknown argument/);
    assert.throws(
      () => parseArgs([...validArgs('/tmp/a.jsonl'), '--output', '/tmp/b.jsonl']),
      /only be specified once/,
    );
    assert.throws(() => parseArgs(validArgs('/tmp/a.jsonl').slice(0, -1)), /requires a value/);
    assert.throws(() => parseArgs(validArgs('-')), /not stdout/);
    assert.throws(() => parseArgs(validArgs('/dev/stdout')), /not stdout/);
    assert.throws(() => parseArgs(validArgs('/dev/fd/1')), /not stdout/);
  });

  void it('requires explicit timezone offsets and a non-overlapping rollout window', () => {
    const missingZone = validArgs('/tmp/a.jsonl');
    missingZone[missingZone.indexOf('--live-fixed-code-active-from') + 1] = '2026-07-08 01:00:00';
    assert.throws(() => parseArgs(missingZone), /explicit Z/);

    const overlap = validArgs('/tmp/a.jsonl');
    overlap[overlap.indexOf('--live-old-code-active-through') + 1] = '2026-07-08T02:00:00Z';
    assert.throws(() => parseArgs(overlap), /must precede/);

    const jsonOverlap = validArgs('/tmp/a.jsonl');
    jsonOverlap[jsonOverlap.indexOf('--json-old-code-active-through') + 1] = '2026-07-08T02:00:00Z';
    assert.throws(() => parseArgs(jsonOverlap), /json-old-code-active-through must precede/);
  });

  void it('does not allow native proposal eligibility before origin writers were verified active', () => {
    const unsafe = validArgs('/tmp/a.jsonl');
    unsafe[unsafe.indexOf('--native-safe-generation-active-from') + 1] = '2026-07-08T00:30:00Z';
    assert.throws(() => parseArgs(unsafe), /must not precede/);
  });

  void it('suppresses every effective proposal when a post-fix control invariant fails', () => {
    const summary = buildAuditSummary({
      scannedRows: 20,
      groups: 10,
      anchors: 10,
      edges: 7,
      correctionEvidence: 6,
      postFixInvariantViolations: 1,
      alignedControls: 5,
      ambiguousAbstentions: 0,
      heuristicOnlyAnchorAbstentions: 0,
      candidateTimestampUnverifiedAbstentions: 0,
      kilterTimestampUnverifiedAnchorAbstentions: 0,
      nativeTimestampUnverifiedAnchorAbstentions: 5,
      noAnchorAbstentions: 3,
      rolloutUncertainAbstentions: 0,
    });
    assert.equal(summary.proposals_suppressed, true);
    assert.equal(summary.effective_correction_proposals, 0);
    assert.equal(summary.post_fix_control_invariant, 'failed');
    assert.equal((summary.counts as Record<string, unknown>).nativeTimestampUnverifiedAnchorAbstentions, 5);
  });

  void it('projects native equality and Kilter sync evidence while scanning every native row', () => {
    assert.match(AUDIT_SCAN_QUERY, /\(created_at = updated_at\) AS "createdAtEqualsUpdatedAt"/);
    assert.match(AUDIT_SCAN_QUERY, /kilter_synced_at AT TIME ZONE 'UTC'/);
    assert.match(AUDIT_SCAN_QUERY, /origin IN \('json_import', 'aurora_pull', 'kilter_pull', 'native'\)/);
    assert.doesNotMatch(AUDIT_SCAN_QUERY, /\$\d+/);
    const parsed = parseDatabaseRow({
      angle: 40,
      attemptCount: 2,
      auroraIdIsSyntheticJson: false,
      auroraSyncedAtEpochSeconds: null,
      boardType: 'kilter',
      climbedAtEpochSeconds: 100,
      climbUuid: 'climb',
      createdAtEpochSeconds: 200,
      createdAtEqualsUpdatedAt: true,
      id: '1',
      isMirror: false,
      kilterDetachedAtEpochSeconds: null,
      kilterSyncedAtEpochSeconds: 199,
      origin: 'native',
      status: 'send',
      updatedAtEpochSeconds: 200,
      userId: 'user',
      uuid: 'tick',
    });
    assert.equal(parsed.createdAtEqualsUpdatedAt, true);
    assert.equal(parsed.kilterSyncedAtEpochSeconds, 199);
  });

  void it('records each timestamp-normalizer revision under its distinct historical role', () => {
    assert.equal(JSON_BUG_INTRO_SOURCE_REVISION, '8fe79f60dd017180d325ba3501a8a2a96f7fcb28');
    assert.equal(JSON_NAIVE_UTC_FIX_SOURCE_REVISION, '79185b916800b866173da01e4ec34743b0015218');
    assert.equal(JSON_IMPORT_MOVE_SOURCE_REVISION, '45cef340a8055d5c263fac3d863dcf82886fb47b');
    assert.equal(LIVE_PULL_SHARED_NORMALIZER_FIX_SOURCE_REVISION, '71937db6a372ececfe4fa543978ea5cd3bd78a88');
    assert.equal(EXPLICIT_OFFSET_SUFFIX_FIX_SOURCE_REVISION, 'ad4b39c086b3e2b091bf1d16e5e529fe012d2cf1');
    assert.equal(LEGACY_WEB_SAVE_ASCENT_NORMALIZER_FIX_SOURCE_REVISION, 'cdf1406dfb53f1865513fd005d39b13f469a74e1');
  });
});

void describe('JSONL output safety', () => {
  void it('rejects existing and symlink output targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-output-'));
    const existing = join(directory, 'existing.jsonl');
    const symlinkPath = join(directory, 'symlink.jsonl');
    await writeFile(existing, 'do not overwrite');
    await symlink(existing, symlinkPath);
    await assert.rejects(validateOutputPath(existing, directory), /existing output path/);
    await assert.rejects(validateOutputPath(symlinkPath, directory), /symlink output path/);
  });

  void it('rejects an invalid output before resolving any database configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-preflight-'));
    const existing = join(directory, 'existing.jsonl');
    await writeFile(existing, 'do not overwrite');
    await assert.rejects(runAuditCommand(parseArgs(validArgs(existing))), /existing output path/);
  });

  void it('rejects a tracked path even when the working-tree file is absent', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-repo-'));
    spawnSync('git', ['init', '-q'], { cwd: repository });
    const tracked = join(repository, 'report.jsonl');
    await writeFile(tracked, 'tracked');
    spawnSync('git', ['add', 'report.jsonl'], { cwd: repository });
    await unlink(tracked);
    await assert.rejects(validateOutputPath(tracked, repository), /tracked output path/);
  });

  void it('rejects a tracked output in the repository containing its parent even when cwd is another repository', async () => {
    const callerRepository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-caller-repo-'));
    const outputRepository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-output-repo-'));
    spawnSync('git', ['init', '-q'], { cwd: callerRepository });
    spawnSync('git', ['init', '-q'], { cwd: outputRepository });
    const tracked = join(outputRepository, 'external-report.jsonl');
    await writeFile(tracked, 'tracked');
    spawnSync('git', ['add', 'external-report.jsonl'], { cwd: outputRepository });
    await unlink(tracked);
    await assert.rejects(validateOutputPath(tracked, callerRepository), /tracked output path/);
  });

  void it('fails closed when the output parent has an indeterminate Git repository probe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-broken-repo-'));
    await writeFile(join(directory, '.git'), 'gitdir: /definitely/missing/boardsesh-audit-gitdir\n');
    await assert.rejects(validateOutputPath(join(directory, 'report.jsonl'), directory), /Could not determine Git/);
  });

  void it('ignores an inherited Git ceiling that would hide the containing repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-ceiling-repo-'));
    spawnSync('git', ['init', '-q'], { cwd: repository });
    const nestedDirectory = join(repository, 'nested');
    await mkdir(nestedDirectory);
    const tracked = join(nestedDirectory, 'report.jsonl');
    await writeFile(tracked, 'tracked');
    spawnSync('git', ['add', 'nested/report.jsonl'], { cwd: repository });
    await unlink(tracked);
    await withProcessEnvironment('GIT_CEILING_DIRECTORIES', repository, async () => {
      await assert.rejects(validateOutputPath(tracked, nestedDirectory), /tracked output path/);
    });
  });

  void it('ignores an inherited alternate Git index that would hide a tracked output', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-index-repo-'));
    spawnSync('git', ['init', '-q'], { cwd: repository });
    const tracked = join(repository, 'report.jsonl');
    await writeFile(tracked, 'tracked');
    spawnSync('git', ['add', 'report.jsonl'], { cwd: repository });
    await unlink(tracked);
    await withProcessEnvironment('GIT_INDEX_FILE', join(repository, 'empty-alternate-index'), async () => {
      await assert.rejects(validateOutputPath(tracked, repository), /tracked output path/);
    });
  });

  void it('treats pathspec-magic output filenames literally', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-pathspec-repo-'));
    spawnSync('git', ['init', '-q'], { cwd: repository });
    const filename = ':(literal)report.jsonl';
    const tracked = join(repository, filename);
    await writeFile(tracked, 'tracked');
    spawnSync('git', ['--literal-pathspecs', 'add', '--', filename], { cwd: repository });
    await unlink(tracked);
    await assert.rejects(validateOutputPath(tracked, repository), /tracked output path/);
  });

  void it('allows a real non-repository output only after conclusive repository discovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-non-repo-'));
    const output = join(directory, 'report.jsonl');
    assert.equal(await validateOutputPath(output, directory), output);
  });

  void it('publishes atomically, hashes canonical records, and excludes the runtime footer from the digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-artifact-'));
    const first = join(directory, 'first.jsonl');
    const second = join(directory, 'second.jsonl');
    const firstResult = await writeAuditArtifact(
      first,
      async (sink) => {
        await sink.writeCanonicalRecord({ z: 2, a: 1, type: 'test' });
        return { duration_ms: 10, run_id: 'first-run' };
      },
      { cwd: directory, completedAt: () => '2026-01-01T00:00:00.000Z' },
    );
    const secondResult = await writeAuditArtifact(
      second,
      async (sink) => {
        await sink.writeCanonicalRecord({ a: 1, type: 'test', z: 2 });
        return { duration_ms: 99, run_id: 'second-run' };
      },
      { cwd: directory, completedAt: () => '2027-01-01T00:00:00.000Z' },
    );
    assert.equal(firstResult.digest, secondResult.digest, 'runtime footer must not affect the records digest');
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    const lines = (await readFile(first, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '{"a":1,"type":"test","z":2}');
    assert.equal(JSON.parse(lines[1]).type, 'records_digest');
    assert.equal(JSON.parse(lines[2]).type, 'runtime_footer');
  });

  void it('leaves no requested output or partial file when production fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-failure-'));
    const output = join(directory, 'failed.jsonl');
    await assert.rejects(
      writeAuditArtifact(
        output,
        async (sink) => {
          await sink.writeCanonicalRecord({ type: 'before_failure' });
          throw new Error('fixture failure');
        },
        { cwd: directory },
      ),
      /fixture failure/,
    );
    assert.equal(await readdir(directory).then((entries) => entries.length), 0);
  });

  void it('rejects unsafe fields before publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boardsesh-tick-audit-privacy-'));
    await assert.rejects(
      writeAuditArtifact(
        join(directory, 'unsafe.jsonl'),
        async (sink) => {
          await sink.writeCanonicalRecord({ type: 'unsafe', userId: 'raw-user' });
          return {};
        },
        { cwd: directory },
      ),
      /forbidden raw field/,
    );
  });

  void it('surfaces usage errors as a dedicated type', () => {
    assert.throws(() => parseArgs([]), CliUsageError);
  });
});
