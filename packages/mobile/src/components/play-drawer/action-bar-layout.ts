import type { PlayDrawerHiddenButtons } from './play-drawer-menu-rows';

/** What the first row's leftmost slot holds. Slot 5 (the bulb) is `trailingSlot`. */
export type ActionBarLeadingSlot = 'mirror' | 'queue' | null;

/** One entry in the second row, left to right. `spacer` is the flex gap. */
export type ActionBarSecondaryItem = 'favorite' | 'angle' | 'spacer' | 'share' | 'queue' | 'connectPill';

export type ActionBarLayoutInput = {
  supportsMirroring: boolean;
  /** The signed-out web reader: every write affordance is removed, not disabled. */
  isAnonymous: boolean;
  /**
   * The connect-step test asked for its pill (#5654, PR 7). It shows only where
   * the bulb would have been offered, and never in commit mode or anonymously.
   */
  connectPill: boolean;
  /** The browse latch's commit bar owns the second row. */
  inCommitMode: boolean;
  /** A Bluetooth transport exists on this platform at all. */
  showLightbulb: boolean;
  /** The climb can be shared. A draft can't: a link to it opens for nobody else (#5960). */
  hasShare: boolean;
};

export type ActionBarLayout = {
  leadingSlot: ActionBarLeadingSlot;
  trailingSlot: 'lightbulb' | null;
  /** The commit bar, or the utilities left to right. */
  secondaryRow: 'commit' | readonly ActionBarSecondaryItem[];
  showConnectPill: boolean;
  /** Buttons this viewer may use that the bar has put away. ⋯ carries a row for each. */
  hidden: PlayDrawerHiddenButtons;
};

const NOTHING_HIDDEN: PlayDrawerHiddenButtons = Object.freeze({ favorite: false, share: false, queue: false });

/**
 * Where each action-bar button sits, for one bar state.
 *
 * ```
 * Non-mirror (Kilter, MoonBoard)   [☰]  [⏮]  [✓]  [⏭]  [💡]
 *                                  [♡] [40°] ············ [⬆]
 * Mirror (Tension, Decoy, Woods)   [⇄]  [⏮]  [✓]  [⏭]  [💡]
 *                                  [♡] [40°] ········ [⬆] [☰]
 * Anonymous                        [ ]  [⏮]  [✓]  [⏭]  [ ]     (mirror boards keep [⇄])
 *                                  [40°] ················ [⬆]
 * ```
 *
 * - The queue takes the first slot where a board can't mirror: it is the list
 *   ⏮ and ⏭ walk, and up there it survives commit mode and the connect pill.
 *   Mirror keeps the slot where it exists because it changes what is lit, and
 *   the queue stays at the right of the second row, where it has always been.
 * - The heart is always leftmost in the second row and share always rightmost
 *   before the queue.
 * - The connect pill replaces share (and the queue, on mirror boards); commit
 *   mode replaces the whole second row. Whatever goes is flagged in `hidden`,
 *   and the player's ⋯ menu picks it up.
 * - An anonymous reader has no account to favourite with and no queue that
 *   means anything, and no ⋯ either, so nothing is flagged for them.
 */
export function resolveActionBarLayout({
  supportsMirroring,
  isAnonymous,
  connectPill,
  inCommitMode,
  showLightbulb,
  hasShare,
}: ActionBarLayoutInput): ActionBarLayout {
  const commit = inCommitMode && !isAnonymous;
  const showConnectPill = connectPill && showLightbulb && !isAnonymous && !commit;
  const leadingSlot: ActionBarLeadingSlot = supportsMirroring ? 'mirror' : isAnonymous ? null : 'queue';
  const trailingSlot = showLightbulb && !isAnonymous && !showConnectPill ? 'lightbulb' : null;

  let secondaryRow: ActionBarLayout['secondaryRow'];
  if (commit) {
    secondaryRow = 'commit';
  } else {
    const items: ActionBarSecondaryItem[] = [];
    if (!isAnonymous) items.push('favorite');
    items.push('angle', 'spacer');
    if (showConnectPill) {
      items.push('connectPill');
    } else {
      if (hasShare) items.push('share');
      if (leadingSlot !== 'queue' && !isAnonymous) items.push('queue');
    }
    secondaryRow = items;
  }

  if (isAnonymous) return { leadingSlot, trailingSlot, secondaryRow, showConnectPill, hidden: NOTHING_HIDDEN };

  const shownInSecondRow = (item: ActionBarSecondaryItem) => secondaryRow !== 'commit' && secondaryRow.includes(item);
  return {
    leadingSlot,
    trailingSlot,
    secondaryRow,
    showConnectPill,
    hidden: {
      favorite: !shownInSecondRow('favorite'),
      share: hasShare && !shownInSecondRow('share'),
      queue: leadingSlot !== 'queue' && !shownInSecondRow('queue'),
    },
  };
}
