import { describe, expect, it } from 'vitest';
import { resolveActionBarLayout, type ActionBarLayoutInput } from '../action-bar-layout';

const MEMBER: ActionBarLayoutInput = {
  supportsMirroring: false,
  isAnonymous: false,
  connectPill: false,
  inCommitMode: false,
  showLightbulb: true,
  hasShare: true,
};
const MIRROR: ActionBarLayoutInput = { ...MEMBER, supportsMirroring: true };

describe('resolveActionBarLayout', () => {
  // [☰] [⏮] [✓] [⏭] [💡] / [♡] [40°] ··· [⬆]
  it('puts the queue in the first slot on a board without mirror, and hides nothing', () => {
    expect(resolveActionBarLayout(MEMBER)).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      secondaryRow: ['favorite', 'angle', 'spacer', 'share'],
      showConnectPill: false,
      hidden: { favorite: false, share: false, queue: false },
    });
  });

  // [⇄] [⏮] [✓] [⏭] [💡] / [♡] [40°] ··· [⬆] [☰]
  it('keeps mirror first and the queue rightmost in the second row on a mirror board', () => {
    expect(resolveActionBarLayout(MIRROR)).toEqual({
      leadingSlot: 'mirror',
      trailingSlot: 'lightbulb',
      secondaryRow: ['favorite', 'angle', 'spacer', 'share', 'queue'],
      showConnectPill: false,
      hidden: { favorite: false, share: false, queue: false },
    });
  });

  // [ ] [⏮] [✓] [⏭] [ ] / [40°] ··· [⬆]
  it('gives an anonymous reader no queue, heart or bulb, and flags nothing for a ⋯ they do not get', () => {
    expect(resolveActionBarLayout({ ...MEMBER, isAnonymous: true, connectPill: true, inCommitMode: true })).toEqual({
      leadingSlot: null,
      trailingSlot: null,
      secondaryRow: ['angle', 'spacer', 'share'],
      showConnectPill: false,
      hidden: { favorite: false, share: false, queue: false },
    });
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true }).leadingSlot).toBe('mirror');
    expect(resolveActionBarLayout({ ...MIRROR, isAnonymous: true }).secondaryRow).toEqual(['angle', 'spacer', 'share']);
  });

  it('swaps share for the connect pill without mirror, and hands share to ⋯', () => {
    expect(resolveActionBarLayout({ ...MEMBER, connectPill: true })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: null,
      secondaryRow: ['favorite', 'angle', 'spacer', 'connectPill'],
      showConnectPill: true,
      hidden: { favorite: false, share: true, queue: false },
    });
  });

  it('swaps share and the queue for the connect pill on a mirror board, and hands both to ⋯', () => {
    const layout = resolveActionBarLayout({ ...MIRROR, connectPill: true });
    expect(layout.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'connectPill']);
    expect(layout.hidden).toEqual({ favorite: false, share: true, queue: true });
  });

  it('gives the second row to the commit bar, and hands the heart and share to ⋯; the first-slot queue stays', () => {
    expect(resolveActionBarLayout({ ...MEMBER, inCommitMode: true })).toEqual({
      leadingSlot: 'queue',
      trailingSlot: 'lightbulb',
      secondaryRow: 'commit',
      showConnectPill: false,
      hidden: { favorite: true, share: true, queue: false },
    });
  });

  it('hands the queue to ⋯ too in commit mode on a mirror board', () => {
    expect(resolveActionBarLayout({ ...MIRROR, inCommitMode: true }).hidden).toEqual({
      favorite: true,
      share: true,
      queue: true,
    });
  });

  it('lets commit mode win over the pill, which puts the bulb back in its slot', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, connectPill: true, inCommitMode: true });
    expect(layout.showConnectPill).toBe(false);
    expect(layout.trailingSlot).toBe('lightbulb');
    expect(layout.secondaryRow).toBe('commit');
  });

  it('never shows the pill or the bulb without Bluetooth', () => {
    const layout = resolveActionBarLayout({ ...MEMBER, connectPill: true, showLightbulb: false });
    expect(layout.showConnectPill).toBe(false);
    expect(layout.trailingSlot).toBeNull();
    expect(layout.secondaryRow).toEqual(['favorite', 'angle', 'spacer', 'share']);
  });

  // A draft has no share at all (#5960), so ⋯ must not invent one either.
  it('neither draws nor hands on share for a climb that has none', () => {
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false }).secondaryRow).toEqual([
      'favorite',
      'angle',
      'spacer',
    ]);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, inCommitMode: true }).hidden.share).toBe(false);
    expect(resolveActionBarLayout({ ...MEMBER, hasShare: false, connectPill: true }).hidden.share).toBe(false);
  });
});
