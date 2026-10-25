import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ActivityKit marks a Live Activity stale after
// `SharedConstants.liveActivityStaleInterval` (10 min) with no update. That
// only means the card stopped hearing from the app or the backend: every real
// session end dismisses the activity at once, so the card never sees one. The
// card used to swap itself for a "Session ended" view on staleness, telling a
// climber mid-session that it was over and hiding a rest clock that was still
// counting (#6529). The widget Swift is compiled only by the native build, so
// this pins the shape of the source instead.

const WIDGET_SOURCE = readFileSync(
  join(__dirname, '../../../../targets/BoardseshWidgets/ClimbSessionLiveActivity.swift'),
  'utf8',
);

/** The body of `private struct <name>`, up to the next top-level declaration. */
function structSource(name: string): string {
  const start = WIDGET_SOURCE.indexOf(`private struct ${name}: View {`);
  expect(start, `struct ${name} not found`).toBeGreaterThanOrEqual(0);
  const nextDeclaration = WIDGET_SOURCE.slice(start + 1).search(/\n(?:@available|\/\/ MARK:|private struct|struct )/);
  return nextDeclaration === -1 ? WIDGET_SOURCE.slice(start) : WIDGET_SOURCE.slice(start, start + 1 + nextDeclaration);
}

function dynamicIslandBottomRegion(): string {
  const start = WIDGET_SOURCE.indexOf('DynamicIslandExpandedRegion(.bottom)');
  expect(start, 'Dynamic Island bottom region not found').toBeGreaterThanOrEqual(0);
  const end = WIDGET_SOURCE.indexOf('} compactLeading:', start);
  return WIDGET_SOURCE.slice(start, end);
}

describe('stale Live Activity card', () => {
  it('never claims the session ended', () => {
    const forbidden = ['Text("Session ended")', 'staleView'].filter((snippet) => WIDGET_SOURCE.includes(snippet));
    expect(forbidden).toEqual([]);
  });

  it('asks the climber to open the app instead', () => {
    expect(structSource('StaleFooter')).toContain('Text("Open Boardsesh to refresh")');
  });

  it('keeps the climb card and the rest clock on the Lock Screen while stale', () => {
    const lockScreen = structSource('LockScreenView');
    expect(lockScreen).toContain('activeView(isStale: context.isStale)');
    expect(lockScreen).toContain('RestTimerBlock(rest: rest)');
    expect(lockScreen).toMatch(/if isStale \{\s*StaleFooter\(\)\s*\} else \{\s*SessionFooter\(/);
  });

  it('swaps the Dynamic Island controls for the same refresh prompt', () => {
    expect(dynamicIslandBottomRegion()).toMatch(
      /if context\.isStale \{\s*StaleFooter\(\)\s*\} else \{\s*SessionFooter\(/,
    );
  });
});
