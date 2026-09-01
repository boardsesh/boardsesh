/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowDocument = {
  runs?: {
    steps?: WorkflowStep[];
  };
};

const CONNECT_ACTION = './.github/actions/connect-production-db';
const TAILSCALE_ACTION = 'tailscale/github-action@780049a30b6ff5c378a9e7b389d15ece7a204888';
const MIGRATION_ROLE = 'boardsesh_migrator';

const databaseWorkflowPaths = [
  '.github/workflows/production-deploy.yml',
  '.github/workflows/export-board-snapshots.yml',
  '.github/workflows/refresh-climb-grades.yml',
  '.github/workflows/refresh-content-model.yml',
  '.github/workflows/refresh-hold-features.yml',
  '.github/workflows/refresh-recommendations.yml',
];

function readYaml(path: string): WorkflowDocument {
  return parse(readFileSync(path, 'utf8')) as unknown as WorkflowDocument;
}

function validateRoute(databaseUrl: string, host: string, expectedRole = MIGRATION_ROLE): void {
  const result = spawnSync(process.execPath, ['scripts/validate-production-db-network-url.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL_INPUT: databaseUrl,
      EXPECTED_DATABASE_ROLE_INPUT: expectedRole,
      FORWARDER_HOST_INPUT: host,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr.trim());
}

describe('production database network workflow contract', () => {
  it.each(databaseWorkflowPaths)('keeps %s on the existing route until the staged cutover', (path) => {
    const workflowSource = readFileSync(path, 'utf8');
    expect(workflowSource).not.toContain(`uses: ${CONNECT_ACTION}`);
    expect(workflowSource).not.toMatch(/DATABASE_[A-Z_]*DIRECT_URL/);
  });

  it('pins workload identity to the reviewed action, client, and CI tag', () => {
    const action = readYaml('.github/actions/connect-production-db/action.yml');
    const steps = action.runs?.steps ?? [];
    const tailscaleStep = steps.find((step) => step.uses === TAILSCALE_ACTION);
    expect(tailscaleStep).toBeDefined();
    expect(tailscaleStep?.with).toEqual({
      'oauth-client-id': '${{ inputs.oauth-client-id }}',
      audience: '${{ inputs.audience }}',
      tags: 'tag:boardsesh-db-ci',
      version: '1.102.3',
      ping: '${{ inputs.forwarder-host }}',
    });

    const actionSource = readFileSync('.github/actions/connect-production-db/action.yml', 'utf8');
    expect(actionSource).not.toMatch(/oauth-secret|authkey/i);
    expect(actionSource).toContain('node "$GITHUB_WORKSPACE/scripts/validate-production-db-network-url.mjs"');
    expect(actionSource).not.toContain('tsx');
    expect(actionSource).toContain('EXPECTED_DATABASE_ROLE_INPUT: ${{ inputs.expected-role }}');
    const validatorSource = readFileSync('scripts/validate-production-db-network-url.mjs', 'utf8');
    expect(validatorSource).toContain('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
    expect(validatorSource).toContain('direct database URL must target POSTGRES_FORWARDER_HOST on port 5432');
    expect(validatorSource).toContain('direct database URL must use the expected task-specific role');
  });

  it('rejects public, privileged, credential-free, and malformed direct URLs', () => {
    const host = 'boardsesh-db-forwarder.example-tailnet.ts.net';
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway`, host)).not.toThrow();
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}:secret@public.example.com:5432/railway`, host)).toThrow(
      'must target POSTGRES_FORWARDER_HOST',
    );
    expect(() => validateRoute(`postgresql://postgres:secret@${host}:5432/railway`, host)).toThrow(
      'must use the expected task-specific role',
    );
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}@${host}:5432/railway`, host)).toThrow(
      'must include SCRAM credentials',
    );
    expect(() => validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/postgres`, host)).toThrow(
      'must target the railway database',
    );
    expect(() =>
      validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?user=postgres`, host),
    ).toThrow('must not override user');
    expect(() =>
      validateRoute(`postgresql://${MIGRATION_ROLE}:secret@${host}:5432/railway?options=-c%20role%3Dpostgres`, host),
    ).toThrow('must not set a startup role');
    expect(() => validateRoute('not a URL', host)).toThrow('not a valid URL');
    expect(() => validateRoute('postgresql://boardsesh_migrator:secret@localhost:5432/railway', 'localhost')).toThrow(
      'must be the full boardsesh-db-forwarder MagicDNS name',
    );
    expect(() =>
      validateRoute(`postgresql://unexpected_role:secret@${host}:5432/railway`, host, 'unexpected_role'),
    ).toThrow('EXPECTED_DATABASE_ROLE must be an approved task-specific Boardsesh role');
  });

  it('keeps the publisher immutable and deployment-free', () => {
    const workflowSource = readFileSync('.github/workflows/postgres-secure-network.yml', 'utf8');
    const unpinnedAction = workflowSource
      .split('\n')
      .filter((line) => /^\s*-?\s*uses:/.test(line))
      .find((line) => !/@[0-9a-f]{40}\s+#\s+/.test(line));
    expect(unpinnedAction).toBeUndefined();
    expect(workflowSource).toContain('platforms: linux/amd64');
    expect(workflowSource).toContain('push-to-registry: true');
    expect(workflowSource).not.toMatch(/railway\s+(up|redeploy)|railwayapp\/cli|RAILWAY_TOKEN/);

    const dockerfile = readFileSync('deploy/postgres-tailscale-forwarder/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      'docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d',
    );
    expect(dockerfile).toContain(
      'golang:1.27.0-alpine3.23@sha256:3747dcba41c8b0db3211fda4db61638b980e17ac5bb3c94460a975a9cfe19395',
    );
    expect(dockerfile).toContain(
      'gcr.io/distroless/static-debian13:nonroot@sha256:1c2c046bc09ed40fad370b599a0b1ae7987f55b01e247cf27a7c27cd97e5bbc7',
    );
    expect(dockerfile).toContain('USER nonroot:nonroot');
    expect(dockerfile).toContain('COPY --chown=65532:65532 state/ /var/lib/boardsesh-tsnet/');
  });
});
