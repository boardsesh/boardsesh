// @vitest-environment jsdom
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn(), replace: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

const { useUnsupportedBoardExit } = await import('../use-unsupported-board-exit');

function Probe({ shouldExit, reason }: { shouldExit: boolean; reason?: string }) {
  useUnsupportedBoardExit(shouldExit, reason);
  return createElement('div');
}

beforeEach(() => {
  vi.clearAllMocks();
  router.canGoBack.mockReturnValue(false);
});

describe('useUnsupportedBoardExit', () => {
  it('is inert when the route can stay', () => {
    render(<Probe shouldExit={false} reason="nope" />);

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('pops back to where the climber came from', () => {
    router.canGoBack.mockReturnValue(true);

    render(<Probe shouldExit reason="Pick a board first." />);

    expect(router.back).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('lands on the climbs tab when a cold link left no history', () => {
    render(<Probe shouldExit reason="Pick a board first." />);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  // #4760: the route vanishing on its own reads as a tap that didn't register.
  it('says why on the way out', () => {
    render(<Probe shouldExit reason="Pick a board first." />);

    expect(showToast).toHaveBeenCalledWith('Pick a board first.', 'error');
  });

  it('stays quiet when the destination explains itself', () => {
    render(<Probe shouldExit />);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).not.toHaveBeenCalled();
  });

  // The reason is an effect dep, so a route whose failure shifts in the frames
  // before the pop lands must not pop twice or stack two toasts.
  it('exits once even if the reason changes before the pop lands', () => {
    const { rerender } = render(<Probe shouldExit reason="first" />);
    rerender(<Probe shouldExit reason="second" />);

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('first', 'error');
  });
});
