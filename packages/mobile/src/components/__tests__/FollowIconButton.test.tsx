// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' } }),
}));

type IconButtonProps = {
  iconName: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityState: { selected: boolean; disabled: boolean };
  disabled: boolean;
};
vi.mock('../GlassIconButton', () => ({
  GlassIconButton: ({ iconName, onPress, accessibilityLabel, accessibilityState, disabled }: IconButtonProps) =>
    createElement('button', {
      'data-icon': iconName,
      onClick: onPress,
      disabled,
      'aria-label': accessibilityLabel,
      'aria-selected': accessibilityState.selected,
    }),
}));

import { FollowIconButton } from '../FollowIconButton';

describe('FollowIconButton', () => {
  it('offers Follow when the viewer does not follow yet', () => {
    const { getByRole } = render(<FollowIconButton isFollowing={false} onToggle={vi.fn()} />);
    const button = getByRole('button', { name: 'follow.follow' });
    expect(button.getAttribute('data-icon')).toBe('person.badge.plus');
    expect(button.getAttribute('aria-selected')).toBe('false');
  });

  it('reads as selected once followed', () => {
    const { getByRole } = render(<FollowIconButton isFollowing onToggle={vi.fn()} />);
    const button = getByRole('button', { name: 'follow.following' });
    expect(button.getAttribute('data-icon')).toBe('person.check');
    expect(button.getAttribute('aria-selected')).toBe('true');
  });

  it('calls onToggle on a tap', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<FollowIconButton isFollowing={false} onToggle={onToggle} />);
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('ignores taps while disabled', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<FollowIconButton isFollowing={false} onToggle={onToggle} disabled />);
    const button = getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
