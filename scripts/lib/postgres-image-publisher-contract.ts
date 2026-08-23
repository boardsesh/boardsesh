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
  setupBun: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
  setupOras: 'oras-project/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d',
  setupQemu: 'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130',
  setupVp: 'voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
} as const;

// The portable image (Railway production, homelab standby, ci.yml) and the
// seeded developer image (Compose, e2e, migration renumber) are published by
// two separate protected-main workflows so that a production publish never
// waits on the ~17-minute seeded build's quiet-main window. Both workflows keep
// the identical trust boundary; every assertion below runs against both.
type PublisherKind = 'portable' | 'seeded';

const PORTABLE_STEPS: Record<string, ExpectedStep[]> = {
  'authorize-current-main': [{ name: 'Bind workflow and audit publisher environment' }],
  'validate-main': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Validate checkout and Docker inputs' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Set up Bun', uses: ACTIONS.setupBun },
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
    { name: 'Set up Bun after registry credential removal', uses: ACTIONS.setupBun },
    { name: 'Install locked dependencies after registry credential removal' },
    { name: 'Verify labels and boot exact portable platform' },
  ],
  'attest-published-digests': [
    { name: 'Recheck exact current main and environment immediately before OIDC attestation' },
    { name: 'Attest exact portable digest', uses: ACTIONS.attest },
  ],
  'verify-attestations': [
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for attestation verification', uses: ACTIONS.login },
    { name: 'Validate the attestation URL and verify the exact subject' },
    { name: 'Remove temporary attestation verification credentials' },
  ],
  'record-published-digests': [
    { name: 'Write machine-readable digest manifest and summary' },
    { name: 'Recheck exact current main and workflow before artifact upload' },
    { name: 'Upload verified digest manifest', uses: ACTIONS.uploadArtifact },
  ],
};

// The seeded image is linux/amd64 only, so its publisher installs no QEMU and
// its smoke job has no platform matrix. Everything else mirrors the portable
// publisher step for step.
const SEEDED_STEPS: Record<string, ExpectedStep[]> = {
  'authorize-current-main': [{ name: 'Bind workflow and audit publisher environment' }],
  'validate-main': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Validate checkout and Docker inputs' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Set up Bun', uses: ACTIONS.setupBun },
    { name: 'Install locked dependencies' },
    { name: 'Run PostgreSQL 18 contracts' },
  ],
  'publish-images': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Validate retired-digest configuration before build setup' },
    { name: 'Create temporary tool and credential boundary' },
    { name: 'Set up Docker Buildx inside the temporary boundary', uses: ACTIONS.setupBuildx },
    { name: 'Set up pinned ORAS client', uses: ACTIONS.setupOras },
    { name: 'Revalidate offline build inputs' },
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
  'smoke-seeded': [
    { name: 'Checkout exact current main commit', uses: ACTIONS.checkout },
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for exact digest pull', uses: ACTIONS.login },
    { name: 'Pull exact seeded digest' },
    { name: 'Remove registry credentials before image smoke' },
    { name: 'Set up Vite+', uses: ACTIONS.setupVp },
    { name: 'Set up Bun after registry credential removal', uses: ACTIONS.setupBun },
    { name: 'Install locked dependencies after registry credential removal' },
    { name: 'Verify labels, architecture, and seeded database' },
  ],
  'attest-published-digests': [
    { name: 'Recheck exact current main and environment immediately before OIDC attestation' },
    { name: 'Attest exact seeded digest', uses: ACTIONS.attest },
  ],
  'verify-attestations': [
    { name: 'Create temporary read-only registry boundary' },
    { name: 'Recheck exact current main immediately before registry authentication' },
    { name: 'Log in to GHCR for attestation verification', uses: ACTIONS.login },
    { name: 'Validate the attestation URL and verify the exact subject' },
    { name: 'Remove temporary attestation verification credentials' },
  ],
  'record-published-digests': [
    { name: 'Write machine-readable digest manifest and summary' },
    { name: 'Recheck exact current main and workflow before artifact upload' },
    { name: 'Upload verified digest manifest', uses: ACTIONS.uploadArtifact },
  ],
};

const PORTABLE_PERMISSIONS: Record<string, UnknownRecord> = {
  'authorize-current-main': { actions: 'read', contents: 'read' },
  'validate-main': { contents: 'read' },
  'publish-images': { actions: 'read', contents: 'read', packages: 'write' },
  'verify-published-images': { contents: 'read', packages: 'read' },
  'smoke-portable': { contents: 'read', packages: 'read' },
  'attest-published-digests': {
    actions: 'read',
    contents: 'read',
    attestations: 'write',
    'id-token': 'write',
  },
  'verify-attestations': { contents: 'read', packages: 'read', attestations: 'read' },
  'record-published-digests': { contents: 'read' },
};

const SEEDED_PERMISSIONS: Record<string, UnknownRecord> = {
  'authorize-current-main': { actions: 'read', contents: 'read' },
  'validate-main': { contents: 'read' },
  'publish-images': { actions: 'read', contents: 'read', packages: 'write' },
  'verify-published-images': { contents: 'read', packages: 'read' },
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

const PORTABLE_NEEDS: Record<string, string[]> = {
  'authorize-current-main': [],
  'validate-main': ['authorize-current-main'],
  'publish-images': ['authorize-current-main', 'validate-main'],
  'verify-published-images': ['authorize-current-main', 'publish-images'],
  'smoke-portable': ['authorize-current-main', 'publish-images', 'verify-published-images'],
  'attest-published-digests': ['authorize-current-main', 'publish-images', 'verify-published-images', 'smoke-portable'],
  'verify-attestations': ['authorize-current-main', 'publish-images', 'attest-published-digests'],
  'record-published-digests': [
    'authorize-current-main',
    'publish-images',
    'attest-published-digests',
    'verify-attestations',
  ],
};

const SEEDED_NEEDS: Record<string, string[]> = {
  'authorize-current-main': [],
  'validate-main': ['authorize-current-main'],
  'publish-images': ['authorize-current-main', 'validate-main'],
  'verify-published-images': ['authorize-current-main', 'publish-images'],
  'smoke-seeded': ['authorize-current-main', 'publish-images', 'verify-published-images'],
  'attest-published-digests': ['authorize-current-main', 'publish-images', 'verify-published-images', 'smoke-seeded'],
  'verify-attestations': ['authorize-current-main', 'publish-images', 'attest-published-digests'],
  'record-published-digests': [
    'authorize-current-main',
    'publish-images',
    'attest-published-digests',
    'verify-attestations',
  ],
};

// These hashes cover every parsed YAML run scalar in each publisher. The
// semantic checks below keep the contract reviewable; this exact-body allowlist
// additionally prevents commands being appended to an otherwise approved named
// step, including in validation and artifact generation. Bodies that are
// deliberately identical in both publishers share a hash, so a one-sided edit
// to a duplicated privileged body fails the contract.
const PORTABLE_RUN_SHA256: Record<string, Record<string, string>> = {
  'authorize-current-main': {
    'Bind workflow and audit publisher environment': 'a5bdefbc565f8a9d530316b439ab2560cb506f8223fa907e424c8a71335e9708',
  },
  'validate-main': {
    'Validate checkout and Docker inputs': 'd93f8b5c79e732dfa0d06bb5469b9437d690374d7f92441f128f64053ba08245',
    'Install locked dependencies': 'ed6ae2ba19763eb56c4691c7113c556bc1dc78a2b5868187f418bcb53ecd3ffd',
    'Run PostgreSQL 18 contracts': '66196ae8703cb101dc49952e602bd24ee2a6e03d7f2902c738bcccafb1b0edf9',
  },
  'publish-images': {
    'Validate retired-digest configuration before build setup':
      '8fa475f67e0d460703ef73b4870570790369d676cd6711209a1416234d54f7f4',
    'Create temporary tool and credential boundary': '84bf5fb7b5ff5e70be8e8684099d2f87727cefde54b3a70b92b20220e3d1fea3',
    'Revalidate offline build inputs': '42ca53a491bf3433739be5ce55f88867c1d7fe5bd4403b33a3647b858596e907',
    'Validate offline layouts and retired digest policy':
      '531e42a15335d2993dba1340c55a01dc56af21701a132682bbb3bbb62fbb5e6b',
    'Recheck exact current main and environment immediately before registry authentication':
      '64ddc967602b4458fc2a6c4cf6c58d4bdf629fcd173db97d2c80e2f4e1e2d509',
    'Authenticate ORAS to GHCR': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Publish exact prevalidated OCI layouts': '258608dbeac18f4b5a6b8de64eae80460fe257813f8d53bfd54f96a462613713',
    'Remove temporary publisher credentials and builder':
      '16caf4c3ec026833a87740a6adf4663ad011649d1dce262530e50f072bfbda91',
  },
  'verify-published-images': {
    'Create temporary read-only registry boundary': '4337f5f5a43cf5dcd887de5e30f094f18d6dc6e4eaec00c9f663bd013085108e',
    'Recheck exact current main immediately before registry authentication':
      '27c9f8d7ad023da4b1e4942699fdb2f8931c2710e03f836cf9e77a012c188a9d',
    'Authenticate ORAS to GHCR read-only': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Verify exact remote manifests': '2039da08f53129209e7d171e020dc9980aa37a5adb7af70556633d224f432747',
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
      'ed6ae2ba19763eb56c4691c7113c556bc1dc78a2b5868187f418bcb53ecd3ffd',
    'Verify labels and boot exact portable platform':
      '5b9c73161f472d49ebed0409acef7cd36f3aa0c0ddc6c11e02ce73a49f45356c',
  },
  'attest-published-digests': {
    'Recheck exact current main and environment immediately before OIDC attestation':
      'ba63aad32d3c4db72db7bbed48281df422c0be9f1441cdbec1464649635262af',
  },
  'verify-attestations': {
    'Create temporary read-only registry boundary': 'a5e51a8c6a73ccc35f8f25aa870fed6434dada853729687d5ce8fb8414cf4a3c',
    'Recheck exact current main immediately before registry authentication':
      '27c9f8d7ad023da4b1e4942699fdb2f8931c2710e03f836cf9e77a012c188a9d',
    'Validate the attestation URL and verify the exact subject':
      '234b7c43e88dbd2e78e2d699e4a19a7241df84844df2f3135eba2738d2067576',
    'Remove temporary attestation verification credentials':
      '1eb783af4e7705bd00ca9b7ac9b47ebe5664c1a3a6c641d3edfb30a7fe10b48d',
  },
  'record-published-digests': {
    'Write machine-readable digest manifest and summary':
      'ad5147ca125adff1bff78fa9fa00491a0a358b02bef525625d75d052df1a1b51',
    'Recheck exact current main and workflow before artifact upload':
      '3fd4d1ae5661abcd1101d9a60addb336e7d61cb30e362c75710da08560cbab0c',
  },
};

const SEEDED_RUN_SHA256: Record<string, Record<string, string>> = {
  'authorize-current-main': {
    'Bind workflow and audit publisher environment': 'a5bdefbc565f8a9d530316b439ab2560cb506f8223fa907e424c8a71335e9708',
  },
  'validate-main': {
    'Validate checkout and Docker inputs': 'd93f8b5c79e732dfa0d06bb5469b9437d690374d7f92441f128f64053ba08245',
    'Install locked dependencies': 'ed6ae2ba19763eb56c4691c7113c556bc1dc78a2b5868187f418bcb53ecd3ffd',
    'Run PostgreSQL 18 contracts': '66196ae8703cb101dc49952e602bd24ee2a6e03d7f2902c738bcccafb1b0edf9',
  },
  'publish-images': {
    'Validate retired-digest configuration before build setup':
      '8fa475f67e0d460703ef73b4870570790369d676cd6711209a1416234d54f7f4',
    'Create temporary tool and credential boundary': '84bf5fb7b5ff5e70be8e8684099d2f87727cefde54b3a70b92b20220e3d1fea3',
    'Revalidate offline build inputs': '42ca53a491bf3433739be5ce55f88867c1d7fe5bd4403b33a3647b858596e907',
    'Validate offline layouts and retired digest policy':
      'a06b4c13a701a41cb2640056c198b81484bf96a41a1baff3a7b2e70c596ca570',
    'Recheck exact current main and environment immediately before registry authentication':
      '64ddc967602b4458fc2a6c4cf6c58d4bdf629fcd173db97d2c80e2f4e1e2d509',
    'Authenticate ORAS to GHCR': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Publish exact prevalidated OCI layouts': '9b5e9d8fc7741858265dcbad7b2e8ac63c4e3ca355255e54001f4923bce8a6ef',
    'Remove temporary publisher credentials and builder':
      '1edb13a64ba9e0f47e791aaf97d9dcc4b1c40db0c01eebc7e30452b5542a59ba',
  },
  'verify-published-images': {
    'Create temporary read-only registry boundary': '4337f5f5a43cf5dcd887de5e30f094f18d6dc6e4eaec00c9f663bd013085108e',
    'Recheck exact current main immediately before registry authentication':
      '27c9f8d7ad023da4b1e4942699fdb2f8931c2710e03f836cf9e77a012c188a9d',
    'Authenticate ORAS to GHCR read-only': '2409cc90e42b7448aba3c40d18a741735d513a6fdc0f2212544407fb09f3a4ce',
    'Verify exact remote manifests': 'b876af83f2d9d34c4004248ea18da503f9543e4bc6f5381445cb0b339a0e0117',
    'Remove temporary read-only registry credentials':
      '9a101fad60773bbfc7c39cf84f5d09df89d0a5f025d71aa7d2b3e7c8f2d16923',
  },
  'smoke-seeded': {
    'Create temporary read-only registry boundary': 'e8e2af6b76ef37f5a646991d6034bbf0011fe940e1b5e7f6542f7655de30cea6',
    'Recheck exact current main immediately before registry authentication':
      '211bb881d05b4c506f7d2f2e18c6302a3a24a818f6396c386e8aa9da4908b939',
    'Pull exact seeded digest': '9c8092a89440ffcf4cf5b154ecb0f604c6ef2dd4ee519f705cfd414562c86c80',
    'Remove registry credentials before image smoke':
      '210b45c7e9c243d42c1180f419bc5183b425a71b78f018f01c19e7ea4402d60c',
    'Install locked dependencies after registry credential removal':
      'ed6ae2ba19763eb56c4691c7113c556bc1dc78a2b5868187f418bcb53ecd3ffd',
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
    'Validate the attestation URL and verify the exact subject':
      '6eeff90870cda6c9ea453945169929d5c3f4b8fb832033f1c12a4ae295b9101f',
    'Remove temporary attestation verification credentials':
      '1eb783af4e7705bd00ca9b7ac9b47ebe5664c1a3a6c641d3edfb30a7fe10b48d',
  },
  'record-published-digests': {
    'Write machine-readable digest manifest and summary':
      'e15f29b507ee967aebaf25959e022f508a215a973f2e3c330e78d79c5b35c302',
    'Recheck exact current main and workflow before artifact upload':
      '3fd4d1ae5661abcd1101d9a60addb336e7d61cb30e362c75710da08560cbab0c',
  },
};

// Canonical parsed-job hashes also freeze action inputs, step environments,
// conditions, outputs, and matrices. Together with the readable assertions,
// this makes each publisher an exact structural allowlist.
const PORTABLE_JOB_SHA256: Record<string, string> = {
  'authorize-current-main': '012c58011b4370b349d5f7dcfe89171bcfdf3e0653b459ab9fcbd865d3fc54c7',
  'validate-main': '79a3b6710f2f3268d467ae5a8d467d78fd212627f90f3da8c6505b1a4c51b29d',
  'publish-images': '23661fb209cd2b8fc5bb9c0d4a0d3ef03ee1e92d863b332cf4dd73208c7931dd',
  'verify-published-images': '4daa8aff5b4a4c14876ab97b5dddb089c38462927540e66ca45cf9e5470ba56a',
  'smoke-portable': 'b5061e0cb86febdc3216af60b967ddf3825b7c74b43016d006d0d1aa245351ba',
  'attest-published-digests': 'ca7523b1b504df41647a9ca8ea7224fb258f908f9385ea10d62dcf1048a3039c',
  'verify-attestations': '7d832ccbf02bbe4521b70cbe55f916f2b03fa0ea39229b4cde897cd3a73fd659',
  'record-published-digests': 'ed3fee4108e2cb0cc67c91171bcc5bc62d2f098717f3efc8b9d68b036e54a1f8',
};

const SEEDED_JOB_SHA256: Record<string, string> = {
  'authorize-current-main': '26daa41dc074db1477d4550c5e257c575733edc547a5f5d16c7f9b200b6453c6',
  'validate-main': '79a3b6710f2f3268d467ae5a8d467d78fd212627f90f3da8c6505b1a4c51b29d',
  'publish-images': '7a74102848d3359bc6bd6df1ac3e5dea6db94dd1f072ed904a61baaf84842b28',
  'verify-published-images': '2119fd689277fda45fb31524d4e3794084d3c78c8c9c278885130d6bf7ef7b8a',
  'smoke-seeded': '95bf708acbe676a46dde4981cc83ba978c37f6b6c3ca463ef2239647260ebdf9',
  'attest-published-digests': '317b0556c9bbc6fe7f1209a4bacc20f84d400a1e42a64b24c89af6cc3be97ab4',
  'verify-attestations': 'ad572d9ab94f9fc196ff4de165070d04e6c6ddc05468347c5c186f308f572a92',
  'record-published-digests': 'b41f60261db040a18095f4da150d68c1419a998d60a535ab47cee3df33c5f2ee',
};

interface PublisherSpec {
  kind: PublisherKind;
  label: string;
  workflowPath: string;
  workflowName: string;
  concurrencyGroup: string;
  imageEnvironmentKey: string;
  imageReference: string;
  digestOutput: string;
  attestationUrlOutput: string;
  buildStepName: string;
  attestStepName: string;
  smokeJobName: string;
  smokeCandidateStepName: string;
  artifactName: string;
  artifactPath: string;
  installsArmEmulation: boolean;
  layoutPatterns: readonly (readonly [RegExp, string])[];
  remoteManifestPatterns: readonly (readonly [RegExp, string])[];
  forbiddenIdentifiers: readonly string[];
  steps: Record<string, ExpectedStep[]>;
  permissions: Record<string, UnknownRecord>;
  needs: Record<string, string[]>;
  runHashes: Record<string, Record<string, string>>;
  jobHashes: Record<string, string>;
}

const PORTABLE_SPEC: PublisherSpec = {
  kind: 'portable',
  label: 'portable publisher',
  workflowPath: '.github/workflows/postgres-image-publisher.yml',
  workflowName: 'Publish Current Main Portable PostgreSQL Image',
  concurrencyGroup: 'postgres-image-publisher',
  imageEnvironmentKey: 'PORTABLE_IMAGE',
  imageReference: 'ghcr.io/boardsesh/boardsesh-postgres-postgis',
  digestOutput: 'portable_digest',
  attestationUrlOutput: 'portable_attestation_url',
  buildStepName: 'Build portable OCI layout without registry credentials',
  attestStepName: 'Attest exact portable digest',
  smokeJobName: 'smoke-portable',
  smokeCandidateStepName: 'Verify labels and boot exact portable platform',
  artifactName: 'postgres-image-digests-${{ inputs.expected_main_sha }}',
  artifactPath: 'postgres-image-digests.json',
  installsArmEmulation: true,
  layoutPatterns: [
    [/portable_digest="\$\(layout_digest/, 'portable digest must come from the offline OCI layout'],
    [/\["linux\/amd64","linux\/arm64"\]/, 'portable offline layout must have its exact platforms'],
  ],
  remoteManifestPatterns: [
    [/\["linux\/amd64", "linux\/arm64"\]/, 'remote portable manifest must expose exactly amd64 and arm64'],
  ],
  forbiddenIdentifiers: ['SEEDED_IMAGE', 'boardsesh-dev-db', 'smoke-seeded', 'seeded-oci', 'seeded_digest'],
  steps: PORTABLE_STEPS,
  permissions: PORTABLE_PERMISSIONS,
  needs: PORTABLE_NEEDS,
  runHashes: PORTABLE_RUN_SHA256,
  jobHashes: PORTABLE_JOB_SHA256,
};

const SEEDED_SPEC: PublisherSpec = {
  kind: 'seeded',
  label: 'seeded publisher',
  workflowPath: '.github/workflows/postgres-seeded-image-publisher.yml',
  workflowName: 'Publish Current Main Seeded PostgreSQL Image',
  concurrencyGroup: 'postgres-seeded-image-publisher',
  imageEnvironmentKey: 'SEEDED_IMAGE',
  imageReference: 'ghcr.io/boardsesh/boardsesh-dev-db',
  digestOutput: 'seeded_digest',
  attestationUrlOutput: 'seeded_attestation_url',
  buildStepName: 'Build seeded OCI layout without registry credentials',
  attestStepName: 'Attest exact seeded digest',
  smokeJobName: 'smoke-seeded',
  smokeCandidateStepName: 'Verify labels, architecture, and seeded database',
  artifactName: 'postgres-seeded-image-digest-${{ inputs.expected_main_sha }}',
  artifactPath: 'postgres-seeded-image-digest.json',
  installsArmEmulation: false,
  layoutPatterns: [
    [/seeded_digest="\$\(layout_digest/, 'seeded digest must come from the offline OCI layout'],
    [/\["linux\/amd64"\]/, 'seeded offline layout must have its exact platform'],
  ],
  remoteManifestPatterns: [
    [/\["linux\/amd64"\]/, 'remote seeded manifest must expose exactly amd64'],
    [
      /jq -e '\.os == "linux" and \.architecture == "amd64"' seeded-config\.json/,
      'remote seeded verification must fall back to the image config architecture',
    ],
  ],
  forbiddenIdentifiers: [
    'PORTABLE_IMAGE',
    'boardsesh-postgres-postgis',
    'smoke-portable',
    'portable-oci',
    'portable_digest',
  ],
  steps: SEEDED_STEPS,
  permissions: SEEDED_PERMISSIONS,
  needs: SEEDED_NEEDS,
  runHashes: SEEDED_RUN_SHA256,
  jobHashes: SEEDED_JOB_SHA256,
};

const CONTRACT_PATHS = [
  '.github/workflows/postgres-image-publisher.yml',
  '.github/workflows/postgres-seeded-image-publisher.yml',
  '.github/workflows/postgres-image-publisher-contract.yml',
  'vite.config.ts',
  'scripts/lib/postgres-image-publisher-contract.ts',
  'scripts/postgres-image-publisher-contract.test.ts',
  'scripts/vite.config.ts',
  'docs/postgres-image-publishing.md',
  'package.json',
  'bun.lock',
];

const CONTRACT_STEPS: ExpectedStep[] = [
  { name: 'Checkout repository without persisted credentials', uses: ACTIONS.checkout },
  { name: 'Set up Bun', uses: ACTIONS.setupBun },
  { name: 'Set up Vite+', uses: ACTIONS.setupVp },
  { name: 'Install locked dependencies' },
  { name: 'Verify publisher authority and artifact contracts' },
];

const CONTRACT_WORKFLOW_METADATA_SHA256 = 'df2485656ff61d77c91766bd962c59ce24c991e45ad659038a43711d92198cbd';
const CONTRACT_JOB_METADATA_SHA256 = '9e0f951e6bceb41814be7e67f5cfe5cf5d808315af99a39bc312cbce1c7f0cfb';
const CONTRACT_STEP_SHA256: Record<string, string> = {
  'Checkout repository without persisted credentials':
    '21d3640a58fa24bec3a2646f701ef5ce7da14567f1a979619cc77e2d942e3726',
  'Set up Bun': '52cce4bc718eb16dd89360b915f63c3a1f464843e2d77f3c56fd82c57f9428d2',
  'Set up Vite+': '40a4b08ab8203cbd60ae414ad927ba8f6bb95366bc8fe49bb4900fe7d5cc9cdd',
  'Install locked dependencies': 'a90a77d14957fc0ffcc990ff99babb6641c2317df07d69759fca6ebae04cd981',
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

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function validatePrivilegedRunBodies(failures: string[], spec: PublisherSpec, jobs: UnknownRecord): void {
  for (const [jobName, reviewedHashes] of Object.entries(spec.runHashes)) {
    const expectedRunNames = spec.steps[jobName].filter((step) => step.uses === undefined).map((step) => step.name);
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

function validatePrivilegedJobs(failures: string[], spec: PublisherSpec, jobs: UnknownRecord): void {
  if (JSON.stringify(Object.keys(spec.jobHashes)) !== JSON.stringify(Object.keys(spec.runHashes))) {
    failures.push('privileged parsed-job and run-body allowlists must cover the same jobs');
    return;
  }
  for (const [jobName, expectedHash] of Object.entries(spec.jobHashes)) {
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

function validateBuildStep(failures: string[], step: UnknownRecord | undefined, kind: PublisherKind): void {
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

function validatePublisherDocument(
  scopedFailures: string[],
  spec: PublisherSpec,
  publisher: UnknownRecord,
  publisherWorkflow: string,
): void {
  const failures = scopedFailures;
  if (!keysEqual(publisher, ['name', 'on', 'concurrency', 'env', 'jobs'])) {
    failures.push('publisher top-level keys must match the exact executable allowlist with no defaults');
  }
  if (publisher.name !== spec.workflowName) {
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
  if (!recordsEqual(concurrency, { group: spec.concurrencyGroup, 'cancel-in-progress': false })) {
    failures.push(
      'publisher must serialize every run in its own concurrency group without cancelling an active publication',
    );
  }

  const expectedEnvironment: UnknownRecord = {
    APPROVED_REPOSITORY: 'boardsesh/boardsesh',
    DEFAULT_BRANCH: 'main',
    PUBLISHER_ENVIRONMENT: 'postgres-image-publisher',
    REGISTRY: 'ghcr.io',
    [spec.imageEnvironmentKey]: spec.imageReference,
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
  const expectedJobNames = Object.keys(spec.steps);
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(expectedJobNames)) {
    failures.push('publisher jobs must match the exact reviewed job allowlist and order');
  }

  for (const jobName of expectedJobNames) {
    const job = recordAt(jobs, jobName);
    if (!job) {
      failures.push(`publisher is missing ${jobName}`);
      continue;
    }
    validateStepAllowlist(failures, jobName, job, spec.steps[jobName]);
    if (!recordsEqual(recordAt(job, 'permissions'), spec.permissions[jobName])) {
      failures.push(`${jobName} permissions must match its exact allowlist`);
    }
    if (JSON.stringify(normalizedStringArray(job.needs)) !== JSON.stringify([...spec.needs[jobName]].sort())) {
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
  validatePrivilegedRunBodies(failures, spec, jobs);
  validatePrivilegedJobs(failures, spec, jobs);

  const expectedWorkflowRef = `boardsesh/boardsesh/${spec.workflowPath}@refs/heads/main`;
  for (const [jobName, stepName] of [
    ['authorize-current-main', 'Bind workflow and audit publisher environment'],
    ['record-published-digests', 'Recheck exact current main and workflow before artifact upload'],
  ] as const) {
    const stepEnvironment = recordAt(stepByName(recordAt(jobs, jobName) ?? {}, stepName) ?? {}, 'env');
    if (!stepEnvironment || stepEnvironment.EXPECTED_WORKFLOW_REF !== expectedWorkflowRef) {
      failures.push(`${jobName} must bind EXPECTED_WORKFLOW_REF to its own protected-main workflow path`);
    }
  }

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
  if (spec.installsArmEmulation) {
    const publisherQemu = stepByName(publish, 'Enable multi-architecture emulation');
    const publisherQemuInputs = publisherQemu ? recordAt(publisherQemu, 'with') : undefined;
    if (
      !publisherQemuInputs ||
      publisherQemuInputs.image !==
        'tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0' ||
      publisherQemuInputs.platforms !== 'arm64'
    ) {
      failures.push('portable publisher QEMU must use only the reviewed digest-pinned ARM64 helper');
    }
  }
  validateBuildStep(failures, stepByName(publish, spec.buildStepName), spec.kind);
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
    ...spec.layoutPatterns,
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
  if ((publishRun.match(/oras cp --from-oci-layout/g) ?? []).length !== 1) {
    failures.push('publisher must copy exactly its one prevalidated OCI layout after login');
  }
  if (
    (publishRun.match(new RegExp(`"\\$${escapeForRegExp(spec.imageEnvironmentKey)}:\\$SHA_TAG"`, 'g')) ?? []).length !==
    2
  ) {
    failures.push('publisher must publish its exact prevalidated OCI layout under only its SHA tag');
  }
  if (/\b(?:vp|bun|npm|npx)\b|source\/scripts|docker build/.test(publishRun)) {
    failures.push('publisher must not run checked-out helpers or rebuild after registry login');
  }

  const verifyImages = recordAt(jobs, 'verify-published-images') ?? {};
  validateOrasSetup(failures, 'verify-published-images', verifyImages);
  for (const [pattern, message] of spec.remoteManifestPatterns) {
    requireRunPattern(failures, verifyImages, 'Verify exact remote manifests', pattern, message);
  }

  const smokeJobName = spec.smokeJobName;
  const smoke = recordAt(jobs, smokeJobName) ?? {};
  validateCheckout(failures, smokeJobName, stepByName(smoke, 'Checkout exact current main commit'));
  requireRunPattern(
    failures,
    smoke,
    'Recheck exact current main immediately before registry authentication',
    /git\/ref\/heads\/\$DEFAULT_BRANCH/,
    `${smokeJobName} must recheck live main immediately before login`,
  );
  requireRunPattern(
    failures,
    smoke,
    'Install locked dependencies after registry credential removal',
    /^bun install --frozen-lockfile$/,
    `${smokeJobName} must install only the reviewed lockfile graph before running candidate smoke code`,
  );

  const smokeSteps = stepsAt(smoke);
  const credentialRemovalIndex = smokeSteps.findIndex(
    (step) => step.name === 'Remove registry credentials before image smoke',
  );
  const setupVpIndex = smokeSteps.findIndex((step) => step.name === 'Set up Vite+');
  const setupBunIndex = smokeSteps.findIndex((step) => step.name === 'Set up Bun after registry credential removal');
  const dependencyInstallIndex = smokeSteps.findIndex(
    (step) => step.name === 'Install locked dependencies after registry credential removal',
  );
  const candidateSmokeIndex = smokeSteps.findIndex((step) => step.name === spec.smokeCandidateStepName);
  if (
    credentialRemovalIndex < 0 ||
    setupVpIndex <= credentialRemovalIndex ||
    setupBunIndex <= setupVpIndex ||
    dependencyInstallIndex <= setupBunIndex ||
    candidateSmokeIndex <= dependencyInstallIndex
  ) {
    failures.push(`${smokeJobName} tool and dependency setup must occur only after registry credentials are removed`);
  }

  if (spec.kind === 'portable') {
    if (
      !recordsEqual(recordAt(smoke, 'strategy'), {
        'fail-fast': false,
        matrix: { platform: ['linux/amd64', 'linux/arm64'] },
      })
    ) {
      failures.push('portable smoke matrix must contain exactly linux/amd64 and linux/arm64');
    }
    const smokeQemu = stepByName(smoke, 'Enable multi-architecture emulation');
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
  } else if ('strategy' in smoke) {
    failures.push('seeded smoke must run a single linux/amd64 job without a platform matrix');
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
  {
    const step = stepByName(attest, spec.attestStepName);
    const withInputs = step ? recordAt(step, 'with') : undefined;
    if (
      !withInputs ||
      JSON.stringify(Object.keys(withInputs)) !==
        JSON.stringify(['subject-name', 'subject-digest', 'push-to-registry']) ||
      withInputs['subject-name'] !== `\${{ env.${spec.imageEnvironmentKey} }}` ||
      withInputs['subject-digest'] !== `\${{ needs.publish-images.outputs.${spec.digestOutput} }}` ||
      withInputs['push-to-registry'] !== false
    ) {
      failures.push(`${spec.attestStepName} must use native source-aware provenance for only its exact digest`);
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
      new RegExp(`--signer-workflow "\\$APPROVED_REPOSITORY/${escapeForRegExp(spec.workflowPath)}"`),
      'downstream verification must pin its own signer workflow',
    ],
    [/--signer-digest "\$EXPECTED_MAIN_SHA"/, 'downstream verification must pin the signer SHA'],
    [/--source-ref "\$MAIN_REF"/, 'downstream verification must pin refs/heads/main'],
    [/--source-digest "\$EXPECTED_MAIN_SHA"/, 'downstream verification must pin the source SHA'],
    [/--deny-self-hosted-runners/, 'downstream verification must reject self-hosted attestations'],
    [
      new RegExp(`verify_attestation "\\$${escapeForRegExp(spec.imageEnvironmentKey)}"`),
      'downstream verification must verify its own image attestation',
    ],
  ] as const) {
    requireRunPattern(
      failures,
      verifyAttestations,
      'Validate the attestation URL and verify the exact subject',
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
    new RegExp(`images: \\{\\s+${spec.kind}: \\{`),
    'digest handoff must record only the image this publisher owns',
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
  const uploadStep = stepByName(recordJob, 'Upload verified digest manifest');
  const uploadInputs = uploadStep ? recordAt(uploadStep, 'with') : undefined;
  if (
    !recordsEqual(uploadInputs, {
      name: spec.artifactName,
      path: spec.artifactPath,
      'if-no-files-found': 'error',
      'retention-days': 90,
    })
  ) {
    failures.push('digest handoff artifact must use its exact reviewed name, path, and retention');
  }
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

// A weakening that recouples the two publishers, or that re-serializes the
// seeded developer image behind the portable production image, has to change
// one of these constants as well as the workflow it edits.
function validatePublisherSeparation(failures: string[]): void {
  if (PORTABLE_SPEC.workflowPath === SEEDED_SPEC.workflowPath) {
    failures.push('the portable and seeded publishers must live at different protected-main workflow paths');
  }
  if (PORTABLE_SPEC.workflowName === SEEDED_SPEC.workflowName) {
    failures.push('the portable and seeded publishers must be dispatchable by distinct names');
  }
  if (PORTABLE_SPEC.imageReference === SEEDED_SPEC.imageReference) {
    failures.push('the portable and seeded publishers must publish different images');
  }
  if (PORTABLE_SPEC.artifactName === SEEDED_SPEC.artifactName) {
    failures.push('the portable and seeded publishers must upload different digest handoff artifacts');
  }
  if (PORTABLE_SPEC.concurrencyGroup === SEEDED_SPEC.concurrencyGroup) {
    failures.push('the seeded publisher must not share the portable publisher concurrency group');
  }
}

function validateContractDocument(failures: string[], contract: UnknownRecord, contractWorkflow: string): void {
  if (!keysEqual(contract, ['name', 'on', 'permissions', 'jobs'])) {
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
  requireRunPattern(
    failures,
    job,
    'Install locked dependencies',
    /^bun install --frozen-lockfile$/,
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
  portablePublisherWorkflow: string;
  seededPublisherWorkflow: string;
  contractWorkflow: string;
}

export function createPostgresImagePublisherFailures({
  portablePublisherWorkflow,
  seededPublisherWorkflow,
  contractWorkflow,
}: PostgresImagePublisherContractInput): string[] {
  const failures: string[] = [];
  validatePublisherSeparation(failures);
  for (const [spec, source] of [
    [PORTABLE_SPEC, portablePublisherWorkflow],
    [SEEDED_SPEC, seededPublisherWorkflow],
  ] as const) {
    const scopedFailures: string[] = [];
    const publisher = parseWorkflow(source, `${spec.label} workflow`, failures);
    if (publisher) validatePublisherDocument(scopedFailures, spec, publisher, source);
    failures.push(...scopedFailures.map((message) => `${spec.label}: ${message}`));
  }
  const contract = parseWorkflow(contractWorkflow, 'publisher contract workflow', failures);
  if (contract) validateContractDocument(failures, contract, contractWorkflow);
  return failures;
}
