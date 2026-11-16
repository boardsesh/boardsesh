// No new text dimmed with `opacity`.
//
// Velvet Send v2: text steps down the hierarchy by colour, not by fading. An
// opacity dim mixes the text into whatever sits behind it, so its contrast changes
// with the ground and drops below AA in dark mode, and it never follows Increase
// Contrast. Use the label tones instead:
//
//   a quieter line  → <Text tone="secondary">  (secondaryLabel)
//   the quietest    → <Text tone="tertiary">   (tertiaryLabel)
//   a disabled row  → tone="tertiary", or dim the whole row's container
//
// What the scan counts, kept simple on purpose:
//   1. `const <name> = StyleSheet.create({ … })` blocks, and in them each
//      `key: { … }` whose body sets `opacity:` to anything but a literal 0 or 1
//      (0 hides a sizing ghost and 1 is a no-op; neither is a dim).
//   2. Every `<Text` opening tag (our Text or React Native's) that references
//      `<name>.<key>` for one of those keys. Each such tag counts once.
// Inline `style={{ opacity }}`, styles built in a function or `useMemo`, and
// `Animated.Text` are missed: a false negative is fine, a false positive is not.
// Comments (a `//` after whitespace, and block comments) are stripped first.
//
// ALLOWLIST is shrink-only: each entry is a file that still holds that many dimmed
// Text tags today. Never add an entry; when you migrate one (wave W5), lower or
// delete it (the test fails on a stale count so the list can't rot).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = [join(PACKAGE_ROOT, 'src'), join(PACKAGE_ROOT, 'app')];

const STYLESHEET_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*StyleSheet\.create(?:<[^>]*>)?\(\s*\{/g;
const STYLE_KEY = /(['"]?)([A-Za-z_$][\w$]*)\1\s*:\s*\{/g;
const OPACITY_VALUE = /\bopacity\s*:\s*([^,}\n]+)/g;
const TEXT_TAG = /<Text\b/g;
const MEMBER_REFERENCE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g;

/** Drop block comments and `//` comments that follow whitespace (not the `//` in a URL). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Index just past the `}` that closes the `{` at `openIndex`. */
function closingBraceEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return index + 1;
  }
  return source.length;
}

/** Index just past the `>` that ends the JSX opening tag starting at `tagIndex`. */
function openingTagEnd(source: string, tagIndex: number): number {
  let depth = 0;
  for (let index = tagIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0 && source[index - 1] !== '=') return index + 1;
  }
  return source.length;
}

/** `name.key` for every StyleSheet key whose body dims with opacity. */
function dimmingStyleKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const binding of source.matchAll(STYLESHEET_BINDING)) {
    const objectStart = (binding.index ?? 0) + binding[0].length - 1;
    const objectBody = source.slice(objectStart, closingBraceEnd(source, objectStart));
    for (const key of objectBody.matchAll(STYLE_KEY)) {
      const keyStart = (key.index ?? 0) + key[0].length - 1;
      const keyBody = objectBody.slice(keyStart, closingBraceEnd(objectBody, keyStart));
      const dims = [...keyBody.matchAll(OPACITY_VALUE)].some(([, value]) => !['0', '1'].includes(value.trim()));
      if (dims) keys.add(`${binding[1]}.${key[2]}`);
    }
  }
  return keys;
}

function countDimmedText(rawSource: string): number {
  const source = stripComments(rawSource);
  const dimKeys = dimmingStyleKeys(source);
  if (dimKeys.size === 0) return 0;
  let count = 0;
  for (const tag of source.matchAll(TEXT_TAG)) {
    const tagIndex = tag.index ?? 0;
    const openingTag = source.slice(tagIndex, openingTagEnd(source, tagIndex));
    const references = [...openingTag.matchAll(MEMBER_REFERENCE)];
    if (references.some(([, name, key]) => dimKeys.has(`${name}.${key}`))) count++;
  }
  return count;
}

/**
 * The allowlist's size, pinned so no one can add an entry or raise a count.
 * When you migrate a file, lower its entry AND these two numbers.
 */
const ALLOWLIST_FILES = 31;
const ALLOWLIST_TOTAL = 70;

/** File → count today. Shrink-only. */
const ALLOWLIST: Record<string, number> = {
  'app/(tabs)/discover/[playlist_uuid].tsx': 4,
  'app/(tabs)/discover/community.tsx': 8,
  'app/boards/manage.tsx': 5,
  'app/users/connections.tsx': 1,
  'src/components/BoardRouteRedirect.tsx': 1,
  'src/components/ClimbListItemContent.tsx': 5,
  'src/components/CollapsibleSection.tsx': 1,
  'src/components/CrashScreen.tsx': 3,
  'src/components/FeatureFlagsForm.web.tsx': 2,
  'src/components/ListRow.tsx': 1,
  'src/components/RadioGroup.web.tsx': 1,
  'src/components/board-presence/wall-kiosk/WallScrubberView.tsx': 3,
  'src/components/create-climb/CreateDrawerFormView.tsx': 1,
  'src/components/filter-sheet/FilterLabelRow.tsx': 2,
  'src/components/filter-sheet/FilterTappableRow.tsx': 1,
  'src/components/filter-sheet/SetterPickerList.tsx': 5,
  'src/components/moderation/ModerationFeedScreen.tsx': 3,
  'src/components/notifications/NotificationsScreen.tsx': 2,
  'src/components/onboarding/OnboardingCard.tsx': 1,
  'src/components/play-drawer/BoardseshGradeSection.tsx': 3,
  'src/components/playlist/DiscoverLibraryView.tsx': 1,
  'src/components/playlist/PlaylistCard.tsx': 2,
  'src/components/playlist/PlaylistListRow.tsx': 1,
  'src/components/search/SearchEmptyRecovery.stories.tsx': 2,
  'src/components/session/session-stat-tile-views.tsx': 1,
  'src/components/settings/StorageSettingsScreen.tsx': 3,
  'src/components/you/ClimberSearch.tsx': 2,
  'src/components/you/LogbookView.tsx': 1,
  'src/components/you/ProfileClimbsTab.tsx': 2,
  'src/components/you/SocialTab.tsx': 1,
  'src/components/you/StatsSummaryCard.tsx': 1,
};

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.expo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function countAll(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(root)) {
      const uses = countDimmedText(readFileSync(file, 'utf8'));
      if (uses > 0) counts.set(relative(PACKAGE_ROOT, file), uses);
    }
  }
  return counts;
}

const HOW_TO_FIX =
  'Dim text with a label tone, not opacity: <Text tone="secondary"> (secondaryLabel) or ' +
  '<Text tone="tertiary"> (tertiaryLabel). Opacity mixes text into its ground and ignores ' +
  'Increase Contrast. See "Velvet Send v2 roles" in docs/ai-design-guidelines.md.';

const dimmedSheet = `
const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  muted: { opacity: 0.6, marginTop: 4 },
  ghost: { opacity: 0 },
  row: { flexDirection: 'row', shadowOpacity: 0.2 },
});`;

describe('the text-opacity scanner', () => {
  it.each([
    ['a Text styled with a dimming key', '<Text style={styles.muted}>Hi</Text>', 1],
    ['a dimming key in a style array', '<Text variant="footnote" style={[styles.title, styles.muted]}>Hi</Text>', 1],
    ['a conditional dim', '<Text style={[styles.title, disabled && styles.muted]} onPress={() => go()}>Hi</Text>', 1],
    ['a Text without the dimming key', '<Text style={styles.title}>Hi</Text>', 0],
    ['a View with the dimming key', '<View style={styles.muted} />', 0],
    ['an invisible sizing ghost (opacity 0)', '<Text style={styles.ghost}>Hi</Text>', 0],
    ['shadowOpacity, not opacity', '<Text style={styles.row}>Hi</Text>', 0],
    ['a TextInput', '<TextInput style={styles.muted} />', 0],
    ['a commented-out tag', '{/* <Text style={styles.muted}>Hi</Text> */}', 0],
  ])('counts %s', (_label, jsx, expected) => {
    expect(countDimmedText(`${dimmedSheet}\n${jsx}`)).toBe(expected);
  });

  it('reads a renamed StyleSheet binding', () => {
    const source = `const rowStyles = StyleSheet.create({ meta: { opacity: 0.5 } });\n<Text style={rowStyles.meta} />`;
    expect(countDimmedText(source)).toBe(1);
  });
});

describe('text is never dimmed with opacity', () => {
  const counts = countAll();

  it('adds no new <Text> dimmed by an opacity style', () => {
    const offenders = [...counts]
      .filter(([path, count]) => count > (ALLOWLIST[path] ?? 0))
      .map(([path, count]) => `${path}: ${count} (allowed ${ALLOWLIST[path] ?? 0})`);
    expect(offenders, HOW_TO_FIX).toEqual([]);
  });

  it('keeps the allowlist shrink-only (no stale counts)', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([path, allowed]) => (counts.get(path) ?? 0) < allowed)
      .map(([path, allowed]) => `${path}: now ${counts.get(path) ?? 0}, allowlist says ${allowed}`);
    expect(stale, 'Lower or delete these entries: the file has fewer dimmed Text tags now.').toEqual([]);
  });

  it('pins the allowlist size (it only ever shrinks)', () => {
    const total = Object.values(ALLOWLIST).reduce((sum, count) => sum + count, 0);
    const pinned = 'Never grow the allowlist; after a migration, lower ALLOWLIST_FILES / ALLOWLIST_TOTAL to match.';
    expect(Object.keys(ALLOWLIST).length, pinned).toBe(ALLOWLIST_FILES);
    expect(total, pinned).toBe(ALLOWLIST_TOTAL);
  });

  it('actually scans the source tree', () => {
    // Guards against a path change that silently makes the scan empty.
    expect(walk(join(PACKAGE_ROOT, 'src')).length).toBeGreaterThan(500);
  });
});
