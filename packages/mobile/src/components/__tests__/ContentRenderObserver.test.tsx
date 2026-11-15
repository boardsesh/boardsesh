// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentRenderMarker, ContentRenderObserverProvider } from '../ContentRenderObserver';

afterEach(cleanup);

describe('rendered-content observation', () => {
  it('does not report data from a screen that has not rendered its content', () => {
    const observe = vi.fn();
    function Screen({ visible, count }: { visible: boolean; count: number }) {
      return (
        <ContentRenderObserverProvider onContentRendered={observe}>
          {visible ? (
            <section>
              <ContentRenderMarker route="/climbs" count={count} />
            </section>
          ) : null}
        </ContentRenderObserverProvider>
      );
    }
    const screen = render(<Screen visible={false} count={30} />);
    expect(observe).not.toHaveBeenCalled();
    screen.rerender(<Screen visible count={30} />);
    expect(observe).toHaveBeenLastCalledWith({ route: '/climbs', count: 30 });
    screen.rerender(<Screen visible count={60} />);
    expect(observe).toHaveBeenLastCalledWith({ route: '/climbs', count: 60 });
  });

  it('needs no observer in the ordinary application', () => {
    expect(() => render(<ContentRenderMarker route="/climbs" count={30} />)).not.toThrow();
  });
});
