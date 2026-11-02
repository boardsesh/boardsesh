import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Put on board's timed drive on the Live Activity (owner decision 2026-11-02):
// the amber ring that drains round the bulb stays, and its seconds go
// everywhere a drive shows (the Lock Screen's wall control, the expanded
// island that shares it, the compact island's trailing slot; the minimal view
// never had them). The ring alone says how long is left, as on the app's
// MiniPlayer bulb. VoiceOver hears "Driving the wall" with no live number. The
// widget Swift is compiled only by the native build, so this pins the shape of
// the source instead.

const WIDGET_SOURCE = readFileSync(
  join(__dirname, '../../../../targets/BoardseshWidgets/ClimbSessionLiveActivity.swift'),
  'utf8',
);

/** The body of `private struct <name>`, up to the next top-level declaration. */
function structSource(name: string): string {
  const start = WIDGET_SOURCE.indexOf(`private struct ${name}`);
  expect(start, `struct ${name} not found`).toBeGreaterThanOrEqual(0);
  const nextDeclaration = WIDGET_SOURCE.slice(start + 1).search(
    /\n(?:@available|\/\/ MARK:|private struct|private func|struct )/,
  );
  return nextDeclaration === -1 ? WIDGET_SOURCE.slice(start) : WIDGET_SOURCE.slice(start, start + 1 + nextDeclaration);
}

/** The body of `private func <name>`, up to the next top-level declaration. */
function functionSource(name: string): string {
  const start = WIDGET_SOURCE.indexOf(`private func ${name}`);
  expect(start, `func ${name} not found`).toBeGreaterThanOrEqual(0);
  const nextDeclaration = WIDGET_SOURCE.slice(start + 1).search(/\n(?:@available|\/\/ MARK:|private struct|struct )/);
  return nextDeclaration === -1 ? WIDGET_SOURCE.slice(start) : WIDGET_SOURCE.slice(start, start + 1 + nextDeclaration);
}

describe('the drive on the Live Activity', () => {
  it('keeps the draining ring round the bulb for a timed drive, and the disc for an open-ended one', () => {
    const glyph = structSource('LightingBulbGlyph');
    expect(glyph).toMatch(
      /case let \.window\(start, end\):\s*ZStack \{\s*ProgressView\(timerInterval: start\.\.\.end, countsDown: true\)/,
    );
    expect(glyph).toContain('.progressViewStyle(.circular)');
    expect(glyph).toContain('.tint(palette.warning)');
    expect(glyph).toMatch(/case \.driving:\s*ZStack \{\s*Circle\(\)\s*\.fill\(palette\.warning\)/);
  });

  it('draws no drive digits anywhere: only the rest clock counts in text', () => {
    expect(WIDGET_SOURCE).not.toContain('lightingWindowDigitsText');
    // Every `Text(timerInterval:)` left in code (not in a comment) is the rest clock's.
    const code = WIDGET_SOURCE.split('\n').filter((line) => !line.trimStart().startsWith('//'));
    expect(code.filter((line) => line.includes('Text(timerInterval:'))).toHaveLength(1);
    expect(functionSource('restTimerDigitsText')).toContain('Text(timerInterval:');
    for (const view of ['WallControlStatus', 'CompactTrailingView', 'CompactLeadingView', 'MinimalView']) {
      expect(structSource(view), view).not.toContain('Text(timerInterval:');
    }
  });

  it("keeps the grade in the compact island's trailing slot during a drive", () => {
    const trailing = structSource('CompactTrailingView');
    expect(trailing).not.toContain('lighting');
    expect(WIDGET_SOURCE).toContain('CompactTrailingView(text: context.state.climbDifficulty, rest: rest)');
  });

  it('still rings the bulb in the compact and minimal islands when no rest runs', () => {
    for (const view of ['CompactLeadingView', 'MinimalView']) {
      expect(structSource(view), view).toMatch(/if rest == nil, lighting != \.previews \{\s*LightingBulbGlyph\(/);
    }
  });

  it('says Driving the wall for either drive, with the same value and no live number', () => {
    const status = structSource('WallControlStatus');
    expect(status).toMatch(/case \.window, \.driving: return Text\("Driving the wall"\)/);
    expect(status).toMatch(/case \.window, \.driving: return Text\("Every climb you pick lights up"\)/);
    expect(status).not.toContain('case let .window');
  });

  it('says Driving the wall from the ring itself, so the compact and minimal islands still say it', () => {
    const glyph = structSource('LightingBulbGlyph');
    // Both drives (the draining ring and the disc) label their one element.
    const labelled = glyph.match(
      /\.frame\(width: size, height: size\)\s*\.accessibilityElement\(children: \.ignore\)\s*\.accessibilityLabel\(Text\("Driving the wall"\)\)/g,
    );
    expect(labelled).toHaveLength(2);
    // The bare bulb (picks are previews) takes no drive label.
    expect(glyph.indexOf('case .previews:')).toBeGreaterThan(glyph.lastIndexOf('Text("Driving the wall")'));
    // The islands draw that glyph with no wrapper of their own, so its label is what VoiceOver reads there.
    for (const view of ['CompactLeadingView', 'MinimalView']) {
      expect(structSource(view), view).toContain('LightingBulbGlyph(lighting: lighting');
      expect(structSource(view), view).not.toContain('accessibilityElement(children: .ignore)');
    }
    // The Lock Screen's status ignores its children, so the label isn't read twice.
    expect(structSource('WallControlStatus')).toMatch(
      /LightingBulbGlyph\([\s\S]*\.accessibilityElement\(children: \.ignore\)\s*\.accessibilityLabel\(lightingLabel\)/,
    );
  });
});
