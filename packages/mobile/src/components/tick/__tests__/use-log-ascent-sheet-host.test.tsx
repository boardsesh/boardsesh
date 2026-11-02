// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogAscentInput } from '../../../providers/drawer-host-provider';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';

type SheetProps = LogAscentInput & {
  visible: boolean;
  presenterGroup?: string;
  parentSheetId?: string;
  stacked: boolean;
  onClose: () => void;
  onFullyDismissed: () => void;
};
const recorded = vi.hoisted(() => ({ current: null as SheetProps | null, mounts: 0, unmounts: 0 }));
vi.mock('../../LogAscentSheet', async () => {
  const { createElement, useEffect } = await import('react');
  return {
    LogAscentSheet: (props: SheetProps) => {
      recorded.current = props;
      useEffect(() => {
        recorded.mounts += 1;
        return () => {
          recorded.unmounts += 1;
        };
      }, []);
      return createElement('div', {
        'data-testid': 'local-tick-sheet',
        'data-climb': props.climbUuid,
        'data-visible': String(props.visible),
      });
    },
  };
});

import { useLogAscentSheetHost } from '../use-log-ascent-sheet-host';

let host: ReturnType<typeof useLogAscentSheetHost>;
function Harness({ group, parent }: { group?: string; parent?: string }) {
  host = useLogAscentSheetHost(group, parent);
  return host.sheet;
}
function input(climbUuid: string): LogAscentInput {
  return {
    climbUuid,
    climbName: `Climb ${climbUuid}`,
    boardName: 'kilter',
    angle: 40,
    isMirror: false,
    isBenchmark: false,
    baseAscensionistCount: 12,
    sessionId: 'crew-session',
  };
}
function currentSheet(): SheetProps {
  if (!recorded.current) throw new Error('No local Tick sheet was rendered');
  return recorded.current;
}

beforeEach(() => {
  recorded.current = null;
  recorded.mounts = 0;
  recorded.unmounts = 0;
});
afterEach(cleanup);

describe('useLogAscentSheetHost', () => {
  it.each([
    [undefined, undefined, false],
    ['queue-tick:queue-one', 'queue-one', true],
    ['play-tick:route-one', undefined, true],
  ] as const)('scopes the Tick presenter to its opener (%s)', (group, parent, stacked) => {
    const rendered = render(createElement(Harness, { group, parent }));
    expect(rendered.queryByTestId('local-tick-sheet')).toBeNull();
    expect(host.hasRequest).toBe(false);
    act(() => host.openLogAscent(input('a')));
    expect(host.hasRequest).toBe(true);
    expect(currentSheet()).toMatchObject({
      ...input('a'),
      visible: true,
      presenterGroup: group,
      parentSheetId: parent,
      stacked,
    });
  });

  it('ignores repeated taps while a Tick sheet is open', () => {
    const rendered = render(createElement(Harness));
    act(() => host.openLogAscent(input('a')));
    const first = rendered.getByTestId('local-tick-sheet');
    act(() => {
      host.openLogAscent(input('a'));
      host.openLogAscent(input('b'));
    });
    expect(currentSheet()).toMatchObject({ climbUuid: 'a', visible: true });
    expect(rendered.getByTestId('local-tick-sheet')).toBe(first);
    expect(recorded.mounts).toBe(1);
    expect(recorded.unmounts).toBe(0);
  });

  it('retains the same sheet host and climb until native dismissal settles', () => {
    const rendered = render(createElement(Harness, { group: 'queue-tick:queue-one', parent: 'queue-one' }));
    act(() => host.openLogAscent(input('a')));
    const mountedSheet = rendered.getByTestId('local-tick-sheet');
    act(() => currentSheet().onClose());
    expect(rendered.getByTestId('local-tick-sheet')).toBe(mountedSheet);
    expect(currentSheet()).toMatchObject({ climbUuid: 'a', visible: false });
    expect(host.hasRequest).toBe(true);
    expect(recorded.mounts).toBe(1);
    expect(recorded.unmounts).toBe(0);
    act(() => currentSheet().onFullyDismissed());
    expect(rendered.queryByTestId('local-tick-sheet')).toBeNull();
    expect(host.hasRequest).toBe(false);
    expect(recorded.unmounts).toBe(1);
  });

  it('queues a new open during dismissal and rejects stale callbacks after the replacement opens', () => {
    const rendered = render(createElement(Harness));
    act(() => host.openLogAscent(input('a')));
    const first = currentSheet();
    act(() => first.onClose());
    act(() => host.openLogAscent(input('b')));
    expect(currentSheet()).toMatchObject({ climbUuid: 'a', visible: false });
    expect(host.hasRequest).toBe(true);
    expect(recorded.mounts).toBe(1);
    act(() => first.onFullyDismissed());
    expect(currentSheet()).toMatchObject({ climbUuid: 'b', visible: true });
    expect(host.hasRequest).toBe(true);
    expect(recorded.mounts).toBe(2);
    expect(recorded.unmounts).toBe(1);
    const replacement = rendered.getByTestId('local-tick-sheet');
    act(() => {
      first.onClose();
      first.onFullyDismissed();
      currentSheet().onFullyDismissed();
    });
    expect(rendered.getByTestId('local-tick-sheet')).toBe(replacement);
    expect(currentSheet()).toMatchObject({ climbUuid: 'b', visible: true });
  });

  it('clears current and queued requests when the parent host is reset', () => {
    const rendered = render(createElement(Harness));
    act(() => host.openLogAscent(input('a')));
    const first = currentSheet();
    act(() => first.onClose());
    act(() => host.openLogAscent(input('b')));
    act(() => host.reset());
    act(() => first.onFullyDismissed());
    expect(rendered.queryByTestId('local-tick-sheet')).toBeNull();
    expect(host.hasRequest).toBe(false);
    act(() => host.openLogAscent(input('c')));
    expect(currentSheet()).toMatchObject({ climbUuid: 'c', visible: true });
  });

  it('withdraws Tick content at a credential boundary and refuses stale open and close callbacks', () => {
    const rendered = render(createElement(Harness));
    act(() => host.openLogAscent(input('private-a')));
    const first = currentSheet();
    const staleOpen = host.openLogAscent;
    act(() => {
      invalidateCredentialSnapshots();
      staleOpen(input('late-private-a'));
    });
    expect(rendered.queryByTestId('local-tick-sheet')).toBeNull();
    expect(host.hasRequest).toBe(false);
    act(() => host.openLogAscent(input('authorized-b')));
    act(() => {
      staleOpen(input('still-private-a'));
      first.onClose();
      first.onFullyDismissed();
    });
    expect(currentSheet()).toMatchObject({ climbUuid: 'authorized-b', visible: true });
  });
});
