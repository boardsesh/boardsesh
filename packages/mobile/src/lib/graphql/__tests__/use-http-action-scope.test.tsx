// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ scoped: true, handle: 'owned-A', revision: 0 }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () =>
    useMemo(() => {
      const original = { ...view };
      return {
        scoped: original.scoped,
        scope: original.scoped ? `${original.handle}-${original.revision}` : undefined,
        assertView() {
          if (original.scoped && (original.handle !== view.handle || original.revision !== view.revision))
            throw new Error('Original owned view retired');
        },
      };
    }, [view.scoped, view.handle, view.revision]),
}));
import { useHttpActionScope } from '../use-http-action-scope';

beforeEach(() => {
  view.scoped = true;
  view.handle = 'owned-A';
  view.revision = 0;
});
afterEach(cleanup);

describe('original UI action view and lifetime', () => {
  it('retains a fixed original action while refusing B and ABA without another capture', () => {
    const { result } = renderHook(() => useHttpActionScope());
    const original = result.current.capture();
    original.assertView();
    view.handle = 'owned-B';
    view.revision += 1;
    expect(original.isCurrent()).toBe(false);
    view.handle = 'owned-A';
    view.revision += 1;
    expect(() => original.assertView()).toThrow();
  });

  it('aborts owned pending actions on unmount and refuses their later completions', () => {
    const { result, unmount } = renderHook(() => useHttpActionScope());
    const original = result.current.capture();
    unmount();
    expect(original.signal.aborted).toBe(true);
    expect(original.isCurrent()).toBe(false);
    expect(() => original.assertView()).toThrow();
  });

  it('retires the removed action before its parent layout effects can publish', () => {
    let action: ReturnType<ReturnType<typeof useHttpActionScope>['capture']> | undefined;
    let observed: { current: boolean; aborted: boolean } | undefined;
    function Form() {
      const scope = useHttpActionScope();
      useEffect(() => {
        action = scope.capture();
      }, [scope]);
      return <span>mounted form</span>;
    }
    function Parent() {
      const [show, setShow] = useState(true);
      useLayoutEffect(() => {
        if (!show && action) observed = { current: action.isCurrent(), aborted: action.signal.aborted };
      }, [show]);
      return (
        <div>
          <button onClick={() => setShow(false)}>leave form</button>
          {show ? <Form /> : null}
        </div>
      );
    }
    render(<Parent />);
    expect(action?.isCurrent()).toBe(true);
    fireEvent.click(screen.getByText('leave form'));
    expect(observed).toEqual({ current: false, aborted: true });
  });

  it('finishes only its own action while another current action remains usable', () => {
    const { result } = renderHook(() => useHttpActionScope());
    const first = result.current.capture();
    const second = result.current.capture();
    first.finish();
    first.finish();
    expect(first.isCurrent()).toBe(false);
    second.assertView();
    expect(second.signal.aborted).toBe(false);
    second.finish();
  });

  it('never revives an earlier action during Strict Mode cleanup and remount', () => {
    const attempts: ReturnType<ReturnType<typeof useHttpActionScope>['capture']>[] = [];
    renderHook(
      () => {
        const scope = useHttpActionScope();
        useEffect(() => {
          attempts.push(scope.capture());
        }, [scope]);
      },
      { reactStrictMode: true },
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0].signal.aborted).toBe(true);
    expect(attempts[0].isCurrent()).toBe(false);
    attempts[1].assertView();
  });

  it('changes only selected view keys and retains the native/legacy form key', () => {
    const { result, rerender } = renderHook(() => useHttpActionScope());
    const originalKey = result.current.key;
    act(() => {
      view.revision += 1;
      rerender();
    });
    expect(result.current.key).not.toBe(originalKey);
    act(() => {
      view.scoped = false;
      rerender();
    });
    const nativeKey = result.current.key;
    act(() => {
      view.revision += 1;
      rerender();
    });
    expect(result.current.key).toBe(nativeKey);
  });
});
