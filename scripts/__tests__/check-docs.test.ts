import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDocumentation, checkDocumentationStructure, markdownAnchors, withoutCodeBlocks } from '../check-docs';

const directories: string[] = [];

function repository(contents: Record<string, string>): { cwd: string; files: string[] } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'check-docs-'));
  directories.push(cwd);
  for (const [filename, source] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(cwd, filename)), { recursive: true });
    writeFileSync(path.join(cwd, filename), source);
  }
  return { cwd, files: Object.keys(contents) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('documentation references', () => {
  it('resolves moved relative links, root links, images, reference definitions and HTML attributes', () => {
    const checkout = repository({
      'README.md': '[Docs](/docs/README.md)\n[Guide][guide]\n[guide]: docs/mobile/guide.md#setup',
      'docs/README.md': '[Guide](mobile/guide.md#setup)\n![Screen](<mobile/images/screen (light).png>)',
      'docs/mobile/guide.md': '# Setup\n<a href="/README.md">Home</a>\n<img src="images/screen%20(light).png">',
      'docs/mobile/images/screen (light).png': '',
    });
    expect(checkDocumentation(checkout)).toEqual([]);
  });

  it('reports missing files and anchors with the source line, including same-file anchors', () => {
    const checkout = repository({
      'docs/guide.md': '# Guide\n\n[Missing](gone.md)\n[Heading](#removed)\n[Other](other.md#missing)',
      'docs/other.md': '# Existing',
    });
    expect(checkDocumentation(checkout)).toEqual([
      { source: 'docs/guide.md', line: 3, target: 'gone.md', reason: 'missing file docs/gone.md' },
      { source: 'docs/guide.md', line: 4, target: '#removed', reason: 'missing heading #removed in docs/guide.md' },
      {
        source: 'docs/guide.md',
        line: 5,
        target: 'other.md#missing',
        reason: 'missing heading #missing in docs/other.md',
      },
    ]);
  });

  it('checks literal docs references in maintained source and configuration', () => {
    const checkout = repository({
      'scripts/reader.ts':
        "const contents = readFileSync('docs/data/missing.json', 'utf8');\n// See docs/data/guide.md.",
      '.github/workflows/ci.yml': "paths:\n  - 'docs/operations/missing.md'\n  - 'docs/**/*.patch'",
      'docs/data/guide.md': '# Guide',
    });
    expect(checkDocumentation(checkout).map(({ source, line, target }) => ({ source, line, target }))).toEqual([
      { source: '.github/workflows/ci.yml', line: 2, target: 'docs/operations/missing.md' },
      { source: 'scripts/reader.ts', line: 1, target: 'docs/data/missing.json' },
    ]);
  });

  it.each(['Dockerfile', 'Dockerfile.web', 'deploy/Dockerfile.worker'])(
    'checks documentation paths in %s',
    (filename) => {
      const checkout = repository({
        [filename]: '# See docs/analytics/analytics-consent.md#ad-pixels.\nFROM node:24',
      });
      expect(checkDocumentation(checkout)).toEqual([
        {
          source: filename,
          line: 1,
          target: 'docs/analytics/analytics-consent.md#ad-pixels',
          reason: 'missing file docs/analytics/analytics-consent.md',
        },
      ]);
    },
  );

  it('validates code-comment anchors while excluding trailing sentence punctuation', () => {
    const checkout = repository({
      'scripts/reader.ts': '// See docs/data/guide.md#existing.\n// See docs/data/guide.md#removed).',
      'docs/data/guide.md': '# Existing',
    });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'scripts/reader.ts',
        line: 2,
        target: 'docs/data/guide.md#removed',
        reason: 'missing heading #removed in docs/data/guide.md',
      },
    ]);
  });

  it.each([
    'packages/mobile/app.xml',
    'packages/mobile/MainActivity.kt',
    'packages/mobile/build.gradle.kts',
    'docs/operations/diagrams/topology.svg',
    'deploy/site.template',
    '.env',
    'packages/backend/.env.development',
    'fastlane/Fastfile',
    '.prettierignore',
  ])('checks maintained documentation references in %s', (filename) => {
    const checkout = repository({ [filename]: '# See docs/operations/missing.md.' });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: filename,
        line: 1,
        target: 'docs/operations/missing.md',
        reason: 'missing file docs/operations/missing.md',
      },
    ]);
  });

  it('does not inspect immutable release fixtures or illustrative test paths', () => {
    const checkout = repository({
      'packages/backend/src/__tests__/native-contract/fixtures/sources/hash.txt': 'See docs/deleted-at-release.md',
      'scripts/__tests__/example.test.ts': "expect(check('docs/unrelated.md')).toBe(false)",
      'packages/shared/generated/schema.ts': '// See docs/old.md',
      'docs/guide.md':
        '# Guide\n```md\n[Example](gone.md)\n```\n\n    [Indented example](gone.md)\n`[Example](...)`\n`<Link href="...">`',
      'marketing/stage.html': '<link rel="stylesheet" href="tokens.css">',
    });
    expect(checkDocumentation(checkout)).toEqual([]);
  });

  it('preserves immutable migration references while checking neighboring current SQL and TypeScript', () => {
    const checkout = repository({
      'CHANGELOG.md': 'See docs/release-time-operations.md',
      'packages/db/drizzle/0001_published.sql': '-- See docs/original-schema.md',
      'packages/shared/offline-sync/src/db/migrations.ts': '// See docs/original-schema.md',
      'packages/db/src/queries/current.sql': '-- See docs/missing-contract.md',
      'packages/shared/offline-sync/src/db/schema.ts': '// See docs/missing-contract.md',
    });
    expect(checkDocumentation(checkout).map(({ source, target }) => ({ source, target }))).toEqual([
      { source: 'packages/db/src/queries/current.sql', target: 'docs/missing-contract.md' },
      { source: 'packages/shared/offline-sync/src/db/schema.ts', target: 'docs/missing-contract.md' },
    ]);
  });

  it('rejects ignored local documentation assets omitted from the repository inventory', () => {
    const checkout = repository({
      'docs/design/guide.md': '![Capture](images/capture.png)',
      'docs/design/images/capture.png': '',
    });
    checkout.files = checkout.files.filter((filename) => !filename.endsWith('.png'));
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'docs/design/guide.md',
        line: 1,
        target: 'images/capture.png',
        reason: 'file absent from repository inventory: docs/design/images/capture.png',
      },
    ]);
  });

  it.each([
    '.github/workflows/mobile-ota-boot-check.yml',
    'scripts/mobile-ota-boot-check.ts',
    'scripts/lib/ota-boot-check.ts',
  ])('resolves the retained OTA guide reference in %s without ignoring other references', (filename) => {
    const checkout = repository({
      [filename]: '# See docs/mobile-ota-updates.md#boot-check.\n# See docs/missing-guide.md.',
      'docs/operations/mobile-ota-updates.md': '# Boot check',
    });
    expect(checkDocumentation(checkout)).toEqual([
      { source: filename, line: 2, target: 'docs/missing-guide.md', reason: 'missing file docs/missing-guide.md' },
    ]);
  });

  it('does not alias the retained OTA guide reference in neighboring source files', () => {
    const checkout = repository({
      'scripts/mobile-ota-boot-preview.ts': '// See docs/mobile-ota-updates.md.',
      'docs/operations/mobile-ota-updates.md': '# Boot check',
    });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'scripts/mobile-ota-boot-preview.ts',
        line: 1,
        target: 'docs/mobile-ota-updates.md',
        reason: 'missing file docs/mobile-ota-updates.md',
      },
    ]);
  });

  it('still requires the canonical destination of a retained OTA guide reference', () => {
    const checkout = repository({
      'scripts/mobile-ota-boot-check.ts': '// See docs/mobile-ota-updates.md.',
    });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'scripts/mobile-ota-boot-check.ts',
        line: 1,
        target: 'docs/mobile-ota-updates.md',
        reason: 'missing file docs/operations/mobile-ota-updates.md',
      },
    ]);
  });

  it.each([
    ['packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift', 'WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards'],
    [
      'packages/mobile/modules/live-activity/ios/BoardBleManager.swift',
      'MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md',
      'boards',
    ],
    ['packages/mobile/modules/live-activity/ios/SharedConstants.swift', 'og-climb.md', 'web'],
    ['packages/mobile/targets/BoardseshWidgets/SharedConstants.swift', 'og-climb.md', 'web'],
    ['packages/mobile/modules/live-activity/ios/WoodsBoardData.swift', 'WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards'],
    ['packages/board-constants/scripts/woods-led-maps-sources.ts', 'WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards'],
    [
      'packages/mobile/modules/memory-trim/android/src/main/java/expo/modules/memorytrim/MemoryTrimModule.kt',
      'react-native-performance.md',
      'mobile',
    ],
    ['packages/mobile/targets/BoardseshWidgets/ClimbSessionLiveActivity.swift', 'ai-design-guidelines.md', 'design'],
  ])('validates the retained native guide in %s without exempting other references', (filename, guide, topic) => {
    const checkout = repository({
      [filename]: `// See docs/${guide}#existing.\n// See docs/missing-guide.md.`,
      [`docs/${topic}/${guide}`]: '# Existing',
    });
    expect(checkDocumentation(checkout)).toEqual([
      { source: filename, line: 2, target: 'docs/missing-guide.md', reason: 'missing file docs/missing-guide.md' },
    ]);
  });

  it('does not alias a native guide in a neighboring source or a different guide in an allowed source', () => {
    const checkout = repository({
      'packages/mobile/modules/live-activity/ios/Neighbor.swift': '// See docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md.',
      'packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift': '// See docs/og-climb.md.',
      'docs/boards/WOODS_BLUETOOTH_PROTOCOL_SPEC.md': '# Woods',
      'docs/web/og-climb.md': '# Rendering',
    });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift',
        line: 1,
        target: 'docs/og-climb.md',
        reason: 'missing file docs/og-climb.md',
      },
      {
        source: 'packages/mobile/modules/live-activity/ios/Neighbor.swift',
        line: 1,
        target: 'docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md',
        reason: 'missing file docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md',
      },
    ]);
  });

  it.each(['missing file', 'untracked file', 'missing anchor'] as const)(
    'still validates the canonical native guide destination: %s',
    (failure) => {
      const filename = 'packages/mobile/modules/live-activity/ios/SharedConstants.swift';
      const destination = 'docs/web/og-climb.md';
      const checkout = repository({
        [filename]: '// See docs/og-climb.md#existing.',
        ...(failure === 'missing file'
          ? {}
          : { [destination]: failure === 'missing anchor' ? '# Other' : '# Existing' }),
      });
      if (failure === 'untracked file') checkout.files = checkout.files.filter((source) => source !== destination);
      const reasons = {
        'missing file': `missing file ${destination}`,
        'untracked file': `file absent from repository inventory: ${destination}`,
        'missing anchor': `missing heading #existing in ${destination}`,
      };
      expect(checkDocumentation(checkout)).toEqual([
        { source: filename, line: 1, target: 'docs/og-climb.md#existing', reason: reasons[failure] },
      ]);
    },
  );

  it('skips remote URLs, app routes, runtime capture files and the separate Ansible runbook', () => {
    const checkout = repository({
      'docs/guide.md': [
        '[Remote](https://example.com/docs/missing.md)',
        '[Contact](mailto:hello@example.com)',
        '[Settings](/settings)',
        '[Capture](../.boardsesh/captures/screen.png)',
        '`docs/BOARDSESH_POSTGRES_DR.md` is in blackheathdc-ansible.',
      ].join('\n'),
    });
    expect(checkDocumentation(checkout)).toEqual([]);
  });

  it('rejects repository escapes and malformed encodings without hiding other failures', () => {
    const checkout = repository({
      'docs/guide.md': '[Escape](../../secret.md)\n[Invalid](broken%ZZ.md)\n[Missing](missing.md)',
    });
    expect(checkDocumentation(checkout).map(({ reason }) => reason)).toEqual([
      'target leaves the repository',
      'invalid URL encoding',
      'missing file docs/missing.md',
    ]);
  });

  it('keeps meaningful headings and removes fenced heading examples', () => {
    const markdown =
      '# **Hello**, `world`!\n## Hello, world!\n## Crème brûlée\nA title\n-------\n<a id="custom"></a>\n~~~\n# Hidden\n~~~';
    expect([...markdownAnchors(markdown)]).toEqual([
      'hello-world',
      'hello-world-1',
      'crème-brûlée',
      'a-title',
      'custom',
    ]);
    expect(withoutCodeBlocks(markdown).split('\n')).toHaveLength(markdown.split('\n').length);
  });

  it('validates HTML IDs, encoded Unicode fragments, and balanced-parenthesis filenames', () => {
    const checkout = repository({
      'docs/guide.md':
        '[Section](guide.md#cr%C3%A8me-br%C3%BBl%C3%A9e)\n[Frame](stage.html#screen)\n[Missing](stage.html#missing)\n[Notes](notes\\(old\\).md)\n[Filename](notes%23old.md)\n## Crème brûlée',
      'docs/stage.html': '    <section id="screen"></section>',
      'docs/notes(old).md': '# Notes',
      'docs/notes#old.md': '# Notes',
    });
    expect(checkDocumentation(checkout)).toEqual([
      {
        source: 'docs/guide.md',
        line: 3,
        target: 'stage.html#missing',
        reason: 'missing heading #missing in docs/stage.html',
      },
    ]);
  });

  it('runs the checker and its regression tests in CI without a path gate', () => {
    const workflow = readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const step = workflow.match(/      - name: docs-links[^]*?(?=\n      - name:|$)/)?.[0];
    expect(step).toBeDefined();
    expect(step).toContain('vp run check:docs');
    expect(step).toContain('scripts/__tests__/check-docs.test.ts');
    expect(step).not.toContain('needs.changes.outputs');
    expect(step).not.toContain('--changed');
  });
});

describe('documentation organization', () => {
  it('requires the root entry point and places other root files under a topic', () => {
    const checkout = repository({ 'docs/loose.md': '# Loose', 'docs/capture.png': '' });
    expect(checkDocumentationStructure(checkout).map(({ reason }) => reason)).toEqual([
      'place this file under its owning topic',
      'place this file under its owning topic',
      'missing documentation entry point',
    ]);
  });

  it('accepts links through topic indexes and reports unreachable documents', () => {
    const checkout = repository({
      'docs/README.md': '[Topic](mobile/README.md)',
      'docs/mobile/README.md': '[Guide](/docs/mobile/guide.md#setup)',
      'docs/mobile/guide.md': '# Setup',
      'docs/mobile/orphan.md': '# Orphan',
      'docs/mobile/images/screen.png': '',
    });
    expect(checkDocumentationStructure(checkout)).toEqual([
      {
        source: 'docs/mobile/orphan.md',
        line: 1,
        target: 'docs/mobile/orphan.md',
        reason: 'not reachable from docs/README.md through links',
      },
    ]);
  });

  it('does not count illustrative or bare path mentions as navigation links', () => {
    const checkout = repository({
      'docs/README.md': '```md\n[Example](mobile/guide.md)\n```\n`docs/mobile/guide.md`',
      'docs/mobile/guide.md': '# Guide',
    });
    expect(checkDocumentationStructure(checkout)).toHaveLength(1);
  });
});
