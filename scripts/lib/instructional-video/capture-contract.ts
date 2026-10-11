import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { TutorialAnchor, TutorialTake, TutorialTakeManifest } from './types';
const sha = (content: string) => createHash('sha256').update(content).digest('hex');

/** Carry the measured rectangle through a trim and map dp into screen fractions. */
export function trimTutorialAnchors(
  samples: readonly TutorialAnchor[],
  trim: number,
  screen: Readonly<{ width: number; height: number }>,
  seconds = Number.POSITIVE_INFINITY,
): TutorialAnchor[] {
  const carry = samples.filter((sample) => sample.t < trim).at(-1);
  const trimmed = [
    ...(carry ? [{ ...carry, t: 0 }] : []),
    ...samples.filter((sample) => sample.t >= trim).map((sample) => ({ ...sample, t: sample.t - trim })),
  ];
  return trimmed
    .map((sample) => ({
      t: sample.t,
      x: sample.x / screen.width,
      y: sample.y / screen.height,
      width: sample.width / screen.width,
      height: sample.height / screen.height,
    }))
    .filter(
      (sample) =>
        [sample.t, sample.x, sample.y, sample.width, sample.height].every(Number.isFinite) &&
        sample.t >= 0 &&
        sample.t <= seconds + 1 / 30 &&
        sample.width > 0 &&
        sample.height > 0 &&
        sample.x >= -1e-4 &&
        sample.y >= -1e-4 &&
        sample.x + sample.width <= 1 + 1e-4 &&
        sample.y + sample.height <= 1 + 1e-4,
    );
}

export function assertLocalTutorialBackend(backendUrl: string): URL {
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname)) {
    throw new Error('Tutorial capture requires an isolated local HTTP backend; production capture is disabled.');
  }
  return backend;
}

/** wm can report both physical and override sizes: the last size is in force. */
export function measureTutorialScreen(sizeText: string, densityText: string) {
  const dimensions = [...sizeText.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)].at(-1);
  const density = [...densityText.matchAll(/(?:Physical|Override) density:\s*(\d+)/g)].at(-1);
  if (!dimensions || !density || Number(density[1]) <= 0) throw new Error('Could not measure Android wm size/density.');
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  return {
    width,
    height,
    screen: { width: (width * 160) / Number(density[1]), height: (height * 160) / Number(density[1]) },
  };
}

export function tutorialCaptureFingerprint(
  take: TutorialTake,
  identity: Readonly<{
    captureSourceSha256: string;
    nativeArtifactSha256: string;
    geometry: ReturnType<typeof measureTutorialScreen>;
    scenario: string;
  }>,
  readFlow: (path: string) => string,
): string {
  const flows = new Map<string, string>();
  const visit = (path: string) => {
    if (flows.has(path)) return;
    const body = readFlow(path);
    flows.set(path, body);
    for (const nested of body.matchAll(/^\s*- runFlow:\s*([^\n\r{]+\.yaml)\s*$/gm))
      visit(join(dirname(path), nested[1].trim()));
  };
  for (const path of [
    take.flow,
    'packages/mobile/.maestro/tutorial/home-ready.yaml',
    ...(take.setupFlows ?? []),
    ...(take.requiresDownload ? ['packages/mobile/.maestro/tutorial/download-ready.yaml'] : []),
    ...(take.session === 'crew'
      ? ['packages/mobile/.maestro/tutorial/crew-setup.yaml', 'packages/mobile/.maestro/tutorial/crew-invite.yaml']
      : []),
    ...(take.session ? ['packages/mobile/.maestro/tutorial/session-end.yaml'] : []),
  ])
    visit(path);
  return sha(
    JSON.stringify({ version: 1, take, ...identity, flows: [...flows].map(([path, body]) => ({ path, body })) }),
  );
}

export function tutorialManifestProblems(
  manifest: TutorialTakeManifest,
  take: TutorialTake,
  fingerprint: string,
): string[] {
  const problems: string[] = [];
  if (
    manifest.formatVersion !== 1 ||
    manifest.platform !== 'android' ||
    manifest.fps !== 30 ||
    manifest.takeId !== take.id ||
    manifest.fingerprint !== fingerprint
  )
    problems.push('capture identity differs');
  if (!(manifest.width > 0 && manifest.height > 0 && manifest.screen.width > 0 && manifest.screen.height > 0))
    problems.push('invalid geometry');
  if (
    !Number.isInteger(manifest.frameCount) ||
    manifest.frameCount < Math.ceil(take.minSeconds * 30) ||
    manifest.seconds < take.minSeconds
  )
    problems.push('footage is too short');
  for (const mark of take.requiredMarks)
    if (!Number.isFinite(manifest.marks[mark]) || manifest.marks[mark] < 0 || manifest.marks[mark] >= manifest.seconds)
      problems.push(`missing or out-of-range mark ${mark}`);
  for (const anchor of take.requiredAnchors ?? [])
    if (!manifest.anchors[anchor]?.length) problems.push(`missing anchor ${anchor}`);
  return problems;
}
