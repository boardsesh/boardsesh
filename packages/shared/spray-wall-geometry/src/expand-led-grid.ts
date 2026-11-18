import { generateLedPositions, MAX_LED_POSITIONS, type LedPosition } from './led-layout';
import { ledPairs, readLedPairs } from './led-pairs';
import type { TnutLayout, TnutPoint } from './tnut-layout';

const pointKey = ({ x, y }: TnutPoint) => `${x.toFixed(8)}:${y.toFixed(8)}`;

function originalPoint(id: string): TnutPoint | undefined {
  const match = /^led-(\d\.\d{8})-(\d\.\d{8})$/.exec(id);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
}

/** Previous versions could save the new holes before rebuilding the old LEDs. */
export function hasStaleLedGrid(layout: TnutLayout): boolean {
  if (layout.pattern === 'custom') return false;
  const holes = new Set(layout.holes.map(pointKey));
  return (layout.ledPositions ?? []).some(
    (led) =>
      originalPoint(led.id) &&
      ((led.hole && !holes.has(pointKey(led.hole))) || (led.aboveHole && !holes.has(pointKey(led.aboveHole)))),
  );
}

function mountingSlot(layout: TnutLayout, led: LedPosition, origin: TnutPoint): string {
  if (!led.hole) return pointKey(origin);
  const key = pointKey(led.hole);
  if (layout.ledPlacement !== 'sides') return key;
  const { topLeft, topRight } = layout.corners;
  // Compare the original positions along the wall's horizontal axis. A change
  // of spacing can move the nominal position while keeping the same left/right
  // LED at the same hole.
  const direction =
    (origin.x - led.hole.x) * (topRight.x - topLeft.x) + (origin.y - led.hole.y) * (topRight.y - topLeft.y);
  return `${key}:${direction < 0 ? 'left' : 'right'}`;
}

/** Reuse physical LED identities on a larger grid. Added LEDs start unwired. */
export function expandLedGrid(
  previous: TnutLayout,
  draft: TnutLayout,
): { layout: TnutLayout; needsReview: boolean } | 'capacity' | null {
  if (
    previous.pattern === 'custom' ||
    draft.pattern !== previous.pattern ||
    draft.ledPlacement !== previous.ledPlacement ||
    !draft.ledPlacement ||
    !draft.ledPositions
  ) {
    return null;
  }
  const grew =
    draft.rows >= previous.rows &&
    draft.columns >= previous.columns &&
    (draft.rows > previous.rows || draft.columns > previous.columns);
  const stale = hasStaleLedGrid(previous);
  if (!grew && !stale) return null;

  const previousTemplate = stale ? [] : generateLedPositions(previous);
  const previousSlots = new Map(previousTemplate.map((led) => [mountingSlot(previous, led, led), led]));
  const previousById = new Map(previousTemplate.map((led) => [led.id, led]));
  const installedBySlot = new Map<string, LedPosition>();
  const keep = new Set([
    ...(draft.wiring?.paths.flat() ?? []),
    ...(draft.holdLeds?.flatMap((link) => link.ledIds) ?? []),
    ...(draft.ledGroups?.flat() ?? []),
  ]);
  let needsReview = stale;
  for (const led of draft.ledPositions) {
    const nominal = previousById.get(led.id);
    const origin = nominal ?? led.origin ?? originalPoint(led.id);
    if (origin) {
      const slot = mountingSlot(previous, nominal ?? led, origin);
      // Duplicate bindings are ambiguous. Use the original generated slot
      // first and keep the other physical position for manual review.
      const existing = installedBySlot.get(slot);
      if (!existing || nominal) {
        if (existing) keep.add(existing.id);
        installedBySlot.set(slot, led);
      } else {
        keep.add(led.id);
      }
    }
    if (!origin || pointKey(led) !== pointKey(origin)) {
      keep.add(led.id);
      needsReview = true;
    }
  }

  const retained = new Set<string>();
  const additions: LedPosition[] = [];
  const nextTemplate = generateLedPositions(draft);
  if ([...previousSlots.keys()].some((slot) => !installedBySlot.has(slot))) needsReview = true;
  for (const led of nextTemplate) {
    const slot = mountingSlot(draft, led, led);
    const existing = installedBySlot.get(slot);
    if (existing) retained.add(existing.id);
    else if (!previousSlots.has(slot)) additions.push(led);
  }

  // Preserve wired or edited LEDs at their actual photographed positions even
  // when denser spacing moves their nominal slots. Guessing a different hole
  // here would silently change what a physical index lights.
  const currentHoles = new Set(draft.holes.map(pointKey));
  const kept = draft.ledPositions
    .filter(({ id }) => retained.has(id) || keep.has(id))
    .map((led) => {
      const removedHole = led.hole && !currentHoles.has(pointKey(led.hole));
      // Upper references are automatic. A new pitch can put another nut/LED
      // between an old pair even when both old nuts still exist. Re-infer from
      // the retained origin, which older clients also preserve, on next bind.
      const removedAboveHole = led.aboveHole !== undefined;
      if (!removedHole && !removedAboveHole) return led;
      // Keep physical dots and surviving primary references intact.
      const { hole, aboveHole: _aboveHole, ...independent } = led;
      return {
        ...independent,
        ...(!removedHole && hole ? { hole } : {}),
      };
    });
  if (kept.some(({ id }) => !retained.has(id))) needsReview = true;
  const usedPoints = new Set(kept.map(pointKey));
  const usedIds = new Set(kept.map((led) => led.id));
  const newLeds: LedPosition[] = [];
  for (const led of additions) {
    const key = pointKey(led);
    if (usedPoints.has(key)) continue;
    let id = led.id;
    for (let suffix = 1; usedIds.has(id); suffix++) id = `${led.id}-${suffix}`;
    usedPoints.add(key);
    usedIds.add(id);
    newLeds.push(id === led.id ? led : { ...led, id, origin: { x: led.x, y: led.y } });
  }
  const ledPositions = [...kept, ...newLeds];
  if (ledPositions.length > MAX_LED_POSITIONS) return 'capacity';
  const layout = { ...draft, ledPositions };
  if (draft.ledPlacement === 'sides' || draft.ledGroups !== undefined) {
    // Include inferred pairs from the earlier grid so LEDs kept off-grid are
    // still paired. Explicit unpairing limits defaults to the newly added LEDs.
    const savedPairs =
      readLedPairs(
        ledPairs({ ...previous, ledPositions: draft.ledPositions, ledGroups: draft.ledGroups }),
        ledPositions,
      ) ?? [];
    const defaults = ledPairs({
      ...layout,
      ledPositions: draft.ledGroups === undefined ? ledPositions : newLeds,
      ledGroups: undefined,
    });
    const partners = new Map(
      defaults.flatMap(([first, second]) => [
        [first, second],
        [second, first],
      ]),
    );
    if (draft.ledGroups !== undefined || savedPairs.some(([first, second]) => partners.get(first) !== second)) {
      layout.ledGroups = readLedPairs([...savedPairs, ...defaults], ledPositions) ?? [];
    }
  }
  return { layout, needsReview };
}
