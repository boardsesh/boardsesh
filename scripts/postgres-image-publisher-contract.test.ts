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
const PORTABLE_PUBLISHER_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/postgres-image-publisher.yml');
const SEEDED_PUBLISHER_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/postgres-seeded-image-publisher.yml');
const CONTRACT_WORKFLOW_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/postgres-image-publisher-contract.yml');
const portablePublisherWorkflow = readFileSync(PORTABLE_PUBLISHER_PATH, 'utf8');
const seededPublisherWorkflow = readFileSync(SEEDED_PUBLISHER_PATH, 'utf8');
const contractWorkflow = readFileSync(CONTRACT_WORKFLOW_PATH, 'utf8');

function failuresFor(
  candidatePortable = portablePublisherWorkflow,
  candidateSeeded = seededPublisherWorkflow,
  candidateContractWorkflow = contractWorkflow,
): string {
  return createPostgresImagePublisherFailures({
    portablePublisherWorkflow: candidatePortable,
    seededPublisherWorkflow: candidateSeeded,
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

interface PublisherFixture {
  label: string;
  source: string;
  imageEnvironmentKey: string;
  smokeJobName: string;
  buildStepName: string;
  buildContext: string;
  ownWorkflowPath: string;
  otherWorkflowPath: string;
  failuresAfter: (mutated: string) => string;
}

const PUBLISHERS: PublisherFixture[] = [
  {
    label: 'portable publisher',
    source: portablePublisherWorkflow,
    imageEnvironmentKey: 'PORTABLE_IMAGE',
    smokeJobName: 'smoke-portable',
    buildStepName: 'Build portable OCI layout without registry credentials',
    buildContext: './source/packages/db/docker',
    ownWorkflowPath: '.github/workflows/postgres-image-publisher.yml',
    otherWorkflowPath: '.github/workflows/postgres-seeded-image-publisher.yml',
    failuresAfter: (mutated) => failuresFor(mutated, seededPublisherWorkflow, contractWorkflow),
  },
  {
    label: 'seeded publisher',
    source: seededPublisherWorkflow,
    imageEnvironmentKey: 'SEEDED_IMAGE',
    smokeJobName: 'smoke-seeded',
    buildStepName: 'Build seeded OCI layout without registry credentials',
    buildContext: './source',
    ownWorkflowPath: '.github/workflows/postgres-seeded-image-publisher.yml',
    otherWorkflowPath: '.github/workflows/postgres-image-publisher.yml',
    failuresAfter: (mutated) => failuresFor(portablePublisherWorkflow, mutated, contractWorkflow),
  },
];

interface Weakening {
  name: string;
  mutate: (workflow: string) => string;
  expected: RegExp;
}

function sharedWeakenings(publisher: PublisherFixture): Weakening[] {
  const shaTagReference = `"$${publisher.imageEnvironmentKey}:$SHA_TAG"`;
  return [
    {
      name: 'automatic trigger',
      mutate: (workflow) =>
        replaceRequired(workflow, '  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n    branches: [main]\n'),
      expected: /only the manual workflow_dispatch trigger/,
    },
    {
      name: 'workflow-level fallback shell defaults',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '  cancel-in-progress: false\n\nenv:',
          '  cancel-in-progress: false\n\ndefaults:\n  run:\n    shell: bash\n\nenv:',
        ),
      expected: /top-level keys must match.*no defaults|must not define workflow-level defaults/,
    },
    {
      name: 'second source input',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '        required: true\n        type: string\n\nconcurrency:',
          '        required: true\n        type: string\n      source_branch:\n        required: true\n        type: string\n\nconcurrency:',
        ),
      expected: /accept only expected_main_sha/,
    },
    {
      name: 'abbreviated SHA acceptance',
      mutate: (workflow) => replaceRequired(workflow, '^[0-9a-f]{40}$', '^[0-9a-f]{7,40}$'),
      expected: /lowercase full expected_main_sha/,
    },
    {
      name: 'github SHA equality removed',
      mutate: (workflow) =>
        replaceRequired(workflow, '[[ "$EXPECTED_MAIN_SHA" == "$DISPATCH_SHA" ]]', '[[ -n "$DISPATCH_SHA" ]]'),
      expected: /must equal github.sha/,
    },
    {
      name: 'workflow SHA equality removed',
      mutate: (workflow) =>
        replaceRequired(workflow, '[[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]]', '[[ -n "$WORKFLOW_SHA" ]]'),
      expected: /must equal github.workflow_sha/,
    },
    {
      name: 'workflow ref binding removed',
      mutate: (workflow) =>
        replaceRequired(workflow, '[[ "$WORKFLOW_REF" == "$EXPECTED_WORKFLOW_REF" ]]', '[[ -n "$WORKFLOW_REF" ]]'),
      expected: /exact main workflow path and ref/,
    },
    {
      name: 'workflow ref bound to the other publisher path',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          `EXPECTED_WORKFLOW_REF: boardsesh/boardsesh/${publisher.ownWorkflowPath}@refs/heads/main`,
          `EXPECTED_WORKFLOW_REF: boardsesh/boardsesh/${publisher.otherWorkflowPath}@refs/heads/main`,
        ),
      expected: /must bind EXPECTED_WORKFLOW_REF to its own protected-main workflow path/,
    },
    {
      name: 'unprotected main accepted',
      mutate: (workflow) => replaceRequired(workflow, `[[ "$REF_IS_PROTECTED" == 'true' ]]`, 'true'),
      expected: /require protected main/,
    },
    {
      name: 'publisher concurrency cancellation',
      mutate: (workflow) => replaceRequired(workflow, '  cancel-in-progress: false', '  cancel-in-progress: true'),
      expected: /serialize every run/,
    },
    {
      name: 'wrong publisher environment',
      mutate: (workflow) =>
        replaceRequired(workflow, '    environment: postgres-image-publisher', '    environment: Production'),
      expected: /environment authority is not allowed/,
    },
    {
      name: 'administrator bypass accepted',
      mutate: (workflow) => replaceRequired(workflow, '.can_admins_bypass == false', 'true'),
      expected: /disable administrator bypass/,
    },
    {
      name: 'self-review accepted',
      mutate: (workflow) => replaceRequired(workflow, '(.prevent_self_review | type == "boolean")', 'true'),
      expected: /must assert an explicit self-review policy/,
    },
    {
      name: 'reviewer-free environment accepted',
      mutate: (workflow) => replaceRequired(workflow, '((.reviewers // []) | length > 0)', 'true'),
      expected: /require a reviewer/,
    },
    {
      name: 'multiple deployment branches accepted',
      mutate: (workflow) => replaceRequired(workflow, '.total_count == 1', '.total_count > 0'),
      expected: /exactly one branch policy/,
    },
    {
      name: 'persisted checkout credentials',
      mutate: (workflow) =>
        replaceRequired(workflow, '          persist-credentials: false', '          persist-credentials: true'),
      expected: /disable persisted credentials/,
    },
    {
      name: 'checkout of an arbitrary ref',
      mutate: (workflow) =>
        replaceRequired(workflow, '          ref: ${{ inputs.expected_main_sha }}', '          ref: ${{ github.ref }}'),
      expected: /checkout must use only expected_main_sha/,
    },
    {
      name: 'missing early PostgreSQL 18 contract prerequisite',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          `grep -Fq "'test:postgres18-contract': {" source/vite.config.ts`,
          `grep -Fq "'different-target': {" source/vite.config.ts`,
        ),
      expected: /must fail early when the PostgreSQL 18 contract target is unavailable/,
    },
    {
      name: 'validate-main timeout widened',
      mutate: (workflow) =>
        mutateWorkflowJob(workflow, 'validate-main', (job) => {
          if (job['timeout-minutes'] !== 30) throw new Error('validate-main must start with a 30-minute timeout');
          job['timeout-minutes'] = 90;
        }),
      expected: /validate-main timeout must remain 30 minutes/,
    },
    {
      name: 'extra privileged publish step',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '      - name: Publish exact prevalidated OCI layouts\n',
          '      - name: Run injected helper\n        run: source/scripts/publish.sh\n\n      - name: Publish exact prevalidated OCI layouts\n',
        ),
      expected: /publish-images must contain exactly its reviewed step allowlist/,
    },
    {
      name: 'command appended inside an allowed privileged step',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          "            fail 'main moved before OIDC attestation'",
          "            fail 'main moved before OIDC attestation'\n          curl --fail https://example.invalid/injected",
        ),
      expected: /privileged run step .* must match its exact reviewed body/,
    },
    {
      name: 'environment injected into an allowed privileged action',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '        uses: docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4\n        with:',
          '        uses: docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4\n        env:\n          GH_TOKEN: ${{ github.token }}\n        with:',
        ),
      expected: /privileged parsed job must match its exact reviewed structure/,
    },
    {
      name: 'package write on the recorder',
      mutate: (workflow) =>
        mutateWorkflowJob(workflow, 'record-published-digests', (job) => {
          const permissions = requireRecord(job.permissions, 'record-published-digests permissions');
          permissions.packages = 'write';
        }),
      expected: /record-published-digests permissions must match/,
    },
    {
      name: 'OIDC on the build job',
      mutate: (workflow) =>
        mutateWorkflowJob(workflow, 'publish-images', (job) => {
          const permissions = requireRecord(job.permissions, 'publish-images permissions');
          permissions['id-token'] = 'write';
        }),
      expected: /publish-images permissions must match/,
    },
    {
      name: 'mutable BuildKit daemon',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          'moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8',
          'moby/buildkit:buildx-stable-1',
        ),
      expected: /digest-pinned BuildKit daemon/,
    },
    {
      name: 'smoke dependencies installed while registry credentials remain',
      mutate: (workflow) =>
        moveWorkflowStepsBefore(
          workflow,
          publisher.smokeJobName,
          [
            'Set up Bun after registry credential removal',
            'Install locked dependencies after registry credential removal',
          ],
          'Remove registry credentials before image smoke',
        ),
      expected: new RegExp(
        `${publisher.smokeJobName} tool and dependency setup must occur only after registry credentials are removed`,
      ),
    },
    {
      name: 'smoke Vite+ setup runs while registry credentials remain',
      mutate: (workflow) =>
        moveWorkflowStepsBefore(
          workflow,
          publisher.smokeJobName,
          ['Set up Vite+'],
          'Remove registry credentials before image smoke',
        ),
      expected: new RegExp(
        `${publisher.smokeJobName} tool and dependency setup must occur only after registry credentials are removed`,
      ),
    },
    {
      name: 'smoke dependencies installed without the lockfile',
      mutate: (workflow) =>
        mutateWorkflowStep(
          workflow,
          publisher.smokeJobName,
          'Install locked dependencies after registry credential removal',
          (step) => {
            if (step.run !== 'bun install --frozen-lockfile') throw new Error('smoke install must start frozen');
            step.run = 'bun install';
          },
        ),
      expected: new RegExp(`${publisher.smokeJobName} must install only the reviewed lockfile graph`),
    },
    {
      name: 'unpinned smoke Bun setup',
      mutate: (workflow) =>
        mutateWorkflowStep(workflow, publisher.smokeJobName, 'Set up Bun after registry credential removal', (step) => {
          if (step.uses !== 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6') {
            throw new Error('smoke Bun setup must start at its reviewed pin');
          }
          step.uses = 'oven-sh/setup-bun@v2';
        }),
      expected: /must use only oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/,
    },
    {
      name: 'unpinned ORAS action',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          'oras-project/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d',
          'oras-project/setup-oras@v2',
        ),
      expected: /must use only oras-project\/setup-oras@/,
    },
    {
      name: 'unverified ORAS binary',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          'checksum: 9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59',
          'checksum: 0ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59',
        ),
      expected: /checksum-pinned ORAS/,
    },
    {
      name: 'BuildKit GitHub token exposure',
      mutate: (workflow) =>
        replaceRequired(workflow, "          github-token: ''", '          github-token: ${{ github.token }}'),
      expected: /never push, attest, emit an SBOM, or receive a GitHub token/,
    },
    {
      name: 'registry push during build',
      mutate: (workflow) => replaceRequired(workflow, '          push: false', '          push: true'),
      expected: /offline build must pull but never push/,
    },
    {
      name: 'wrong build context',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          `          context: ${publisher.buildContext}\n`,
          '          context: ./source/packages/web\n',
        ),
      expected: /build context and Dockerfile must remain exact/,
    },
    {
      name: 'Dockerfile frontend build argument injected',
      mutate: (workflow) =>
        mutateWorkflowStep(workflow, 'publish-images', publisher.buildStepName, (step) => {
          const withInputs = requireRecord(step.with, 'offline build inputs');
          withInputs['build-args'] = 'BUILDKIT_SYNTAX=docker/dockerfile:latest\n';
        }),
      expected: /bundled frontend without a build-argument override/,
    },
    {
      name: 'Dockerfile frontend directive revalidation removed',
      mutate: (workflow) =>
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
      name: 'retired digest validation after login',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '      - name: Validate offline layouts and retired digest policy',
          '      - name: Validate layouts after registry login',
        ),
      expected: /publish-images step \d+ must be Validate offline layouts and retired digest policy/,
    },
    {
      name: 'missing or blank retired-digest configuration accepted before build',
      mutate: (workflow) => replaceRequired(workflow, '[[ "$RETIRED_DIGESTS" =~ [^[:space:]] ]] ||', 'true ||'),
      expected: /retired digest configuration must reject missing or blank values before build setup/,
    },
    {
      name: 'explicit none sentinel no longer recognized',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '[[ "$RETIRED_DIGESTS" == \'none\' ]] && exit 0',
          '[[ -z "$RETIRED_DIGESTS" ]] && exit 0',
        ),
      expected: /retired digest configuration must require the explicit none sentinel/,
    },
    {
      name: 'retired digest format accepted loosely',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '[[ "$retired_digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
          '[[ "$retired_digest" =~ ^sha256:.*$ ]]',
        ),
      expected: /retired digest policy must reject malformed entries/,
    },
    {
      name: 'candidate helper after login',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          oras cp --from-oci-layout \\\n',
          '          vp run source/scripts/publish-helper\n          oras cp --from-oci-layout \\\n',
        ),
      expected: /must not run checked-out helpers/,
    },
    {
      name: 'branch lookup tag',
      mutate: (workflow) =>
        replaceRequired(workflow, shaTagReference, `"$${publisher.imageEnvironmentKey}:branch-main"`),
      expected:
        /publish its exact prevalidated OCI layout under only its SHA tag|obsolete PR, branch-ref, compare, or branch-tag/,
    },
    {
      name: 'latest discovery tag',
      mutate: (workflow) => replaceRequired(workflow, shaTagReference, `"$${publisher.imageEnvironmentKey}:latest"`),
      expected: /must not publish mutable discovery tags/,
    },
    {
      name: 'a second layout copied after login',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          oras cp --from-oci-layout \\\n',
          '          oras cp --from-oci-layout \\\n            "$OTHER_LAYOUT@$OTHER_DIGEST" \\\n            "$OTHER_IMAGE:$SHA_TAG" \\\n            --to-registry-config "$DOCKER_CONFIG/config.json"\n          oras cp --from-oci-layout \\\n',
        ),
      expected: /must copy exactly its one prevalidated OCI layout after login/,
    },
    {
      name: 'custom user-authored provenance predicate',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          push-to-registry: false\n',
          '          predicate-type: https://slsa.dev/provenance/v1\n          predicate: "{}"\n          push-to-registry: false\n',
        ),
      expected: /native source-aware provenance/,
    },
    {
      name: 'attestation from an unreviewed source ref',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '              --source-ref "$MAIN_REF" \\\n',
          '              --source-ref refs/pull/1/head \\\n',
        ),
      expected: /pin refs\/heads\/main/,
    },
    {
      name: 'missing attestation signer digest',
      mutate: (workflow) => replaceRequired(workflow, '              --signer-digest "$EXPECTED_MAIN_SHA" \\\n', ''),
      expected: /pin the signer SHA/,
    },
    {
      name: 'attestation verified against the other publisher signer workflow',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          `--signer-workflow "$APPROVED_REPOSITORY/${publisher.ownWorkflowPath}"`,
          `--signer-workflow "$APPROVED_REPOSITORY/${publisher.otherWorkflowPath}"`,
        ),
      expected: /must pin its own signer workflow/,
    },
    {
      name: 'unvalidated attestation URL',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          "          attestation_url_pattern='^https://github\\.com/boardsesh/boardsesh/attestations/[0-9]+$'",
          "          attestation_url_pattern='.*'",
        ),
      expected: /attestation URLs must match/,
    },
    {
      name: 'digest artifact before attestation verification',
      mutate: (workflow) => removeWorkflowNeed(workflow, 'record-published-digests', 'verify-attestations'),
      expected: /record-published-digests dependencies must match/,
    },
    {
      name: 'digest artifact without direct current-main authorization dependency',
      mutate: (workflow) => removeWorkflowNeed(workflow, 'record-published-digests', 'authorize-current-main'),
      expected: /record-published-digests dependencies must match/,
    },
    {
      name: 'attestation without its smoke gate',
      mutate: (workflow) => removeWorkflowNeed(workflow, 'attest-published-digests', publisher.smokeJobName),
      expected: /attest-published-digests dependencies must match/,
    },
    {
      name: 'final artifact upload without github SHA recheck',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          [[ "$EXPECTED_MAIN_SHA" == "$GITHUB_SHA" ]] ||\n            fail \'expected_main_sha no longer equals github.sha\'\n          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||',
          '          [[ -n "$GITHUB_SHA" ]] ||\n            fail \'expected_main_sha no longer equals github.sha\'\n          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||',
        ),
      expected: /artifact upload must recheck expected_main_sha against github.sha/,
    },
    {
      name: 'final artifact upload without workflow SHA recheck',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          [[ "$EXPECTED_MAIN_SHA" == "$WORKFLOW_SHA" ]] ||\n            fail \'workflow source SHA no longer equals expected_main_sha\'',
          '          [[ -n "$WORKFLOW_SHA" ]] ||\n            fail \'workflow source SHA no longer equals expected_main_sha\'',
        ),
      expected: /artifact upload must recheck the workflow source SHA/,
    },
    {
      name: 'final artifact upload without protected-main workflow ref recheck',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          [[ "$WORKFLOW_REF" == "$EXPECTED_WORKFLOW_REF" ]] ||\n            fail \'workflow definition is no longer bound to its approved main path\'',
          '          [[ -n "$WORKFLOW_REF" ]] ||\n            fail \'workflow definition is no longer bound to its approved main path\'',
        ),
      expected: /artifact upload must recheck the exact protected-main workflow ref/,
    },
    {
      name: 'final artifact upload without live main recheck',
      mutate: (workflow) =>
        replaceRequired(
          workflow,
          '          [[ "$(gh api "/repos/$APPROVED_REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq \'.object.sha\')" == "$EXPECTED_MAIN_SHA" ]] ||\n            fail \'main moved before digest artifact upload\'',
          '          [[ "$EXPECTED_MAIN_SHA" == "$EXPECTED_MAIN_SHA" ]] ||\n            fail \'main moved before digest artifact upload\'',
        ),
      expected: /artifact upload must recheck the live main head immediately before upload/,
    },
    {
      name: 'tag claimed as immutable identity',
      mutate: (workflow) =>
        replaceRequired(workflow, 'deployment_identity: "digest-only"', 'deployment_identity: "tag"'),
      expected: /digests as the sole identity/,
    },
    {
      name: 'renamed digest handoff artifact',
      mutate: (workflow) =>
        mutateWorkflowStep(workflow, 'record-published-digests', 'Upload verified digest manifest', (step) => {
          const withInputs = requireRecord(step.with, 'digest artifact inputs');
          withInputs.name = 'postgres-image-digests';
        }),
      expected: /digest handoff artifact must use its exact reviewed name, path, and retention/,
    },
    {
      name: 'unparsed malformed YAML',
      mutate: (workflow) => `${workflow}\n  broken: [\n`,
      expected: /not valid YAML/,
    },
  ];
}

describe('trusted PostgreSQL image publisher contract', () => {
  it('keeps both checked-in publishers inside the parsed trust boundary', () => {
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

  describe.each(PUBLISHERS)('$label', (publisher) => {
    it.each(sharedWeakenings(publisher))('fails closed after $name', ({ mutate, expected }) => {
      expect(publisher.failuresAfter(mutate(publisher.source))).toMatch(expected);
    });
  });

  it.each([
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
      name: 'ARM64 removed from the portable smoke matrix',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '        platform: [linux/amd64, linux/arm64]', '        platform: [linux/amd64]'),
      expected: /portable smoke matrix must contain exactly linux\/amd64 and linux\/arm64/,
    },
    {
      name: 'ARM64 removed from the portable build',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '          platforms: linux/amd64,linux/arm64', '          platforms: linux/amd64'),
      expected: /portable build must use its exact reviewed platform set/,
    },
    {
      name: 'the seeded image recoupled into the production publisher',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '  PORTABLE_IMAGE: ghcr.io/boardsesh/boardsesh-postgres-postgis\n',
          '  PORTABLE_IMAGE: ghcr.io/boardsesh/boardsesh-postgres-postgis\n  SEEDED_IMAGE: ghcr.io/boardsesh/boardsesh-dev-db\n',
        ),
      expected: /portable publisher: publisher must not reference SEEDED_IMAGE/,
    },
    {
      name: 'a seeded smoke job recoupled into the production publisher',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '      - smoke-portable\n', '      - smoke-portable\n      - smoke-seeded\n'),
      expected: /portable publisher: publisher must not reference smoke-seeded/,
    },
  ])('portable publisher fails closed after $name', ({ mutate, expected }) => {
    expect(failuresFor(mutate(portablePublisherWorkflow), seededPublisherWorkflow, contractWorkflow)).toMatch(expected);
  });

  it.each([
    {
      name: 'the portable image recoupled into the developer publisher',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '  SEEDED_IMAGE: ghcr.io/boardsesh/boardsesh-dev-db\n',
          '  SEEDED_IMAGE: ghcr.io/boardsesh/boardsesh-dev-db\n  PORTABLE_IMAGE: ghcr.io/boardsesh/boardsesh-postgres-postgis\n',
        ),
      expected: /seeded publisher: publisher must not reference PORTABLE_IMAGE/,
    },
    {
      name: 'the seeded publisher serialized behind the production publisher',
      mutate: (workflow: string) =>
        replaceRequired(workflow, '  group: postgres-seeded-image-publisher', '  group: postgres-image-publisher'),
      expected: /seeded publisher: publisher must serialize every run in its own concurrency group/,
    },
    {
      name: 'ARM emulation reintroduced into the seeded publisher',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '      - name: Create temporary tool and credential boundary\n',
          '      - name: Enable multi-architecture emulation\n        uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3\n        with:\n          image: tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0\n          platforms: arm64\n\n      - name: Create temporary tool and credential boundary\n',
        ),
      expected: /seeded publisher: publisher must not install ARM emulation for its linux\/amd64-only image/,
    },
    {
      name: 'ARM64 added to the seeded build',
      mutate: (workflow: string) =>
        replaceRequired(
          workflow,
          '          platforms: linux/amd64\n',
          '          platforms: linux/amd64,linux/arm64\n',
        ),
      expected: /seeded build must use its exact reviewed platform set/,
    },
    {
      name: 'a platform matrix added to the seeded smoke job',
      mutate: (workflow: string) =>
        mutateWorkflowJob(workflow, 'smoke-seeded', (job) => {
          job.strategy = { 'fail-fast': false, matrix: { platform: ['linux/amd64'] } };
        }),
      expected: /single linux\/amd64 job without a platform matrix|privileged parsed job must match/,
    },
    {
      name: 'the seeded publisher escaping its protected environment',
      mutate: (workflow: string) =>
        mutateWorkflowJob(workflow, 'publish-images', (job) => {
          delete job.environment;
        }),
      expected: /publish-images environment authority is not allowed/,
    },
  ])('seeded publisher fails closed after $name', ({ mutate, expected }) => {
    expect(failuresFor(portablePublisherWorkflow, mutate(seededPublisherWorkflow), contractWorkflow)).toMatch(expected);
  });

  it('rejects a privileged contract workflow', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  packages: write',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /globally contents-read-only|never receive/,
    );
  });

  it('rejects workflow-level defaults in the contract workflow', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '\npermissions:\n  contents: read',
      '\ndefaults:\n  run:\n    shell: bash\n\npermissions:\n  contents: read',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /top-level keys must match.*no defaults|must not define/,
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
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /checkout inputs must be exactly/,
    );
  });

  it('rejects continue-on-error on a contract step', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '      - name: Verify publisher authority and artifact contracts\n        run:',
      '      - name: Verify publisher authority and artifact contracts\n        continue-on-error: true\n        run:',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /must not continue on error|exact reviewed parsed structure/,
    );
  });

  it('rejects continue-on-error in contract job metadata', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '    timeout-minutes: 10\n    steps:',
      '    timeout-minutes: 10\n    continue-on-error: true\n    steps:',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /job metadata must match|failure handling/,
    );
  });

  it('rejects altered pull-request trigger metadata and paths', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '  pull_request:\n    paths:',
      '  pull_request:\n    branches: [main]\n    paths:',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it('rejects an altered protected-main trigger path', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      "      - 'docs/postgres-image-publishing.md'",
      "      - 'docs/unrelated.md'",
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it.each([
    'vite.config.ts',
    'scripts/vite.config.ts',
    '.github/workflows/postgres-image-publisher.yml',
    '.github/workflows/postgres-seeded-image-publisher.yml',
  ])('rejects omission of trigger path %s', (triggerPath) => {
    const weakened = replaceRequired(contractWorkflow, `      - '${triggerPath}'\n`, '');
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it('rejects an altered protected-main push branch', () => {
    const weakened = replaceRequired(contractWorkflow, '    branches: [main]', '    branches: [release]');
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /exact reviewed pull-request and protected-main path triggers/,
    );
  });

  it('rejects an injected contract step through its parsed allowlist', () => {
    const weakened = replaceRequired(
      contractWorkflow,
      '      - name: Verify publisher authority and artifact contracts\n',
      '      - name: Publish package\n        run: docker push example.invalid/image\n\n      - name: Verify publisher authority and artifact contracts\n',
    );
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /exactly its reviewed step allowlist/,
    );
  });

  it('rejects a manually dispatchable contract workflow', () => {
    const weakened = replaceRequired(contractWorkflow, '  pull_request:\n', '  workflow_dispatch:\n');
    expect(failuresFor(portablePublisherWorkflow, seededPublisherWorkflow, weakened)).toMatch(
      /run only for pull requests and pushes|never receive dispatch/,
    );
  });
});
