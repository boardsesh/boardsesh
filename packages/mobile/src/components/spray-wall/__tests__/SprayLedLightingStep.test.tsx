// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preview = vi.hoisted(() => ({
  available: true,
  state: 'idle',
  error: null as string | null,
  lightAll: vi.fn(),
  chase: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({ useSprayLedPreview: () => preview }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [0, 4, 8, 12], brandColors: { error: '#900' } }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { SprayLedLightingStep } from '../SprayLedLightingStep';

beforeEach(() => {
  vi.clearAllMocks();
  preview.available = true;
  preview.state = 'idle';
  preview.error = null;
});
afterEach(cleanup);

describe('final lighting test', () => {
  it('offers all LEDs, the ordered row chase, and an always reachable stop', () => {
    render(<SprayLedLightingStep wallUuid="wall" orderedIndices={[7, 2, 9]} />);
    fireEvent.click(screen.getByText('sprayLed.lightAll'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingChase'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingStop'));
    expect(preview.lightAll).toHaveBeenCalledTimes(1);
    expect(preview.chase).toHaveBeenCalledWith([7, 2, 9]);
    expect(preview.stop).toHaveBeenCalledTimes(1);
  });

  it('shows unavailable controllers and physical range errors without hiding controls', () => {
    preview.available = false;
    preview.error = 'invalid-indices';
    render(<SprayLedLightingStep wallUuid="wall" orderedIndices={[]} />);
    expect(screen.getByText('sprayLedSetup.lightingUnavailable')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightingRangeError')).toBeTruthy();
    for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true);
  });
});
