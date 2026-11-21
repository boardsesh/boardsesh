/// <reference types="node" />

/** Check maintained local documentation references without contacting remote services. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DocumentationProblem {
  source: string;
  line: number;
  target: string;
  reason: string;
}

interface DocumentationReference {
  target: string;
  offset: number;
  repositoryRelative?: boolean;
}

const TEXT_EXTENSIONS =
  /\.(?:md|mdx|html|tsx?|jsx?|[cm]js|json|ya?ml|toml|sh|py|swift|cpp|h|sql|xml|kts?|svg|template)$/;
const DOC_FILE_REFERENCE =
  /(?:^|[\s`'"(=])((?:\/?docs\/)[\w./-]+\.(?:md|mdx|json|sql|html|svg|png|jpe?g|webp|gif|excalidraw)(?:#[\p{L}\p{M}\p{N}_%.-]+)?)/gmu;
// Preserve the exact inputs of the fail-closed OTA boot selfcheck. Their retained
// guide reference resolves to its current location; every other reference is checked normally.
const RETAINED_OTA_GUIDE_SOURCES = new Set([
  '.github/workflows/mobile-ota-boot-check.yml',
  'scripts/mobile-ota-boot-check.ts',
  'scripts/lib/ota-boot-check.ts',
]);

// Native fingerprints include comment bytes. Keep these released 2.8.0 references
// intact, including the Swift generator's header, while validating their current
// destinations. Match both the source file and the historical path; neighboring
// files and other references in the same source retain the ordinary checks.
const RETAINED_NATIVE_GUIDE_REFERENCES = new Map<string, readonly [string, string]>([
  ['packages/mobile/modules/live-activity/ios/BoardBleEncoding.swift', ['WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards']],
  [
    'packages/mobile/modules/live-activity/ios/BoardBleManager.swift',
    ['MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md', 'boards'],
  ],
  ['packages/mobile/modules/live-activity/ios/SharedConstants.swift', ['og-climb.md', 'web']],
  ['packages/mobile/targets/BoardseshWidgets/SharedConstants.swift', ['og-climb.md', 'web']],
  ['packages/mobile/modules/live-activity/ios/WoodsBoardData.swift', ['WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards']],
  ['packages/board-constants/scripts/woods-led-maps-sources.ts', ['WOODS_BLUETOOTH_PROTOCOL_SPEC.md', 'boards']],
  [
    'packages/mobile/modules/memory-trim/android/src/main/java/expo/modules/memorytrim/MemoryTrimModule.kt',
    ['react-native-performance.md', 'mobile'],
  ],
  ['packages/mobile/targets/BoardseshWidgets/ClimbSessionLiveActivity.swift', ['ai-design-guidelines.md', 'design']],
]);

/** Preserve offsets and line numbers while removing illustrative fenced/indented code. */
export function withoutCodeBlocks(markdown: string): string {
  let fence: { marker: string; length: number } | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence.marker && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) {
          fence = undefined;
        }
        return ' '.repeat(line.length);
      }
      if (marker) {
        fence = { marker: marker[0], length: marker.length };
        return ' '.repeat(line.length);
      }
      return /^(?: {4}|\t)/.test(line) ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

function inlineTarget(contents: string): string {
  const trimmed = contents.trim();
  if (trimmed.startsWith('<')) return trimmed.slice(1, trimmed.indexOf('>'));
  // A title is separated from the URL by whitespace; escaped spaces belong to the URL.
  return /^(?:\\.|[^\s])+/.exec(trimmed)?.[0] ?? '';
}

function withoutInlineCode(markdown: string): string {
  return markdown.replace(/(`+)([^]*?)\1/g, (span) => span.replace(/[^\n]/g, ' '));
}

function markdownReferences(markdown: string): DocumentationReference[] {
  const references: DocumentationReference[] = [];
  // Parse balanced parentheses, which occur in filenames and URL fragments.
  for (const match of markdown.matchAll(/\]\(/g)) {
    const start = match.index + 2;
    let depth = 1;
    let end = start;
    let angle = false;
    for (; end < markdown.length; end++) {
      const character = markdown[end];
      if (character === '\\') {
        end++;
        continue;
      }
      if (character === '<') angle = true;
      if (character === '>') angle = false;
      if (!angle && character === '(') depth++;
      if (!angle && character === ')' && --depth === 0) break;
      if (character === '\n' && depth === 1) break;
    }
    if (depth === 0) references.push({ target: inlineTarget(markdown.slice(start, end)), offset: start });
  }
  for (const match of markdown.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)) {
    references.push({ target: inlineTarget(match[1]), offset: match.index });
  }
  for (const match of markdown.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/g)) {
    references.push({ target: match[2], offset: match.index });
  }
  return references;
}

function htmlAnchors(contents: string): Set<string> {
  return new Set([...contents.matchAll(/\b(?:id|name)\s*=\s*(["'])(.*?)\1/g)].map((match) => match[2]));
}

/** GitHub-style heading IDs, including duplicate-heading suffixes and explicit HTML IDs. */
export function markdownAnchors(markdown: string): Set<string> {
  const source = withoutCodeBlocks(markdown);
  const anchors = new Set<string>();
  const used = new Set<string>();
  const headings: string[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading) headings.push(heading[1]);
    else if (index > 0 && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[index]) && lines[index - 1].trim()) {
      headings.push(lines[index - 1].trim());
    }
  }
  for (const heading of headings) {
    const base = heading
      .replace(/<[^>]*>/g, '')
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&(?:lt|gt|quot|apos);/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    let candidate = base;
    let suffix = 0;
    while (used.has(candidate)) candidate = `${base}-${++suffix}`;
    used.add(candidate);
    anchors.add(candidate);
  }
  for (const anchor of htmlAnchors(source)) anchors.add(anchor);
  return anchors;
}

function isMaintainedSource(filename: string): boolean {
  // The production release workflow owns the generated changelog bytes.
  if (filename === 'CHANGELOG.md') return false;
  // Applied PostgreSQL SQL bytes and historical SQLite migrations retain their
  // published provenance. Even a comment-only link rewrite changes their hashes
  // or release scope; their original references remain part of those artifacts.
  if (filename.startsWith('packages/db/drizzle/') || filename === 'packages/shared/offline-sync/src/db/migrations.ts')
    return false;
  return (
    (TEXT_EXTENSIONS.test(filename) ||
      /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|\.env(?:\.[^/]+)?|Fastfile|\.prettierignore)$/.test(filename)) &&
    !/(?:^|\/)(?:fixtures|__fixtures__|__tests__|generated|node_modules|board-controller\/static)(?:\/|$)/.test(
      filename,
    ) &&
    !/\.(?:test|spec)\./.test(filename) &&
    !/(?:^|\/)(?:pnpm-lock\.yaml|oss-licenses\.generated\.json)$/.test(filename)
  );
}

function literalDocsReferences(source: string): DocumentationReference[] {
  return [...source.matchAll(DOC_FILE_REFERENCE)].flatMap((match) => {
    const target = match[1].replace(/\.+$/, '');
    const trailing = source.slice(match.index + match[0].length, match.index + match[0].length + 2);
    // Globs, template placeholders and illustrated filename suffixes are not concrete paths.
    if (/^[\w{*]/.test(trailing)) return [];
    // This path belongs to the separately maintained blackheathdc-ansible repository.
    if (target.split('#', 1)[0] === 'docs/BOARDSESH_POSTGRES_DR.md') return [];
    return [{ target, offset: match.index + match[0].indexOf(target), repositoryRelative: true }];
  });
}

function decodedTarget(target: string): string {
  return decodeURIComponent(target.replace(/\\([ ()])/g, '$1').replace(/&amp;/g, '&'));
}

/** Validate a supplied tracked-file inventory; tests use an isolated temporary repository. */
export function checkDocumentation({ cwd, files }: { cwd: string; files: readonly string[] }): DocumentationProblem[] {
  const problems: DocumentationProblem[] = [];
  const inventory = new Set(files);
  const anchorCache = new Map<string, Set<string>>();
  for (const source of [...files].sort()) {
    if (!isMaintainedSource(source)) continue;
    const absoluteSource = path.resolve(cwd, source);
    if (!existsSync(absoluteSource)) continue;
    const contents = readFileSync(absoluteSource, 'utf8');
    const markdown = /\.(?:md|mdx)$/.test(source);
    const scanned = markdown ? withoutCodeBlocks(contents) : contents;
    const references = [
      ...(markdown || (source.startsWith('docs/') && source.endsWith('.html'))
        ? markdownReferences(withoutInlineCode(scanned))
        : []),
      ...literalDocsReferences(scanned),
    ];
    const seen = new Set<string>();
    for (const reference of references) {
      const { target, offset } = reference;
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      // Absolute application routes and machine-local evidence are not repository links.
      if (
        target.startsWith('/') &&
        !/^\/(?:docs|packages|scripts|infra|deploy)\//.test(target) &&
        !/^\/[^/]+\.(?:md|mdx)(?:[#?]|$)/.test(target)
      )
        continue;
      // Runtime placeholders and generated capture directories do not exist in a checkout.
      if (/[${}*]/.test(target) || /(?:^|\/)\.boardsesh\//.test(target)) continue;
      const [pathnameWithQuery, rawAnchor] = target.split('#', 2);
      const rawPathname = pathnameWithQuery.split('?', 1)[0];
      let pathname: string;
      let anchor: string | undefined;
      try {
        pathname = decodedTarget(rawPathname);
        anchor = rawAnchor === undefined ? undefined : decodedTarget(rawAnchor);
      } catch {
        problems.push({
          source,
          line: contents.slice(0, offset).split('\n').length,
          target,
          reason: 'invalid URL encoding',
        });
        continue;
      }
      if (
        reference.repositoryRelative &&
        pathname === path.posix.join('docs', 'mobile-ota-updates.md') &&
        RETAINED_OTA_GUIDE_SOURCES.has(source)
      )
        pathname = 'docs/operations/mobile-ota-updates.md';
      const retainedNativeGuide = RETAINED_NATIVE_GUIDE_REFERENCES.get(source);
      if (
        reference.repositoryRelative &&
        retainedNativeGuide &&
        pathname === path.posix.join('docs', retainedNativeGuide[0])
      ) {
        const [filename, topic] = retainedNativeGuide;
        pathname = path.posix.join('docs', topic, filename);
      }
      const resolved = !pathname
        ? absoluteSource
        : reference.repositoryRelative || pathname.startsWith('/')
          ? path.resolve(cwd, pathname.replace(/^\//, ''))
          : path.resolve(path.dirname(absoluteSource), pathname);
      const relative = path.relative(cwd, resolved);
      const line = contents.slice(0, offset).split('\n').length;
      const key = `${line}:${resolved}#${anchor ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let reason: string | undefined;
      if (relative.startsWith('../') || path.isAbsolute(relative)) reason = 'target leaves the repository';
      else if (!existsSync(resolved)) reason = `missing file ${relative}`;
      else if (relative.startsWith('docs/') && statSync(resolved).isFile() && !inventory.has(relative)) {
        reason = `file absent from repository inventory: ${relative}`;
      } else if (anchor && /\.(?:md|mdx|html)$/.test(resolved) && statSync(resolved).isFile()) {
        let anchors = anchorCache.get(resolved);
        if (!anchors) {
          const targetContents = readFileSync(resolved, 'utf8');
          anchors = resolved.endsWith('.html') ? htmlAnchors(targetContents) : markdownAnchors(targetContents);
          anchorCache.set(resolved, anchors);
        }
        if (!anchors.has(anchor)) reason = `missing heading #${anchor} in ${relative}`;
      }
      if (reason) problems.push({ source, line, target, reason });
    }
  }
  return problems;
}

/** Keep the topic layer navigable rather than accumulating unlinked documents again. */
export function checkDocumentationStructure({
  cwd,
  files,
}: {
  cwd: string;
  files: readonly string[];
}): DocumentationProblem[] {
  const documents = new Set(
    files.filter((filename) => filename.startsWith('docs/') && existsSync(path.resolve(cwd, filename))),
  );
  const problems: DocumentationProblem[] = [];
  for (const filename of documents) {
    if (filename !== 'docs/README.md' && filename.split('/').length === 2) {
      problems.push({ source: filename, line: 1, target: filename, reason: 'place this file under its owning topic' });
    }
  }
  if (!documents.has('docs/README.md')) {
    return [
      ...problems,
      { source: 'docs/README.md', line: 1, target: 'docs/README.md', reason: 'missing documentation entry point' },
    ];
  }
  const visited = new Set<string>();
  const pending = ['docs/README.md'];
  while (pending.length > 0) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const contents = readFileSync(path.resolve(cwd, filename), 'utf8');
    const scanned = filename.endsWith('.html') ? contents : withoutCodeBlocks(contents);
    for (const { target } of markdownReferences(withoutInlineCode(scanned))) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      let pathname: string;
      try {
        pathname = decodedTarget(target.split('#', 1)[0].split('?', 1)[0]);
      } catch {
        continue; // The reference checker reports invalid URL encodings.
      }
      const resolved = pathname.startsWith('/')
        ? path.resolve(cwd, pathname.slice(1))
        : path.resolve(cwd, path.dirname(filename), pathname);
      const relative = path.relative(cwd, resolved);
      if (documents.has(relative) && /\.(?:md|mdx|html)$/.test(relative) && !visited.has(relative))
        pending.push(relative);
    }
  }
  for (const filename of [...documents].sort()) {
    if (isMaintainedSource(filename) && /\.(?:md|mdx)$/.test(filename) && !visited.has(filename)) {
      problems.push({
        source: filename,
        line: 1,
        target: filename,
        reason: 'not reachable from docs/README.md through links',
      });
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cwd = path.resolve(import.meta.dirname, '..');
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    const problems = [...checkDocumentation({ cwd, files }), ...checkDocumentationStructure({ cwd, files })];
    for (const { source, line, target, reason } of problems) console.error(`${source}:${line}: ${target}: ${reason}`);
    console.log(
      `[docs] ${problems.length === 0 ? 'All maintained local references resolve.' : `${problems.length} broken local references.`}`,
    );
    if (problems.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[docs] ${error instanceof Error ? error.message : 'Cannot check documentation.'}`);
    process.exitCode = 1;
  }
}
