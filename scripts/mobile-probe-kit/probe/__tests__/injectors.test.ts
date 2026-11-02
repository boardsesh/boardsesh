/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_CREDENTIAL,
  ACTIVATION_PRIVACY,
  CORE_FRAMES,
  FIXTURE_VARIANTS,
  LOCAL_CURRENT,
  LOCAL_LEGACY,
  MEASURED_WIDTH,
  REANIMATED_CURRENT,
  NETWORK_CURRENT,
  NETWORK_LEGACY,
  probeFixture,
  type FixtureVariant,
} from './fixtures';

const injectorDirectory = resolve(import.meta.dirname, '..');
const fixtureRoots: string[] = [];
const OFFLINE = 'src/lib/graphql/offline-request.ts';
const ACTIVATION = 'src/lib/playlists/use-playlist-activation.ts';
const CORE = 'src/components/play-drawer/PlayCore.tsx';

function writeSource(root: string, relative: string, source: string) {
  const path = join(root, 'packages/mobile', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function makeFixture(variant: FixtureVariant = 'current-credential') {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-probe-injector-'));
  fixtureRoots.push(root);
  for (const [relative, source] of Object.entries(probeFixture(variant))) writeSource(root, relative, source);
  return root;
}

function readSource(root: string, relative: string) {
  return readFileSync(join(root, 'packages/mobile', relative), 'utf8');
}

function snapshot(root: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const relative of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (relative.isFile()) {
      const path = join(relative.parentPath, relative.name);
      contents[path.slice(root.length)] = readFileSync(path).toString('base64');
    }
  }
  return contents;
}

function inject(root: string, name: 'standard' | 'opening', ...flags: string[]) {
  return spawnSync(
    'python3',
    [
      '-I',
      join(injectorDirectory, name === 'standard' ? 'apply_probes.py' : 'apply_opening_probes.py'),
      root,
      ...flags,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

function applyStandard(root: string, ...flags: string[]) {
  const result = inject(root, 'standard', ...flags);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result;
}

function expectUnchangedFailure(root: string, name: 'standard' | 'opening', message: string, relative?: string) {
  const before = snapshot(root);
  const result = inject(root, name);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  if (relative) expect(result.stderr).toContain(relative);
  expect(snapshot(root)).toEqual(before);
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('probe injector supported source variants', () => {
  it.each(FIXTURE_VARIANTS)('applies both stages to %s without changing request or rejection semantics', (variant) => {
    const root = makeFixture(variant);
    applyStandard(root);
    const result = inject(root, 'opening');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const current = variant.startsWith('current-');
    const offline = readSource(root, OFFLINE);
    expect(offline).toContain(current ? LOCAL_CURRENT : LOCAL_LEGACY);
    expect(offline).toContain(current ? NETWORK_CURRENT : NETWORK_LEGACY);
    expect(offline).toContain(
      `const probeOwner = localDb ? await ${current ? 'isLocalDataOwnerCurrent' : 'canReadPrivateCatalog'}(localDb) : false;`,
    );
    expect(
      readSource(root, 'app/(tabs)/climbs/index.tsx').match(/if \(isPlaceholderDataRef.current\) return;/g),
    ).toHaveLength(1);
    expect(offline.match(/perfProbe\('offline-request'/g)).toHaveLength(2);
    expect(readSource(root, 'src/lib/perf-probe.ts')).toContain('export function probeOpeningTap');
    const carousel = readSource(root, 'src/components/play-drawer/SwipeBoardCarousel.tsx');
    expect(carousel.indexOf('const probeBoardMeasured')).toBeGreaterThan(carousel.indexOf('const boardBox'));
    expect(carousel.match(/\brunOnUI\b/g)).toHaveLength(2);

    if (variant === 'baseline') {
      expect(readSource(root, 'src/components/LayeredClimbImage.tsx')).toContain(
        'onProbeArtDisplayed?.(overlayLoadKey ?? null)',
      );
    } else {
      const activation = readSource(root, ACTIVATION);
      expect(activation.match(/probeOpeningRejected\(requestedClimb.uuid/g)).toHaveLength(
        variant === 'candidate' ? 3 : 1,
      );
      expect(activation).toContain(variant === 'candidate' ? 'suppliedClimbs.length' : 'allClimbs.length');
      expect(activation).toContain(
        variant === 'current-credential'
          ? 'credentialGeneration !== getCredentialGeneration()'
          : 'privacyGeneration !== getPrivacyRevocationGeneration()',
      );
      expect(readSource(root, CORE)).toContain("perfProbe('play-full-art-displayed'");
      expect(readSource(root, 'src/components/LayeredClimbImage.tsx')).toContain(
        'noteBoardArtInMemory(backgroundImageUri(path))',
      );
    }
  });

  it('only settles consent when the caller requests it', () => {
    for (const settle of [false, true]) {
      const root = makeFixture();
      const before = readSource(root, 'src/components/onboarding/ConsentGate.tsx');
      applyStandard(root, ...(settle ? ['--settle-consent'] : []));
      const consent = readSource(root, 'src/components/onboarding/ConsentGate.tsx');
      if (settle) expect(consent).toContain("process.env.EXPO_PUBLIC_PERF_PROBE === '1'");
      else expect(consent).toBe(before);
    }
  });
});

describe('probe injectors reject unsupported anchors before writing', () => {
  it.each(['missing', 'duplicate'] as const)(
    'standard stage leaves every file unchanged for a %s late network anchor',
    (fault) => {
      const root = makeFixture();
      writeSource(
        root,
        OFFLINE,
        readSource(root, OFFLINE).replace(NETWORK_CURRENT, fault === 'missing' ? '' : NETWORK_CURRENT.repeat(2)),
      );
      expectUnchangedFailure(root, 'standard', 'expected exactly one supported anchor variant', OFFLINE);
    },
  );

  it.each(['missing', 'duplicate'] as const)(
    'standard stage rejects a %s exact anchor without creating its module',
    (fault) => {
      const root = makeFixture();
      const relative = 'src/hooks/use-native-climb-render.ts';
      const anchor = '  onOverlayLoad: (loadKey: string | null) => void;';
      writeSource(
        root,
        relative,
        readSource(root, relative).replace(anchor, fault === 'missing' ? '' : anchor.repeat(2)),
      );
      expectUnchangedFailure(root, 'standard', 'expected exactly one anchor', relative);
    },
  );

  it('standard stage rejects mixed historical and current request variants', () => {
    const root = makeFixture();
    writeSource(root, OFFLINE, readSource(root, OFFLINE) + NETWORK_LEGACY);
    expectUnchangedFailure(root, 'standard', 'expected exactly one supported anchor variant', OFFLINE);
  });

  it.each(['missing', 'mixed'] as const)('standard stage rejects a %s local gate helper', (fault) => {
    const root = makeFixture();
    const gate = '(await isLocalDataOwnerCurrent(localDb))';
    const offline = readSource(root, OFFLINE);
    writeSource(
      root,
      OFFLINE,
      fault === 'missing' ? offline.replace(gate, '') : offline + '(await canReadPrivateCatalog(localDb))',
    );
    expectUnchangedFailure(root, 'standard', 'expected exactly one supported local gate helper', OFFLINE);
  });

  it.each(['missing', 'duplicate'] as const)(
    'opening stage leaves standard probes untouched for a %s late PlayCore anchor',
    (fault) => {
      const root = makeFixture();
      applyStandard(root);
      writeSource(
        root,
        CORE,
        readSource(root, CORE).replace(CORE_FRAMES, fault === 'missing' ? '' : CORE_FRAMES.repeat(2)),
      );
      expectUnchangedFailure(root, 'opening', 'expected exactly one anchor', CORE);
    },
  );

  it.each(['missing', 'duplicate'] as const)(
    'opening stage rejects a %s single activation guard atomically',
    (fault) => {
      const root = makeFixture();
      applyStandard(root);
      writeSource(
        root,
        ACTIVATION,
        readSource(root, ACTIVATION).replace(
          ACTIVATION_CREDENTIAL,
          fault === 'missing' ? '' : ACTIVATION_CREDENTIAL.repeat(2),
        ),
      );
      expectUnchangedFailure(root, 'opening', 'expected exactly one supported activation guard', ACTIVATION);
    },
  );

  it('opening stage rejects conflicting single-generation variants', () => {
    const root = makeFixture();
    applyStandard(root);
    writeSource(root, ACTIVATION, readSource(root, ACTIVATION) + ACTIVATION_PRIVACY);
    expectUnchangedFailure(root, 'opening', 'expected exactly one supported activation guard', ACTIVATION);
  });

  it('opening stage rejects a partial historical guard mixed with a current guard', () => {
    const root = makeFixture();
    applyStandard(root);
    writeSource(root, ACTIVATION, readSource(root, ACTIVATION) + 'capturedGeneration !== undefined');
    expectUnchangedFailure(root, 'opening', 'unsupported mixed activation guards', ACTIVATION);
  });

  it.each(['missing', 'duplicate'] as const)('opening stage rejects a %s Reanimated import atomically', (fault) => {
    const root = makeFixture();
    applyStandard(root);
    const carousel = 'src/components/play-drawer/SwipeBoardCarousel.tsx';
    writeSource(
      root,
      carousel,
      readSource(root, carousel).replace(REANIMATED_CURRENT, fault === 'missing' ? '' : REANIMATED_CURRENT.repeat(2)),
    );
    expectUnchangedFailure(root, 'opening', 'expected exactly one supported Reanimated import', carousel);
  });

  it('standard stage rejects a missing post-geometry measurement anchor atomically', () => {
    const root = makeFixture();
    const carousel = 'src/components/play-drawer/SwipeBoardCarousel.tsx';
    writeSource(root, carousel, readSource(root, carousel).replace(MEASURED_WIDTH, ''));
    expectUnchangedFailure(root, 'standard', 'expected exactly one anchor', carousel);
  });

  it('opening stage requires the standard probe module', () => {
    const root = makeFixture();
    expectUnchangedFailure(root, 'opening', 'apply standard probes first');
  });

  it('opening stage rejects duplicate standard probe exports without writing', () => {
    const root = makeFixture();
    applyStandard(root);
    const probe = 'src/lib/perf-probe.ts';
    writeSource(root, probe, readSource(root, probe) + '\nexport function perfProbeUi(duplicate: string): void {}');
    expectUnchangedFailure(root, 'opening', 'apply standard probes first', probe);
  });

  it.each(['standard', 'opening'] as const)('a second %s application fails without additional writes', (name) => {
    const root = makeFixture();
    applyStandard(root);
    if (name === 'opening') expect(inject(root, 'opening').status).toBe(0);
    expectUnchangedFailure(root, name, 'already applied');
  });
});
