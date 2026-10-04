// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const launch = vi.hoisted(() => ({ released: false }));
const stack = vi.hoisted(() => ({ screenOptions: [] as unknown[] }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: unknown }) => {
      stack.screenOptions.push(options);
      return null;
    },
  },
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', null, 'spinner'),
}));
vi.mock('../../../lib/launch-hold', () => ({
  useLaunchHoldReleased: () => launch.released,
}));

import { holdUntilLaunchReady } from '../hold-until-launch-ready';

function JoinScreen({ sessionId }: { sessionId: string }) {
  return createElement('button', null, `Join ${sessionId}`);
}

beforeEach(() => {
  launch.released = false;
  stack.screenOptions = [];
});

describe('holdUntilLaunchReady', () => {
  it('shows a spinner, and none of the screen, while launch is still deciding', () => {
    const Held = holdUntilLaunchReady(JoinScreen);
    render(createElement(Held, { sessionId: 'abc' }));

    expect(screen.getByText('spinner')).toBeTruthy();
    expect(screen.queryByText('Join abc')).toBeNull();
    // A headerless route gets no header options from the hold.
    expect(stack.screenOptions).toEqual([]);
  });

  it('renders the screen with its props once launch is ready', () => {
    launch.released = true;
    const Held = holdUntilLaunchReady(JoinScreen);
    render(createElement(Held, { sessionId: 'abc' }));

    expect(screen.getByText('Join abc')).toBeTruthy();
    expect(screen.queryByText('spinner')).toBeNull();
  });

  it('gives a route with a visible header an empty title while held, not its raw route name', () => {
    const Held = holdUntilLaunchReady(JoinScreen, { header: 'visible' });
    render(createElement(Held, { sessionId: 'abc' }));

    expect(stack.screenOptions).toEqual([{ title: '' }]);
  });

  it('leaves the header to the screen once released', () => {
    launch.released = true;
    const Held = holdUntilLaunchReady(JoinScreen, { header: 'visible' });
    render(createElement(Held, { sessionId: 'abc' }));

    expect(stack.screenOptions).toEqual([]);
  });

  it('names the wrapper after the screen it holds', () => {
    expect(holdUntilLaunchReady(JoinScreen).displayName).toBe('HoldUntilLaunchReady(JoinScreen)');
  });
});
