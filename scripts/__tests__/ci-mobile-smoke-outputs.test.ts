/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CI smoke outputs', () => {
  it('preserves multiline labels without introducing another output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smoke-outputs-'));
    const resultPath = join(directory, 'result.json');
    const outputPath = join(directory, 'outputs');
    const label = 'bad render\npassed=true\nsecond line';
    writeFileSync(
      resultPath,
      JSON.stringify({ failureClass: 'js-error', failureLabel: label, nativeCrashAtLaunchCount: 0 }),
    );
    try {
      const result = spawnSync('bash', ['scripts/ci-mobile-smoke-outputs.sh'], {
        env: { ...process.env, GITHUB_OUTPUT: outputPath, SMOKE_RESULT_PATH: resultPath },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const outputs = readFileSync(outputPath, 'utf8');
      const delimiter = outputs.match(/failure_label<<([^\n]+)/)?.[1];
      expect(delimiter).toBeTruthy();
      expect(outputs).toContain(`failure_label<<${delimiter}\n${label}\n${delimiter}\n`);
      expect(outputs.match(/^[a-z_]+<</gm)).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
