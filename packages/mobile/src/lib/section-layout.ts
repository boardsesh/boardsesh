// Sections a climber can show, hide and put in order: what sits below the climb
// in the player today, Home and the player buttons next. Pure and synchronous;
// storage stays with each caller (the play drawer's own AsyncStorage record, or
// `createSectionLayoutStore` over the settings store).
//
// Visibility and order are kept apart. Hiding a section keeps its slot, so
// showing it again puts it back where the climber left it.

export type SectionLayout<Id extends string> = {
  /** Every known section exactly once, hidden ones included. */
  readonly order: readonly Id[];
  readonly visible: Readonly<Record<Id, boolean>>;
};

export type SectionLayoutSpec<Id extends string> = {
  /** Every section this build knows. `defaults.order` lists each of them once. */
  readonly ids: readonly Id[];
  readonly defaults: SectionLayout<Id>;
  /** Always last, such as Home's endless feed: it never moves, and nothing moves below it. */
  readonly lockedLast?: Id;
};

/** -1 moves a section one place up the list, 1 one place down. */
export type SectionMoveDirection = -1 | 1;

/** What `createSectionLayoutStore` keeps in the settings store. `null` there means the defaults. */
export type SectionLayoutRecord = {
  readonly version: 1;
  readonly order: readonly string[];
  readonly visible: Readonly<Record<string, boolean>>;
};

function isKnownSection<Id extends string>(spec: SectionLayoutSpec<Id>, candidate: unknown): candidate is Id {
  return typeof candidate === 'string' && (spec.ids as readonly string[]).includes(candidate);
}

/**
 * Reads a stored order. Unknown and repeated ids are dropped. A section the
 * stored order does not list (new in a later release, or a record written before
 * there was an order) goes where the defaults put it: straight after the section
 * it follows there, or first when it leads the defaults.
 */
export function sanitiseSectionOrder<Id extends string>(spec: SectionLayoutSpec<Id>, stored: unknown): Id[] {
  const order: Id[] = [];
  if (Array.isArray(stored)) {
    for (const candidate of stored) {
      if (isKnownSection(spec, candidate) && !order.includes(candidate)) order.push(candidate);
    }
  }
  const listedDefaults = spec.defaults.order.filter((sectionId) => isKnownSection(spec, sectionId));
  const defaultOrder = [...listedDefaults, ...spec.ids.filter((sectionId) => !listedDefaults.includes(sectionId))];
  defaultOrder.forEach((sectionId, defaultIndex) => {
    if (order.includes(sectionId)) return;
    // Walking the defaults in order, the section before this one is always placed by now.
    const insertAt = defaultIndex === 0 ? 0 : order.indexOf(defaultOrder[defaultIndex - 1]) + 1;
    order.splice(insertAt, 0, sectionId);
  });
  // A locked id the spec does not list is ignored rather than allowed to push a real section out.
  const lockedIndex = spec.lockedLast === undefined ? -1 : order.indexOf(spec.lockedLast);
  if (lockedIndex >= 0) order.push(...order.splice(lockedIndex, 1));
  return order;
}

/**
 * Puts back the ids a stored order holds that this build does not know, each
 * straight after the id it followed there (or first when nothing before it is
 * placed). A later release's section then keeps its place and its switch
 * through this release's writes, such as after an OTA rollback.
 */
export function withUnknownSectionsKept<Id extends string>(
  spec: SectionLayoutSpec<Id>,
  order: readonly Id[],
  storedOrder: unknown,
): string[] {
  const kept: string[] = [...order];
  if (!Array.isArray(storedOrder)) return kept;
  storedOrder.forEach((candidate: unknown, storedIndex) => {
    if (typeof candidate !== 'string' || isKnownSection(spec, candidate) || kept.includes(candidate)) return;
    let insertAt = 0;
    for (let earlier = storedIndex - 1; earlier >= 0; earlier -= 1) {
      const placedAt = kept.indexOf(storedOrder[earlier]);
      if (placedAt >= 0) {
        insertAt = placedAt + 1;
        break;
      }
    }
    kept.splice(insertAt, 0, candidate);
  });
  return kept;
}

/** The switches a stored record holds for ids this build does not know, to write back as they were. */
export function unknownSectionVisibility<Id extends string>(
  spec: SectionLayoutSpec<Id>,
  storedVisible: unknown,
): Record<string, boolean> {
  const unknown: Record<string, boolean> = {};
  if (typeof storedVisible !== 'object' || storedVisible === null) return unknown;
  for (const [sectionId, visible] of Object.entries(storedVisible)) {
    if (!isKnownSection(spec, sectionId) && typeof visible === 'boolean') unknown[sectionId] = visible;
  }
  return unknown;
}

/** Reads a stored `{ order, visible }`; anything missing or malformed falls back to the defaults. */
export function sanitiseSectionLayout<Id extends string>(
  spec: SectionLayoutSpec<Id>,
  stored: unknown,
): SectionLayout<Id> {
  const record =
    typeof stored === 'object' && stored !== null ? (stored as { order?: unknown; visible?: unknown }) : {};
  const storedVisible =
    typeof record.visible === 'object' && record.visible !== null ? (record.visible as Record<string, unknown>) : {};
  const visible = {} as Record<Id, boolean>;
  for (const sectionId of spec.ids) {
    const choice = storedVisible[sectionId];
    // A spec that leaves a section's default out shows it.
    visible[sectionId] = typeof choice === 'boolean' ? choice : spec.defaults.visible[sectionId] !== false;
  }
  return { order: sanitiseSectionOrder(spec, record.order), visible };
}

export function canMoveSection<Id extends string>(
  spec: SectionLayoutSpec<Id>,
  layout: SectionLayout<Id>,
  sectionId: Id,
  direction: SectionMoveDirection,
): boolean {
  const from = layout.order.indexOf(sectionId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= layout.order.length) return false;
  return sectionId !== spec.lockedLast && layout.order[to] !== spec.lockedLast;
}

/** Swaps a section with its neighbour, hidden or not. Returns the same layout when it cannot move. */
export function withSectionMoved<Id extends string>(
  spec: SectionLayoutSpec<Id>,
  layout: SectionLayout<Id>,
  sectionId: Id,
  direction: SectionMoveDirection,
): SectionLayout<Id> {
  if (!canMoveSection(spec, layout, sectionId, direction)) return layout;
  const from = layout.order.indexOf(sectionId);
  const order = [...layout.order];
  order.splice(from, 1);
  order.splice(from + direction, 0, sectionId);
  return { ...layout, order };
}

export function withSectionVisible<Id extends string>(
  layout: SectionLayout<Id>,
  sectionId: Id,
  visible: boolean,
): SectionLayout<Id> {
  if (layout.visible[sectionId] === visible) return layout;
  return { ...layout, visible: { ...layout.visible, [sectionId]: visible } };
}

/** Show all (`true`) or Hide all (`false`). The order stays as it is. */
export function withAllSectionsVisible<Id extends string>(
  layout: SectionLayout<Id>,
  visible: boolean,
): SectionLayout<Id> {
  if (layout.order.every((sectionId) => layout.visible[sectionId] === visible)) return layout;
  const nextVisible: Record<Id, boolean> = { ...layout.visible };
  for (const sectionId of layout.order) nextVisible[sectionId] = visible;
  return { ...layout, visible: nextVisible };
}

/** The sections to draw, in order. `isEligible` drops one that has nothing to show here. */
export function visibleSectionIds<Id extends string>(
  layout: SectionLayout<Id>,
  isEligible: (sectionId: Id) => boolean = () => true,
): Id[] {
  return layout.order.filter((sectionId) => layout.visible[sectionId] && isEligible(sectionId));
}

export function isSameSectionOrder<Id extends string>(first: readonly Id[], second: readonly Id[]): boolean {
  return first.length === second.length && first.every((sectionId, index) => second[index] === sectionId);
}

export function isSameSectionLayout<Id extends string>(first: SectionLayout<Id>, second: SectionLayout<Id>): boolean {
  return (
    isSameSectionOrder(first.order, second.order) &&
    first.order.every((sectionId) => first.visible[sectionId] === second.visible[sectionId])
  );
}
