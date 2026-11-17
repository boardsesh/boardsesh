import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
};
type BenchmarkWorkflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<
    string,
    {
      if: string;
      environment: string;
      'runs-on': string;
      'timeout-minutes': number;
      steps: WorkflowStep[];
    }
  >;
};

const workflowText = readFileSync('.github/workflows/benchmark-next-static-assets.yml', 'utf8');
const workflow = parse(workflowText) as BenchmarkWorkflow;
const benchmark = workflow.jobs.benchmark;

describe('Next static asset benchmark trust boundary', () => {
  it('requires a manual dispatch of trusted main without registry write permission', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.jobs)).toEqual(['benchmark']);
    expect(benchmark.if).toBe("github.repository == 'boardsesh/boardsesh' && github.ref == 'refs/heads/main'");
    expect(benchmark.environment).toBe('Production');
    expect(benchmark['runs-on']).toBe('ubuntu-latest');
    expect(benchmark['timeout-minutes']).toBe(30);
    expect(workflow.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'benchmark-next-static-assets', 'cancel-in-progress': false });
    expect(benchmark.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toEqual({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
  });

  it.each([
    [`sha256:${'a'.repeat(64)}`, true],
    ['production', false],
    [`sha256:${'A'.repeat(64)}`, false],
    [`sha256:${'a'.repeat(63)}`, false],
    [`sha256:${'a'.repeat(64)}\n`, false],
    ['$(printf injected)', false],
    ['other/image@sha256:' + 'a'.repeat(64), false],
  ])('validates digest input before any image operation: %s', (digest, valid) => {
    const validation = benchmark.steps[0];
    expect(validation.env).toEqual({ BENCHMARK_IMAGE_DIGEST: '${{ inputs.image_digest }}' });
    expect(validation.run).not.toContain('${{');
    const execution = spawnSync('bash', ['-c', validation.run!], {
      env: { BENCHMARK_IMAGE_DIGEST: digest },
      encoding: 'utf8',
    });
    expect(execution.status).toBe(valid ? 0 : 1);
    expect(execution.stdout).not.toContain('injected');
  });

  it('only extracts the fixed repository image and passes storage secrets to the benchmark', () => {
    const extraction = benchmark.steps.find((step) => step.name === 'Extract Next assets without starting the image');
    expect(extraction?.run).toContain('image="ghcr.io/boardsesh/boardsesh-web@$BENCHMARK_IMAGE_DIGEST"');
    expect(extraction?.run).toContain('docker create "$image"');
    expect(extraction?.run).toContain('docker cp "$asset_container:/app/packages/web/.next/static/."');
    const commands = benchmark.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/docker (?:run|start|push|tag)|imagetools|railway|cf:apply/);
    expect(commands).not.toContain('${{');
    const publication = benchmark.steps.find(
      (step) => step.name === 'Benchmark existing assets with the production publisher',
    );
    expect(publication?.run).toContain('vp exec tsx scripts/benchmark-next-static-assets.ts');
    expect(publication?.env).toEqual({
      BENCHMARK_IMAGE_DIGEST: '${{ inputs.image_digest }}',
      STATIC_ASSETS_S3_BUCKET_NAME: '${{ secrets.STATIC_ASSETS_S3_BUCKET_NAME }}',
      STATIC_ASSETS_AWS_ACCESS_KEY_ID: '${{ secrets.STATIC_ASSETS_AWS_ACCESS_KEY_ID }}',
      STATIC_ASSETS_AWS_SECRET_ACCESS_KEY: '${{ secrets.STATIC_ASSETS_AWS_SECRET_ACCESS_KEY }}',
      STATIC_ASSETS_AWS_ENDPOINT_URL: '${{ secrets.STATIC_ASSETS_AWS_ENDPOINT_URL }}',
      STATIC_ASSETS_AWS_REGION: '${{ secrets.STATIC_ASSETS_AWS_REGION }}',
    });
    expect([...new Set(workflowText.match(/secrets\.[A-Z0-9_]+/g))].sort()).toEqual([
      'secrets.GITHUB_TOKEN',
      'secrets.STATIC_ASSETS_AWS_ACCESS_KEY_ID',
      'secrets.STATIC_ASSETS_AWS_ENDPOINT_URL',
      'secrets.STATIC_ASSETS_AWS_REGION',
      'secrets.STATIC_ASSETS_AWS_SECRET_ACCESS_KEY',
      'secrets.STATIC_ASSETS_S3_BUCKET_NAME',
    ]);
  });

  it('retains only the benchmark JSON even after failure', () => {
    const upload = benchmark.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path).toBe('${{ runner.temp }}/next-static-benchmark.json');
    expect(upload?.with?.['if-no-files-found']).toBe('ignore');
    expect(upload?.with?.['retention-days']).toBe(14);
    expect(benchmark.steps.filter((step) => step.uses).every((step) => /@[a-f0-9]{40}$/.test(step.uses!))).toBe(true);
  });
});
