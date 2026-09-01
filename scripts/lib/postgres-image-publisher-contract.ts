import { createHash } from 'node:crypto';
import { parse } from 'yaml';

type UnknownRecord = Record<string, unknown>;

interface ExpectedStep {
  name: string;
  uses?: string;
}

const ACTIONS = {
  attest: 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
  buildPush: 'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
  checkout: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  login: 'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
  setupBuildx: 'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
  setupOras: 'oras-project/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d',
  setupQemu: 'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130',
  setupVp: 'voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
} as const;

const PUBLISHER_STEPS: Record<string, ExpectedStep[]> = {
  'authorize-current-main': [{ name: 'Bind workflow and audit publisher environment' }],
  'validate-main': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Validate checkout and Docker inputs' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Install locked dependencies' },
    { name: 'Run PostgreSQL 18 contracts' },
  ],
  'publish-images': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Validate retired-digest configuration before build setup' },
    { name: 'Enable multi-architecture emulation', uses: ACTIONS.setupQemu },
    { name: 'Create temporary tool and credential boundary' },
    { name: 'Set up Docker Buildx inside the temporary boundary', uses: ACTIONS.setupBuildx },
    { name: 'Set up pinned ORAS client', uses: ACTIONS.setupOras },
    { name: 'Revalidate offline build inputs' },
    { name: 'Build portable OCI layout without registry credentials', uses: ACTIONS.buildPush },
    { name: 'Build seeded OCI layout without registry credentials', uses: ACTIONS.buildPush },
    { name: 'Validate offline layouts and retired digest policy' },
    { name: 'Recheck exact current main and environment immediately before registry authentication' },
    { name: 'Authenticate ORAS to GHCR' },
    { name: 'Publish exact prevalidated OCI layouts' },
    { name: 'Remove temporary publisher credentials and builder' },
  ],
  'verify-published-images': [
    { name: 'Set up pinned ORAS client', uses: ACTIONS.setupOras },
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Authenticate ORAS to GHCR read-only' },
    { name: 'Verify exact remote manifests' },
    { name: 'Remove temporary read-only registry credentials' },
  ],
  'smoke-portable': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Enable multi-architecture emulation', uses: ACTIONS.setupQemu },
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for exact digest pull', uses: ACTIONS.login },
    { name: 'Pull exact portable digest and platform' },
    { name: 'Remove registry credentials before image smoke' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Install locked dependencies after registry credential removal' },
    { name: 'Verify labels and boot exact portable platform' },
  ],
  'smoke-seeded': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for exact digest pull', uses: ACTIONS.login },
    { name: 'Pull exact seeded digest' },
    { name: 'Remove registry credentials before image smoke' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Install locked dependencies after registry credential removal' },
    { name: 'Verify labels, architecture, and seeded database' },
  ],
  'attest-published-digests': [
    { name: 'Recheck exact current main and environment immediately before OIDC attestation' },
    { name: 'Attest exact portable digest', uses: ACTIONS.attest },
    { name: 'Attest exact seeded digest', uses: ACTIONS.attest },
  ],
  'verify-attestations': [
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for attestation verification', uses: ACTIONS.login },
    { name: 'Validate attestation URLs and verify both exact subjects' },
    { name: 'Remove temporary attestation verification credentials' },
  ],
  'record-published-digests': [
    { name: 'Write machine-readable digest manifest and summary' },
    { name: 'Recheck exact current main and workflow before artifact upload' },
    { name: 'Upload verified digest manifest', uses: ACTIONS.uploadArtifact },
  ],
};

const PUBLISHER_PERMISSIONS: Record<string, UnknownRecord> = {
  'authorize-current-main': { actions: 'read', contents: 'read' },
  'validate-main': { contents: 'read' },
  'publish-images': { actions: 'read', contents: 'read', packages: 'write' },
  'verify-published-images': { contents: 'read', packages: 'read' },
  'smoke-portable': { contents: 'read', packages: 'read' },
  'smoke-seeded': { contents: 'read', packages: 'read' },
  'attest-published-digests': {
    actions: 'read',
    contents: 'read',
    attestations: 'write',
    'id-token': 'write',
  },
  'verify-attestations': { contents: 'read', packages: 'read', attestations: 'read' },
  'record-published-digests': { contents: 'read' },
};

const PUBLISHER_NEEDS: Record<string, string[]> = {
  'authorize-current-main': [],
  'validate-main': ['authorize-current-main'],
  'publish-images': ['authorize-current-main', 'validate-main'],
  'verify-published-images': ['authorize-current-main', 'publish-images'],
  'smoke-portable': ['authorize-current-main', 'publish-images', 'verify-published-images'],
  'smoke-seeded': ['authorize-current-main', 'publish-images', 'verify-published-images'],
  'attest-published-digests': [
    'authorize-current-main',
    'publish-images',
    'verify-published-images',
    'smoke-portable',
    'smoke-seeded',
  ],
  'verify-attestations': ['authorize-current-main', 'publish-images', 'attest-published-digests'],
  'record-published-digests': [
    'authorize-current-main',
    'publish-images',
    'attest-published-digests',
    'verify-attestations',
  ],
};

// These hashes cover every parsed YAML run scalar in the publisher. The
// semantic checks below keep the contract reviewable; this exact-body allowlist
// additionally prevents commands being appended to an otherwise approved named
// step, including in validation and artifact generation.
const PRIVILEGED_RUN_SHA256: Record<string, Record<string, string>> = {
  'authorize-current-main': {
    'Bind workflow and audit publisher environment': 'a5bdefbc565f8a9d530316b439ab2560cb506f8223fa907e424c8a71335e9708',
  },
  'validate-main': {
    'Validate checkout and Docker inputs': 'd93f8b5c79e732dfa0d06bb5469b9437d690374d7f92441f128f64053ba08245',
    'Install locked dependencies': 'c10f4967f48d3183006f5e2c2f540d349fbad92f818a0e19ffa7e655ee8546aa',
    'Run PostgreSQL 18 contracts': '66196ae8703cb101dc49952e602bd24ee2a6e03d7f2902c738bcccafb1b0edf9',
  },
  'publish-images': {
    'Validate retired-digest configuration before build setup':
      '8fa475f67e0d460703ef73b4870570790369d676cd6711209a1416234d54f7f4',
    'Create temporary tool and credential boundary': '84bf5fb7b5ff5e70be8e8684099d2f87727cefde54b3a70b92b20220e3d1fea3',
    'Revalidate offline build inputs': '42ca53a491bf3433739be5ce55f88867c1d7fe5bd4403b33a3647b858596e907',
    'Validate offline layouts and retired digest policy':
      '110821eff07459d4dc1299e88bc9e71da20b0a3ce23cb89b0162cef0159b421d',
    'Recheck exact current main and environment immediately before registry authentication':
      '64ddc967602b4458fc2a6c4cf6c58d4bdf629fcd173db97d2c80e2f4e1e2d509',
    'Authenticate ORAS to GHCR': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Publish exact prevalidated OCI layouts': 'd1d1889c4b883ccdde4e2ecfc5f7d4d039caff1752ac16470d730f9005890942',
    'Remove temporary publisher credentials and builder':
      'bdb4b5ce41cfb3a4953e704107111e23695432ff4c31c0b5cc053d8db3867420',
  },
  'verify-published-images': {
    'Create temporary read-only registry boundary': '4337f5f5a43cf5dcd887de5e30f094f18d6dc6e4eaec00c9f663bd013085108e',
    'Recheck exact current main immediately before registry authentication':
      '27c9f8d7ad023da4b1e4942699fdb2f8931c2710e03f836cf9e77a012c188a9d',
    'Authenticate ORAS to GHCR read-only': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Verify exact remote manifests': 'd92f640e34ba08728b4dbe753acfb3907a6225096689d72d1855020e5d81562d',
    'Remove temporary read-only registry credentials':
      '9a101fad60773bbfc7c39cf84f5d09df89d0a5f025d71aa7d2b3e7c8f2d16923',
  },
  'smoke-portable': {
    'Create temporary read-only registry boundary': '39c5ff3207815dd6daed7d86b93fc15a4f907042ff59059b8be92f1d57ca794a',
    'Recheck exact current main immediately before registry authentication':
      '211bb881d05b4c506f7d2f2e18c6302a3a24a818f6396c386e8aa9da4908b939',
    'Pull exact portable digest and platform': '9a8fc3728f38b14f516e7f68b300897beb0ed2e15011f3080789361a9ba3b7ce',
    'Remove registry credentials before image smoke':
      'd8e333a57b04ca27e1e2a74d8689cdfa14b8ce53619491f5e9d888fa2e5ff03c',
    'Install locked dependencies after registry credential removal':
      'c10f4967f48d3183006f5e2c2f540d349fbad92f818a0e19ffa7e655ee8546aa',
    'Verify labels and boot exact portable platform':
      '5b9c73161f472d49ebed0409acef7cd36f3aa0c0ddc6c11e02ce73a49f45356c',
  },
  'smoke-seeded': {
    'Create temporary read-only registry boundary': 'e8e2af6b76ef37f5a646991d6034bbf0011fe940e1b5e7f6542f7655de30cea6',
    'Recheck exact current main immediately before registry authentication':
      '211bb881d05b4c506f7d2f2e18c6302a3a24a818f6396c386e8aa9da4908b939',
    'Pull exact seeded digest': '9c8092a89440ffcf4cf5b154ecb0f604c6ef2dd4ee519f705cfd414562c86c80',
    'Remove registry credentials before image smoke':
      '210b45c7e9c243d42c1180f419bc5183b425a71b78f018f01c19e7ea4402d60c',
    'Install locked dependencies after registry credential removal':
      'c10f4967f48d3183006f5e2c2f540d349fbad92f818a0e19ffa7e655ee8546aa',
    'Verify labels, architecture, and seeded database':
      '12bca356c5a765627cbc262f8c9fd987a1ac1b8b0d6c1c44976e8119baafa35d',
  },
  'attest-published-digests': {
    'Recheck exact current main and environment immediately before OIDC attestation':
      'ba63aad32d3c4db72db7bbed48281df422c0be9f1441cdbec1464649635262af',
  },
  'verify-attestations': {
    'Create temporary read-only registry boundary': 'a5e51a8c6a73ccc35f8f25aa870fed6434dada853729687d5ce8fb8414cf4a3c',
    'Recheck exact current main immediately before registry authentication':
      '27c9f8d7ad023da4b1e4942699fdb2f8931c2710e03f836cf9e77a012c188a9d',
    'Validate attestation URLs and verify both exact subjects':
      'd37796309c31024be340d996f54beebaf323172e5d4dedb0bc2b51203ee5bafe',
    'Remove temporary attestation verification credentials':
      '1eb783af4e7705bd00ca9b7ac9b47ebe5664c1a3a6c641d3edfb30a7fe10b48d',
  },
  'record-published-digests': {
    'Write machine-readable digest manifest and summary':
      '09823c60bd2dbc2a533cdad2b02e41343b5976c234122845e67452c5052dcbad',
    'Recheck exact current main and workflow before artifact upload':
      '3fd4d1ae5661abcd1101d9a60addb336e7d61cb30e362c75710da08560cbab0c',
  },
};

// Canonical parsed-job hashes also freeze action inputs, step environments,
// conditions, outputs, and matrices. Together with the readable assertions,
// this makes the whole publisher an exact structural allowlist.
const PRIVILEGED_JOB_SHA256: Record<string, string> = {
  'authorize-current-main': '012c58011b4370b349d5f7dcfe89171bcfdf3e0653b459ab9fcbd865d3fc54c7',
  'validate-main': '4ce118c69113ecc6b61980e8452c11478a1ec000f8fa82bbf4b734d5154f4569',
  'publish-images': '7230e1b43868539815cd52a82a3fa651647cd7b75a2d4f53ed976d75afa18002',
  'verify-published-images': '05f165fb989b0c7c920b470b19bf4f14b5f3dd1f0c2880bd79e3f2b79228e1c8',
  'smoke-portable': '9c2da7fd8294d98b009b0e36a94618ab8b9b10f3048355cc3d280a6b1747a879',
  'smoke-seeded': '330d067442a0e8bf100230b2c57d8d2d6874e2e0c1d7c5e729802f9a2b5a9e9b',
  'attest-published-digests': 'f3815b58609bfc7c88061071e23ef1bdefe2c945613d79d15ae3ef3353b6bf5a',
  'verify-attestations': 'e3e536f61601ef9d8681dc5809065ff814612c227a70afbc14e1c3cb21a6ff8c',
  'record-published-digests': '8332efc25368a20c05a3ed6e4c79ecb7eef69b1886e41e9ff90963b765d9a5ed',
};

const CONTRACT_PATHS = [
  '.github/workflows/postgres-image-publisher.yml',
  '.github/workflows/postgres-image-publisher-contract.yml',
  'vite.config.ts',
  'scripts/lib/postgres-image-publisher-contract.ts',
  'scripts/postgres-image-publisher-contract.test.ts',
  'scripts/vite.config.ts',
  'docs/postgres-image-publishing.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

const CONTRACT_STEPS: ExpectedStep[] = [
  { name: 'Checkout repository without persisted credentials', uses: ACTIONS.checkout },
  { name: 'Set up Vite+', uses: ACTIONS.setupVp },
  { name: 'Install locked dependencies' },
  { name: 'Verify publisher authority and artifact contracts' },
];

const CONTRACT_WORKFLOW_METADATA_SHA256 = '598a7028d9332760676c83e3481238a5fbd4ca9ac2a4fb0cdecb4df1b66ecf16';
const CONTRACT_JOB_METADATA_SHA256 = '9e0f951e6bceb41814be7e67f5cfe5cf5d808315af99a39bc312cbce1c7f0cfb';
const CONTRACT_STEP_SHA256: Record<string, string> = {
  'Checkout repository without persisted credentials':
    '21d3640a58fa24bec3a2646f701ef5ce7da14567f1a979619cc77e2d942e3726',
  'Set up Vite+': '57fd2776408eb1ae058f9b97a601b4b7a336d02b1610914b946174e3cf0905ba',
  'Install locked dependencies': '877a5faa147c1506c02de753889fa737d1ec66e8e05976ae106eeda1d77abcb9',
  'Verify publisher authority and artifact contracts':
    '6b2aee4c921df58aee7ab637c77324d131753c2e73e5d8a027529178077be67d',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function stepsAt(job: UnknownRecord): UnknownRecord[] {
  const steps = job.steps;
  return Array.isArray(steps) && steps.every(isRecord) ? steps : [];
}

function stepByName(job: UnknownRecord, name: string): UnknownRecord | undefined {
  return stepsAt(job).find((step) => step.name === name);
}

function normalizedStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return [];
  return [...value].sort();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalValue(nestedValue)]),
  );
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function withoutKey(record: UnknownRecord, omittedKey: string): UnknownRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey));
}

function keysEqual(record: UnknownRecord, expectedKeys: string[]): boolean {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expectedKeys].sort());
}

function recordsEqual(left: UnknownRecord | undefined, right: UnknownRecord): boolean {
  return left !== undefined && JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function parseWorkflow(source: string, label: string, failures: string[]): UnknownRecord | undefined {
  try {
    const document: unknown = parse(source);
    if (!isRecord(document)) {
      failures.push(`${label} must parse to a YAML mapping`);
      return undefined;
    }
    return document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label} is not valid YAML: ${message}`);
    return undefined;
  }
}

function requireRunPattern(
  failures: string[],
  job: UnknownRecord,
  stepName: string,
  pattern: RegExp,
  message: string,
): void {
  const run = stringAt(stepByName(job, stepName) ?? {}, 'run');
  if (run === undefined || !pattern.test(run)) failures.push(message);
}

function validateStepAllowlist(
  failures: string[],
  jobName: string,
  job: UnknownRecord,
  expectedSteps: ExpectedStep[],
): void {
  const steps = stepsAt(job);
  if (steps.length !== expectedSteps.length) {
    failures.push(`${jobName} must contain exactly its reviewed step allowlist`);
    return;
  }

  for (const [index, expected] of expectedSteps.entries()) {
    const step = steps[index];
    if (step.name !== expected.name) {
      failures.push(`${jobName} step ${index + 1} must be ${expected.name}`);
      continue;
    }
    const uses = stringAt(step, 'uses');
    const run = stringAt(step, 'run');
    if (expected.uses !== undefined) {
      if (uses !== expected.uses || run !== undefined) {
        failures.push(`${jobName} step ${expected.name} must use only ${expected.uses}`);
      }
    } else if (run === undefined || uses !== undefined) {
      failures.push(`${jobName} step ${expected.name} must be an inline trusted run step`);
    }
  }
}

function validatePrivilegedRunBodies(failures: string[], jobs: UnknownRecord): void {
  for (const [jobName, reviewedHashes] of Object.entries(PRIVILEGED_RUN_SHA256)) {
    const expectedRunNames = PUBLISHER_STEPS[jobName]
      .filter((step) => step.uses === undefined)
      .map((step) => step.name);
    if (JSON.stringify(Object.keys(reviewedHashes)) !== JSON.stringify(expectedRunNames)) {
      failures.push(`${jobName} privileged run-body allowlist must cover every reviewed inline step`);
      continue;
    }

    const job = recordAt(jobs, jobName);
    if (!job) continue;
    for (const [stepName, expectedHash] of Object.entries(reviewedHashes)) {
      const run = stringAt(stepByName(job, stepName) ?? {}, 'run');
      const actualHash = run === undefined ? undefined : createHash('sha256').update(run).digest('hex');
      if (actualHash !== expectedHash) {
        failures.push(`${jobName} privileged run step ${stepName} must match its exact reviewed body`);
      }
    }
  }
}

function validatePrivilegedJobs(failures: string[], jobs: UnknownRecord): void {
  if (JSON.stringify(Object.keys(PRIVILEGED_JOB_SHA256)) !== JSON.stringify(Object.keys(PRIVILEGED_RUN_SHA256))) {
    failures.push('privileged parsed-job and run-body allowlists must cover the same jobs');
    return;
  }
  for (const [jobName, expectedHash] of Object.entries(PRIVILEGED_JOB_SHA256)) {
    const job = recordAt(jobs, jobName);
    if (job && canonicalSha256(job) !== expectedHash) {
      failures.push(`${jobName} privileged parsed job must match its exact reviewed structure`);
    }
  }
}

function validateCheckout(
  failures: string[],
  jobName: string,
  step: UnknownRecord | undefined,
  expectedPath?: string,
): void {
  if (!step) return;
  const withInputs = recordAt(step, 'with');
  if (!withInputs) {
    failures.push(`${jobName} checkout must define exact inputs`);
    return;
  }
  if (withInputs.ref !== '${{ inputs.expected_main_sha }}') {
    failures.push(`${jobName} checkout must use only expected_main_sha`);
  }
  if (withInputs['persist-credentials'] !== false) {
    failures.push(`${jobName} checkout must disable persisted credentials`);
  }
  if (withInputs['fetch-depth'] !== 1) {
    failures.push(`${jobName} checkout must fetch only the exact commit`);
  }
  if (expectedPath !== undefined && withInputs.path !== expectedPath) {
    failures.push(`${jobName} checkout must use path ${expectedPath}`);
  }
}

function validateOrasSetup(failures: string[], jobName: string, job: UnknownRecord): void {
  const step = stepByName(job, 'Set up pinned ORAS client');
  if (!step) return;
  const withInputs = recordAt(step, 'with');
  if (
    !withInputs ||
    withInputs.url !== 'https://github.com/oras-project/oras/releases/download/v1.3.3/oras_1.3.3_linux_amd64.tar.gz' ||
    withInputs.checksum !== '9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59'
  ) {
    failures.push(`${jobName} must use the reviewed checksum-pinned ORAS v1.3.3 binary`);
  }
}

function validateBuildStep(failures: string[], step: UnknownRecord | undefined, kind: 'portable' | 'seeded'): void {
  if (!step) return;
  const withInputs = recordAt(step, 'with');
  if (!withInputs) {
    failures.push(`${kind} build must define exact inputs`);
    return;
  }
  const expectedContext = kind === 'portable' ? './source/packages/db/docker' : './source';
  const expectedFile =
    kind === 'portable'
      ? './source/packages/db/docker/Dockerfile.postgres'
      : './source/packages/db/docker/Dockerfile.dev-db';
  const expectedPlatforms = kind === 'portable' ? 'linux/amd64,linux/arm64' : 'linux/amd64';
  const expectedOutput =
    kind === 'portable'
      ? 'type=oci,dest=${{ runner.temp }}/portable-oci,tar=false,name=${{ env.PORTABLE_IMAGE }}:sha-${{ inputs.expected_main_sha }}'
      : 'type=oci,dest=${{ runner.temp }}/seeded-oci,tar=false,name=${{ env.SEEDED_IMAGE }}:sha-${{ inputs.expected_main_sha }}';
  const expectedLabels = [
    'org.opencontainers.image.revision=${{ inputs.expected_main_sha }}',
    'org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}',
    'org.opencontainers.image.ref.name=refs/heads/main',
  ];

  if (withInputs.context !== expectedContext || withInputs.file !== expectedFile) {
    failures.push(`${kind} build context and Dockerfile must remain exact`);
  }
  if (withInputs.platforms !== expectedPlatforms) {
    failures.push(`${kind} build must use its exact reviewed platform set`);
  }
  if (
    withInputs.pull !== true ||
    withInputs.push !== false ||
    withInputs.provenance !== false ||
    withInputs.sbom !== false ||
    withInputs['github-token'] !== ''
  ) {
    failures.push(`${kind} offline build must pull but never push, attest, emit an SBOM, or receive a GitHub token`);
  }
  if ('build-args' in withInputs) {
    failures.push(`${kind} build must use the pinned BuildKit bundled frontend without a build-argument override`);
  }
  if (withInputs.outputs !== expectedOutput) {
    failures.push(`${kind} build must export its exact local OCI layout before authentication`);
  }
  const labels = typeof withInputs.labels === 'string' ? withInputs.labels.trim().split('\n') : [];
  if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
    failures.push(`${kind} build must publish exact main source labels`);
  }
  for (const forbiddenInput of ['tags', 'secrets', 'secret-envs', 'secret-files', 'ssh']) {
    if (forbiddenInput in withInputs) {
      failures.push(`${kind} offline build must not define ${forbiddenInput}`);
    }
  }
}

function validatePublisherDocument(failures: string[], publisher: UnknownRecord, publisherWorkflow: string): void {
  if (!keysEqual(publisher, ['name', 'on', 'concurrency', 'env', 'jobs'])) {
    failures.push('publisher top-level keys must match the exact executable allowlist with no defaults');
  }
  if (publisher.name !== 'Publish Current Main PostgreSQL Images') {
    failures.push('publisher workflow name must remain exact');
  }
  if ('defaults' in publisher) {
    failures.push('publisher must not define workflow-level defaults');
  }

  const triggers = recordAt(publisher, 'on');
  if (!triggers || JSON.stringify(Object.keys(triggers)) !== JSON.stringify(['workflow_dispatch'])) {
    failures.push('publisher must have only the manual workflow_dispatch trigger');
  }
  const dispatch = triggers ? recordAt(triggers, 'workflow_dispatch') : undefined;
  const expectedDispatch = {
    inputs: {
      expected_main_sha: {
        description: 'Exact lowercase 40-character SHA currently at the head of main',
        required: true,
        type: 'string',
      },
    },
  };
  if (!recordsEqual(dispatch, expectedDispatch)) {
    failures.push('publisher workflow_dispatch metadata must remain exact with no fallback defaults');
  }
  const inputs = dispatch ? recordAt(dispatch, 'inputs') : undefined;
  if (!inputs || JSON.stringify(Object.keys(inputs)) !== JSON.stringify(['expected_main_sha'])) {
    failures.push('publisher must accept only expected_main_sha');
  } else {
    const expectedMainSha = recordAt(inputs, 'expected_main_sha');
    if (!expectedMainSha || expectedMainSha.required !== true || expectedMainSha.type !== 'string') {
      failures.push('expected_main_sha must be a required string');
    }
  }

  const concurrency = recordAt(publisher, 'concurrency');
  if (!recordsEqual(concurrency, { group: 'postgres-image-publisher', 'cancel-in-progress': false })) {
    failures.push('publisher must serialize every run without cancelling an active publication');
  }

  const expectedEnvironment = {
    APPROVED_REPOSITORY: 'boardsesh/boardsesh',
    DEFAULT_BRANCH: 'main',
    PUBLISHER_ENVIRONMENT: 'postgres-image-publisher',
    REGISTRY: 'ghcr.io',
    PORTABLE_IMAGE: 'ghcr.io/boardsesh/boardsesh-postgres-postgis',
    SEEDED_IMAGE: 'ghcr.io/boardsesh/boardsesh-dev-db',
    MAIN_REF: 'refs/heads/main',
  };
  if (!recordsEqual(recordAt(publisher, 'env'), expectedEnvironment)) {
    failures.push('publisher global constants must remain exact');
  }

  const jobs = recordAt(publisher, 'jobs');
  if (!jobs) {
    failures.push('publisher must define jobs');
    return;
  }
  const expectedJobNames = Object.keys(PUBLISHER_STEPS);
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(expectedJobNames)) {
    failures.push('publisher jobs must match the exact reviewed job allowlist and order');
  }

  for (const jobName of expectedJobNames) {
    const job = recordAt(jobs, jobName);
    if (!job) {
      failures.push(`publisher is missing ${jobName}`);
      continue;
    }
    validateStepAllowlist(failures, jobName, job, PUBLISHER_STEPS[jobName]);
    for (const step of stepsAt(job).filter((candidate) => candidate.uses === ACTIONS.setupVp)) {
      if (!recordsEqual(recordAt(step, 'with'), { 'node-version': '22.x' })) {
        failures.push(`${jobName} Vite+ setup must pin exactly Node 22.x with no additional inputs`);
      }
    }
    if (!recordsEqual(recordAt(job, 'permissions'), PUBLISHER_PERMISSIONS[jobName])) {
      failures.push(`${jobName} permissions must match its exact allowlist`);
    }
    if (JSON.stringify(normalizedStringArray(job.needs)) !== JSON.stringify([...PUBLISHER_NEEDS[jobName]].sort())) {
      failures.push(`${jobName} dependencies must match the reviewed gate order`);
    }
    const environment = job.environment;
    const shouldUsePublisherEnvironment = jobName === 'publish-images' || jobName === 'attest-published-digests';
    if (
      (shouldUsePublisherEnvironment && environment !== 'postgres-image-publisher') ||
      (!shouldUsePublisherEnvironment && environment !== undefined)
    ) {
      failures.push(`${jobName} environment authority is not allowed by the exact contract`);
    }
  }
  validatePrivilegedRunBodies(failures, jobs);
  validatePrivilegedJobs(failures, jobs);

  const authorize = recordAt(jobs, 'authorize-current-main') ?? {};
  for (const [pattern, message] of [
    [
      /\[\[ "\$EXPECTED_MAIN_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
      'publisher must require a lowercase full expected_main_sha',
    ],
    [/\[\[ "\$EXPECTED_MAIN_SHA" == "\$DISPATCH_SHA" \]\]/, 'expected_main_sha must equal github.sha'],
    [/\[\[ "\$EXPECTED_MAIN_SHA" == "\$WORKFLOW_SHA" \]\]/, 'expected_main_sha must equal github.workflow_sha'],
    [
      /\[\[ "\$WORKFLOW_REF" == "\$EXPECTED_WORKFLOW_REF" \]\]/,
      'publisher must bind the exact main workflow path and ref',
    ],
    [/\[\[ "\$REF_IS_PROTECTED" == 'true' \]\]/, 'publisher must require protected main'],
    [/git\/ref\/heads\/\$DEFAULT_BRANCH/, 'publisher must query the live main head'],
    [/\.can_admins_bypass == false/, 'publisher environment must disable administrator bypass'],
    [
      /\(\.prevent_self_review \| type == "boolean"\)/,
      'publisher environment must assert an explicit self-review policy',
    ],
    [/\(\(\.reviewers \/\/ \[\]\) \| length > 0\)/, 'publisher environment must require a reviewer'],
    [/\.total_count == 1/, 'publisher environment must allow exactly one branch policy'],
  ] as const) {
    requireRunPattern(failures, authorize, 'Bind workflow and audit publisher environment', pattern, message);
  }

  const validateMain = recordAt(jobs, 'validate-main') ?? {};
  if (validateMain['timeout-minutes'] !== 30) {
    failures.push('validate-main timeout must remain 30 minutes');
  }
  validateCheckout(failures, 'validate-main', stepByName(validateMain, 'Checkout exact current main commit'), 'source');
  requireRunPattern(
    failures,
    validateMain,
    'Validate checkout and Docker inputs',
    /grep -Fq "'test:postgres18-contract': \{" source\/vite\.config\.ts/,
    'exact-main validation must fail early when the PostgreSQL 18 contract target is unavailable',
  );
  requireRunPattern(
    failures,
    validateMain,
    'Validate checkout and Docker inputs',
    /s\/\^\\xEF\\xBB\\xBF\/\/ if \$\. == 1;/,
    'Docker input validation must strip a UTF-8 BOM before checking parser directives',
  );
  requireRunPattern(
    failures,
    validateMain,
    'Validate checkout and Docker inputs',
    /\$found \|\|= \/\^\[ \\t\]\*#\[ \\t\]\*syntax\[ \\t\]\*=\/i;/,
    'Docker input validation must reject whitespace-prefixed syntax directives',
  );
  requireRunPattern(
    failures,
    validateMain,
    'Run PostgreSQL 18 contracts',
    /^vp run test:postgres18-contract$/,
    'exact-main validation must run the PostgreSQL 18 contract target',
  );

  const publish = recordAt(jobs, 'publish-images') ?? {};
  validateCheckout(failures, 'publish-images', stepByName(publish, 'Checkout exact current main commit'), 'source');
  for (const [pattern, message] of [
    [
      /\[\[ "\$RETIRED_DIGESTS" =~ \[\^\[:space:\]\] \]\]/,
      'retired digest configuration must reject missing or blank values before build setup',
    ],
    [
      /\[\[ "\$RETIRED_DIGESTS" == 'none' \]\]/,
      'retired digest configuration must require the explicit none sentinel for an empty set',
    ],
    [
      /\[\[ "\$retired_digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
      'retired digest policy must reject malformed entries before build setup',
    ],
  ] as const) {
    requireRunPattern(failures, publish, 'Validate retired-digest configuration before build setup', pattern, message);
  }
  validateOrasSetup(failures, 'publish-images', publish);
  for (const [pattern, message] of [
    [
      /s\/\^\\xEF\\xBB\\xBF\/\/ if \$\. == 1;/,
      'offline Docker input revalidation must strip a UTF-8 BOM before checking parser directives',
    ],
    [
      /\$found \|\|= \/\^\[ \\t\]\*#\[ \\t\]\*syntax\[ \\t\]\*=\/i;/,
      'offline Docker input revalidation must reject whitespace-prefixed syntax directives',
    ],
  ] as const) {
    requireRunPattern(failures, publish, 'Revalidate offline build inputs', pattern, message);
  }
  const buildx = stepByName(publish, 'Set up Docker Buildx inside the temporary boundary');
  const buildxInputs = buildx ? recordAt(buildx, 'with') : undefined;
  if (
    !buildxInputs ||
    buildxInputs.version !== 'v0.36.1' ||
    buildxInputs.cleanup !== false ||
    buildxInputs['driver-opts'] !==
      'image=moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8\n'
  ) {
    failures.push('publisher must use its exact digest-pinned BuildKit daemon inside the temporary boundary');
  }
  const portableQemu = stepByName(publish, 'Enable multi-architecture emulation');
  const portableQemuInputs = portableQemu ? recordAt(portableQemu, 'with') : undefined;
  if (
    !portableQemuInputs ||
    portableQemuInputs.image !==
      'tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0' ||
    portableQemuInputs.platforms !== 'arm64'
  ) {
    failures.push('portable publisher QEMU must use only the reviewed digest-pinned ARM64 helper');
  }
  validateBuildStep(
    failures,
    stepByName(publish, 'Build portable OCI layout without registry credentials'),
    'portable',
  );
  validateBuildStep(failures, stepByName(publish, 'Build seeded OCI layout without registry credentials'), 'seeded');
  for (const [pattern, message] of [
    [
      /RETIRED_DB_IMAGE_DIGESTS must be none or contain one lowercase sha256 digest per non-empty line/,
      'retired digest policy must reject malformed entries',
    ],
    [
      /\[\[ "\$retired_digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
      'retired digest policy must reject malformed entries with an exact lowercase digest pattern',
    ],
    [/seen_retired_digests/, 'retired digest policy must reject duplicates and proposed retired digests'],
    [/portable_digest="\$\(layout_digest/, 'portable digest must come from the offline OCI layout'],
    [/seeded_digest="\$\(layout_digest/, 'seeded digest must come from the offline OCI layout'],
    [/\["linux\/amd64","linux\/arm64"\]/, 'portable offline layout must have its exact platforms'],
    [/\["linux\/amd64"\]/, 'seeded offline layout must have its exact platform'],
  ] as const) {
    requireRunPattern(failures, publish, 'Validate offline layouts and retired digest policy', pattern, message);
  }
  requireRunPattern(
    failures,
    publish,
    'Recheck exact current main and environment immediately before registry authentication',
    /main moved before registry authentication/,
    'publisher must recheck the live main head immediately before GHCR authentication',
  );
  requireRunPattern(
    failures,
    publish,
    'Recheck exact current main and environment immediately before registry authentication',
    /\.can_admins_bypass == false[\s\S]*\(\.prevent_self_review \| type == "boolean"\)/,
    'publisher must re-audit no-bypass and the explicit self-review policy immediately before GHCR authentication',
  );
  const publishRun = stringAt(stepByName(publish, 'Publish exact prevalidated OCI layouts') ?? {}, 'run') ?? '';
  if ((publishRun.match(/oras cp --from-oci-layout/g) ?? []).length !== 2) {
    failures.push('publisher must copy exactly both prevalidated OCI layouts after login');
  }
  if (
    (publishRun.match(/"\$PORTABLE_IMAGE:\$SHA_TAG"/g) ?? []).length !== 2 ||
    (publishRun.match(/"\$SEEDED_IMAGE:\$SHA_TAG"/g) ?? []).length !== 2
  ) {
    failures.push('publisher must publish exact prevalidated OCI layouts under only their SHA tag');
  }
  if (/\b(?:vp|pnpm|npm|npx|bun)\b|source\/scripts|docker build/.test(publishRun)) {
    failures.push('publisher must not run checked-out helpers or rebuild after registry login');
  }

  const verifyImages = recordAt(jobs, 'verify-published-images') ?? {};
  validateOrasSetup(failures, 'verify-published-images', verifyImages);
  requireRunPattern(
    failures,
    verifyImages,
    'Verify exact remote manifests',
    /\["linux\/amd64", "linux\/arm64"\]/,
    'remote portable manifest must expose exactly amd64 and arm64',
  );
  requireRunPattern(
    failures,
    verifyImages,
    'Verify exact remote manifests',
    /\["linux\/amd64"\]/,
    'remote seeded manifest must expose exactly amd64',
  );

  for (const smokeName of ['smoke-portable', 'smoke-seeded']) {
    const smoke = recordAt(jobs, smokeName) ?? {};
    validateCheckout(failures, smokeName, stepByName(smoke, 'Checkout exact current main commit'));
    requireRunPattern(
      failures,
      smoke,
      'Recheck exact current main immediately before registry authentication',
      /git\/ref\/heads\/\$DEFAULT_BRANCH/,
      `${smokeName} must recheck live main immediately before login`,
    );
    requireRunPattern(
      failures,
      smoke,
      'Install locked dependencies after registry credential removal',
      /^vp install --frozen-lockfile$/,
      `${smokeName} must install only the reviewed lockfile graph before running candidate smoke code`,
    );

    const smokeSteps = stepsAt(smoke);
    const credentialRemovalIndex = smokeSteps.findIndex(
      (step) => step.name === 'Remove registry credentials before image smoke',
    );
    const setupVpIndex = smokeSteps.findIndex((step) => step.name === 'Set up Vite+');
    const dependencyInstallIndex = smokeSteps.findIndex(
      (step) => step.name === 'Install locked dependencies after registry credential removal',
    );
    const candidateSmokeStepName =
      smokeName === 'smoke-portable'
        ? 'Verify labels and boot exact portable platform'
        : 'Verify labels, architecture, and seeded database';
    const candidateSmokeIndex = smokeSteps.findIndex((step) => step.name === candidateSmokeStepName);
    if (
      credentialRemovalIndex < 0 ||
      setupVpIndex <= credentialRemovalIndex ||
      dependencyInstallIndex <= setupVpIndex ||
      candidateSmokeIndex <= dependencyInstallIndex
    ) {
      failures.push(`${smokeName} tool and dependency setup must occur only after registry credentials are removed`);
    }
  }
  const smokePortable = recordAt(jobs, 'smoke-portable') ?? {};
  if (
    !recordsEqual(recordAt(smokePortable, 'strategy'), {
      'fail-fast': false,
      matrix: { platform: ['linux/amd64', 'linux/arm64'] },
    })
  ) {
    failures.push('portable smoke matrix must contain exactly linux/amd64 and linux/arm64');
  }
  const smokeQemu = stepByName(smokePortable, 'Enable multi-architecture emulation');
  const smokeQemuInputs = smokeQemu ? recordAt(smokeQemu, 'with') : undefined;
  if (
    !smokeQemu ||
    smokeQemu.if !== "matrix.platform == 'linux/arm64'" ||
    !smokeQemuInputs ||
    smokeQemuInputs.platforms !== 'arm64' ||
    smokeQemuInputs.image !==
      'tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0'
  ) {
    failures.push('portable smoke must grant pinned QEMU only to its ARM64 matrix run');
  }

  const attest = recordAt(jobs, 'attest-published-digests') ?? {};
  requireRunPattern(
    failures,
    attest,
    'Recheck exact current main and environment immediately before OIDC attestation',
    /main moved before OIDC attestation/,
    'attestation must recheck live main immediately before OIDC authority',
  );
  requireRunPattern(
    failures,
    attest,
    'Recheck exact current main and environment immediately before OIDC attestation',
    /\.can_admins_bypass == false[\s\S]*\(\.prevent_self_review \| type == "boolean"\)/,
    'attestation must re-audit no-bypass and the explicit self-review policy before OIDC authority',
  );
  for (const [stepName, subjectName, subjectDigest] of [
    [
      'Attest exact portable digest',
      '${{ env.PORTABLE_IMAGE }}',
      '${{ needs.publish-images.outputs.portable_digest }}',
    ],
    ['Attest exact seeded digest', '${{ env.SEEDED_IMAGE }}', '${{ needs.publish-images.outputs.seeded_digest }}'],
  ] as const) {
    const step = stepByName(attest, stepName);
    const withInputs = step ? recordAt(step, 'with') : undefined;
    if (
      !withInputs ||
      JSON.stringify(Object.keys(withInputs)) !==
        JSON.stringify(['subject-name', 'subject-digest', 'push-to-registry']) ||
      withInputs['subject-name'] !== subjectName ||
      withInputs['subject-digest'] !== subjectDigest ||
      withInputs['push-to-registry'] !== false
    ) {
      failures.push(`${stepName} must use native source-aware provenance for only its exact digest`);
    }
  }

  const verifyAttestations = recordAt(jobs, 'verify-attestations') ?? {};
  for (const [pattern, message] of [
    [
      /\^https:\/\/github\\\.com\/boardsesh\/boardsesh\/attestations\/\[0-9\]\+\$/,
      'attestation URLs must match the exact Boardsesh repository URL shape',
    ],
    [/gh attestation verify "oci:\/\/\$image@\$digest"/, 'downstream verification must verify the exact OCI subject'],
    [
      /--signer-workflow "\$APPROVED_REPOSITORY\/\.github\/workflows\/postgres-image-publisher\.yml"/,
      'downstream verification must pin the signer workflow',
    ],
    [/--signer-digest "\$EXPECTED_MAIN_SHA"/, 'downstream verification must pin the signer SHA'],
    [/--source-ref "\$MAIN_REF"/, 'downstream verification must pin refs/heads/main'],
    [/--source-digest "\$EXPECTED_MAIN_SHA"/, 'downstream verification must pin the source SHA'],
    [/--deny-self-hosted-runners/, 'downstream verification must reject self-hosted attestations'],
    [/verify_attestation "\$PORTABLE_IMAGE"/, 'downstream verification must verify the portable attestation'],
    [/verify_attestation "\$SEEDED_IMAGE"/, 'downstream verification must verify the seeded attestation'],
  ] as const) {
    requireRunPattern(
      failures,
      verifyAttestations,
      'Validate attestation URLs and verify both exact subjects',
      pattern,
      message,
    );
  }

  const recordJob = recordAt(jobs, 'record-published-digests') ?? {};
  requireRunPattern(
    failures,
    recordJob,
    'Write machine-readable digest manifest and summary',
    /schema_version: 2/,
    'digest handoff must use schema version 2',
  );
  requireRunPattern(
    failures,
    recordJob,
    'Write machine-readable digest manifest and summary',
    /deployment_identity: "digest-only"[\s\S]*tags_are_mutable: true/,
    'digest handoff must declare digests as the sole identity and tags as mutable',
  );
  requireRunPattern(
    failures,
    recordJob,
    'Write machine-readable digest manifest and summary',
    /attestation_verified: true/g,
    'digest handoff must record downstream attestation verification',
  );
  for (const [pattern, message] of [
    [
      /\[\[ "\$EXPECTED_MAIN_SHA" == "\$GITHUB_SHA" \]\]/,
      'artifact upload must recheck expected_main_sha against github.sha',
    ],
    [/\[\[ "\$EXPECTED_MAIN_SHA" == "\$WORKFLOW_SHA" \]\]/, 'artifact upload must recheck the workflow source SHA'],
    [
      /\[\[ "\$WORKFLOW_REF" == "\$EXPECTED_WORKFLOW_REF" \]\]/,
      'artifact upload must recheck the exact protected-main workflow ref',
    ],
    [
      /git\/ref\/heads\/\$DEFAULT_BRANCH[\s\S]*== "\$EXPECTED_MAIN_SHA"/,
      'artifact upload must recheck the live main head immediately before upload',
    ],
  ] as const) {
    requireRunPattern(
      failures,
      recordJob,
      'Recheck exact current main and workflow before artifact upload',
      pattern,
      message,
    );
  }

  if (/source_pr_number|source_ref|branch_tag|pull-requests:|\/compare\//i.test(publisherWorkflow)) {
    failures.push('publisher must not contain obsolete PR, branch-ref, compare, or branch-tag authority logic');
  }
  if (/:(?:latest|main|pg18)(?:[\s"']|$)/m.test(publisherWorkflow)) {
    failures.push('publisher must not publish mutable discovery tags');
  }
}

function validateContractDocument(failures: string[], contract: UnknownRecord, contractWorkflow: string): void {
  if (!keysEqual(contract, ['name', 'on', 'permissions', 'concurrency', 'jobs'])) {
    failures.push('contract workflow top-level keys must match the exact read-only allowlist with no defaults');
  }
  if (contract.name !== 'PostgreSQL Image Publisher Contract') {
    failures.push('contract workflow name must remain exact');
  }
  if ('defaults' in contract) {
    failures.push('contract workflow must not define workflow-level defaults');
  }
  if (canonicalSha256(withoutKey(contract, 'jobs')) !== CONTRACT_WORKFLOW_METADATA_SHA256) {
    failures.push('contract workflow metadata must match its exact reviewed parsed structure');
  }

  const triggers = recordAt(contract, 'on');
  const expectedTriggers = {
    pull_request: { paths: CONTRACT_PATHS },
    push: { branches: ['main'], paths: CONTRACT_PATHS },
  };
  if (!recordsEqual(triggers, expectedTriggers)) {
    failures.push('contract workflow must use only the exact reviewed pull-request and protected-main path triggers');
  }
  if (!recordsEqual(recordAt(contract, 'permissions'), { contents: 'read' })) {
    failures.push('contract workflow must be globally contents-read-only');
  }
  if (
    !recordsEqual(recordAt(contract, 'concurrency'), {
      group: 'postgres-image-contract-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
  ) {
    failures.push('contract workflow concurrency must match the exact reviewed pull-request cancellation policy');
  }
  const jobs = recordAt(contract, 'jobs');
  if (!jobs || JSON.stringify(Object.keys(jobs)) !== JSON.stringify(['verify-trust-boundary'])) {
    failures.push('contract workflow must contain only verify-trust-boundary');
    return;
  }
  const job = recordAt(jobs, 'verify-trust-boundary') ?? {};
  if (canonicalSha256(withoutKey(job, 'steps')) !== CONTRACT_JOB_METADATA_SHA256) {
    failures.push('contract job metadata must match its exact reviewed parsed structure');
  }
  if ('permissions' in job || 'environment' in job || 'defaults' in job || 'continue-on-error' in job) {
    failures.push('contract job must not override permissions, defaults, failure handling, or environment authority');
  }
  validateStepAllowlist(failures, 'contract verify-trust-boundary', job, CONTRACT_STEPS);
  if (JSON.stringify(Object.keys(CONTRACT_STEP_SHA256)) !== JSON.stringify(CONTRACT_STEPS.map((step) => step.name))) {
    failures.push('contract step hash allowlist must cover every reviewed step');
  }
  for (const [stepName, expectedHash] of Object.entries(CONTRACT_STEP_SHA256)) {
    const step = stepByName(job, stepName);
    if (!step || canonicalSha256(step) !== expectedHash) {
      failures.push(`contract step ${stepName} must match its exact reviewed parsed structure`);
    }
    if (step && 'continue-on-error' in step) {
      failures.push(`contract step ${stepName} must not continue on error`);
    }
  }
  const checkout = stepByName(job, 'Checkout repository without persisted credentials');
  const checkoutInputs = checkout ? recordAt(checkout, 'with') : undefined;
  if (!recordsEqual(checkoutInputs, { 'persist-credentials': false })) {
    failures.push(
      'contract checkout inputs must be exactly persist-credentials:false with no ref, repository, path, or token override',
    );
  }
  const setupVp = stepByName(job, 'Set up Vite+');
  if (!setupVp || !recordsEqual(recordAt(setupVp, 'with'), { 'node-version': '22.x' })) {
    failures.push('contract Vite+ setup must pin exactly Node 22.x with no additional inputs');
  }
  requireRunPattern(
    failures,
    job,
    'Install locked dependencies',
    /^vp install --frozen-lockfile$/,
    'contract workflow must install only the reviewed lockfile graph',
  );
  requireRunPattern(
    failures,
    job,
    'Verify publisher authority and artifact contracts',
    /^vp test run --project scripts scripts\/postgres-image-publisher-contract\.test\.ts --reporter=agent$/,
    'contract workflow must run the focused publisher contract suite through Vite+',
  );
  if (
    /workflow_dispatch:|pull_request_target:|packages:\s+write|id-token:\s+write|attestations:\s+write|environment:/m.test(
      contractWorkflow,
    )
  ) {
    failures.push(
      'contract workflow must never receive dispatch, package, OIDC, attestation, or environment authority',
    );
  }
  for (const requiredPath of CONTRACT_PATHS) {
    if (!contractWorkflow.includes(`'${requiredPath}'`)) {
      failures.push(`contract workflow paths must include ${requiredPath}`);
    }
  }
}

export function containsDockerfileSyntaxDirective(dockerfile: string): boolean {
  const withoutBom = dockerfile.replace(/^\uFEFF/, '');
  return withoutBom.split(/\r?\n/).some((line) => /^[\t ]*#[\t ]*syntax[\t ]*=/i.test(line));
}

export interface PostgresImagePublisherContractInput {
  publisherWorkflow: string;
  contractWorkflow: string;
}

export function createPostgresImagePublisherFailures({
  publisherWorkflow,
  contractWorkflow,
}: PostgresImagePublisherContractInput): string[] {
  const failures: string[] = [];
  const publisher = parseWorkflow(publisherWorkflow, 'publisher workflow', failures);
  const contract = parseWorkflow(contractWorkflow, 'publisher contract workflow', failures);
  if (publisher) validatePublisherDocument(failures, publisher, publisherWorkflow);
  if (contract) validateContractDocument(failures, contract, contractWorkflow);
  return failures;
}
