import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './screenshot-fixtures';
import { isReplayCapturePath } from './screenshot-capture-source';
import { cppStoryCaptures } from './mobile-visual-stories';
import { readCppPage, type CppTarget } from './screenshot-cpp';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface CppStoryCapture {
  version: 1;
  kind: 'view-stories';
  target: CppTarget;
  sourceSha256: string;
  locale: string;
  device: string;
  theme: 'dark' | 'light';
  variant: 'liquidGlass' | 'material';
  renderMode: string;
  captures: Array<{ name: string; storyId: string; nativeActivityBoard?: string; sha256: string }>;
}

/** Hash the actual checkout, including new source files, rather than claiming a backend recording. */
export function cppStorySourceSha256(root = ROOT): string {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => isReplayCapturePath(path) && existsSync(join(root, path)));
  if (!paths.length) throw new Error('No story capture sources found');
  return digest(
    canonicalJson(
      Object.fromEntries([...new Set(paths)].sort().map((path) => [path, digest(readFileSync(join(root, path)))])),
    ),
  );
}

export function createCppStoryCapture(
  options: Omit<CppStoryCapture, 'version' | 'kind' | 'captures'>,
  rawDirectory: string,
): CppStoryCapture {
  const captures = cppStoryCaptures(readCppPage(options.target), options.device.startsWith('ipad-') ? 'ipad' : 'phone');
  return {
    version: 1,
    kind: 'view-stories',
    ...options,
    captures: captures.map((capture) => ({
      ...capture,
      sha256: digest(readFileSync(join(rawDirectory, capture.name + '.png'))),
    })),
  };
}

/** Require the exact scene inventory, source bytes, locale/device and captured PNGs. */
export function assertCppStoryCapture(
  candidate: unknown,
  expected: { target: CppTarget; locale: string; device: string; sourceSha256: string },
  rawDirectory: string,
): asserts candidate is CppStoryCapture {
  if (!candidate || typeof candidate !== 'object') throw new Error('Missing CPP story provenance');
  const capture = candidate as CppStoryCapture;
  if (
    capture.kind !== 'view-stories' ||
    capture.version !== 1 ||
    capture.target !== expected.target ||
    capture.locale !== expected.locale ||
    capture.device !== expected.device ||
    capture.sourceSha256 !== expected.sourceSha256 ||
    !/^[a-f0-9]{64}$/.test(capture.sourceSha256) ||
    !['dark', 'light'].includes(capture.theme) ||
    !['liquidGlass', 'material'].includes(capture.variant) ||
    !['classic', 'aura'].includes(capture.renderMode)
  )
    throw new Error('Stale or invalid CPP story provenance');
  const rebuilt = createCppStoryCapture(
    { ...expected, theme: capture.theme, variant: capture.variant, renderMode: capture.renderMode },
    rawDirectory,
  );
  if (canonicalJson(candidate) !== canonicalJson(rebuilt))
    throw new Error('CPP story scene or pixel provenance changed');
}
