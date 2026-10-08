import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// HIG Sheets: a sheet opens at a standard height — medium, large, or sized to
// its content — not at whatever percentage looked right on one phone. The app's
// standard detents are MEDIUM_SNAP_POINTS / MEDIUM_LARGE_SNAP_POINTS /
// LARGE_SNAP_POINTS in sheet-snap-points.ts ('50%' and '90%').
//
// A source scan, not a render test: it fails when a line that sets snap points
// spells out any other percentage, unless the file is on the list below with
// its reason. Known gap: a height computed at runtime (ClimbFilterSheet,
// CreateDrawer) is invisible to it, which is fine — those are measured.

const MOBILE_ROOT = join(__dirname, '../../..');

const STANDARD_PERCENTS = new Set(['50%', '90%', '100%']);

/** Custom heights that stay, each with its reason. Shrink-only. */
const CUSTOM_HEIGHT_ALLOWLIST = new Set([
  // 70% was a QA decision for the queue's default height (6588aa88d2).
  'src/components/play-drawer/QueueSheet.tsx',
  // The board and session share sheets carry a QR code, and 60% may be what
  // keeps it whole on small phones. Check on a device before changing.
  'src/components/board-discovery/BoardShareSheet.tsx',
  'src/components/session-screen/InviteSheet.tsx',
  // The tick sheets' detents are measured against their form (#4723).
  'src/components/tick/tick-sheet-metrics.ts',
  // Owned by the top-bar PR (#6243), which is rewriting these sheets' headers
  // right now. Standardise them once it lands.
  'src/components/board-discovery/BoardDetailSheet.tsx',
  'src/components/gym-directory/ClaimGymSheet.tsx',
  'src/components/session/SessionEditSheet.tsx',
  'src/components/you/YouFilterSheet.tsx',
  'src/components/spray-wall/ReportSprayWallSheet.tsx',
  'src/components/settings/sections/AccessibilitySection.tsx',
  'src/components/user-drawer/FeedbackSheet.tsx',
  'src/components/report-climb/ReportClimbSheet.tsx',
  'src/components/user-drawer/QaVerdictSheet.tsx',
]);

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...listSourceFiles(fullPath));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function toRelative(filePath: string): string {
  return relative(MOBILE_ROOT, filePath).split(sep).join('/');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

/** Every non-standard percentage on a line that sets snap points. */
function customSnapPercents(source: string): string[] {
  const hits: string[] = [];
  for (const line of stripComments(source).split('\n')) {
    if (!/snap/i.test(line)) continue;
    for (const match of line.matchAll(/['"](\d+(?:\.\d+)?%)['"]/g)) {
      if (!STANDARD_PERCENTS.has(match[1])) hits.push(match[1]);
    }
  }
  return hits;
}

const SOURCE_FILES = [...listSourceFiles(join(MOBILE_ROOT, 'src')), ...listSourceFiles(join(MOBILE_ROOT, 'app'))];
const SOURCES = new Map(SOURCE_FILES.map((filePath) => [toRelative(filePath), readFileSync(filePath, 'utf8')]));

describe('standard sheet heights', () => {
  it('scans a real source tree', () => {
    expect(SOURCES.size).toBeGreaterThan(200);
    expect(SOURCES.has('src/components/sheet-snap-points.ts')).toBe(true);
  });

  it('flags a custom percentage and passes the standard detents', () => {
    expect(customSnapPercents("const SNAP_POINTS = ['72%'];")).toEqual(['72%']);
    expect(customSnapPercents("snapPoints={['55%', '92%']}")).toEqual(['55%', '92%']);
    expect(customSnapPercents("snapPoints={['50%', '90%']}")).toEqual([]);
    expect(customSnapPercents("width: '72%',")).toEqual([]);
  });

  it('no sheet outside the allowlist opens at a custom height', () => {
    const offenders = [...SOURCES]
      .filter(([path, source]) => !CUSTOM_HEIGHT_ALLOWLIST.has(path) && customSnapPercents(source).length > 0)
      .map(([path, source]) => `${path}: ${customSnapPercents(source).join(', ')}`);
    // Use MEDIUM_SNAP_POINTS / MEDIUM_LARGE_SNAP_POINTS / LARGE_SNAP_POINTS, or
    // size the sheet to its content.
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest: every listed file still has a custom height', () => {
    const stale = [...CUSTOM_HEIGHT_ALLOWLIST].filter(
      (path) => customSnapPercents(SOURCES.get(path) ?? '').length === 0,
    );
    expect(stale).toEqual([]);
  });
});
