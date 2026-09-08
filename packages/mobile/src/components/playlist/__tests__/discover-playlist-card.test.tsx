// @vitest-environment jsdom
import { createElement } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistCardProps } from '../PlaylistCard';

const cardRender = vi.hoisted(() => vi.fn());
vi.mock('../PlaylistCard', () => ({
  PlaylistCard: (props: PlaylistCardProps) => {
    cardRender(props);
    return createElement(
      'div',
      null,
      createElement('button', { onClick: props.onPress }, props.name),
      props.onTogglePin ? createElement('button', { onClick: props.onTogglePin }, 'pin') : null,
    );
  },
}));
import { DiscoverPlaylistCard, DiscoverSmartPlaylistCard } from '../DiscoverPlaylistCard';

beforeEach(() => cardRender.mockClear());
describe('Discover playlist callback adapters', () => {
  it('does not render unchanged cards when a parent refreshes its objects', () => {
    const onOpen = vi.fn();
    const onPin = vi.fn();
    const props = {
      uuid: 'first',
      name: 'First',
      climbCount: 5,
      variant: 'scroll' as const,
      isPinned: false,
      onOpen,
      onPin,
    };
    const view = render(<DiscoverPlaylistCard {...props} />);
    const initialCalls = cardRender.mock.calls.length;
    view.rerender(<DiscoverPlaylistCard {...{ ...props }} />);
    expect(cardRender).toHaveBeenCalledTimes(initialCalls);
  });
  it('recycled cards call the new identifier and pin state', () => {
    const onOpen = vi.fn();
    const onPin = vi.fn();
    const view = render(
      <DiscoverPlaylistCard
        uuid="first"
        name="First"
        climbCount={1}
        variant="scroll"
        isPinned={false}
        onOpen={onOpen}
        onPin={onPin}
      />,
    );
    view.rerender(
      <DiscoverPlaylistCard
        uuid="second"
        name="Second"
        climbCount={2}
        variant="scroll"
        isPinned
        onOpen={onOpen}
        onPin={onPin}
      />,
    );
    fireEvent.click(view.getByText('Second'));
    fireEvent.click(view.getByText('pin'));
    expect(onOpen).toHaveBeenCalledWith('second');
    expect(onPin).toHaveBeenCalledWith('second', true);
  });
  it('updates changed actions and removes pin interaction after sign-out', () => {
    const oldOpen = vi.fn();
    const newOpen = vi.fn();
    const onPin = vi.fn();
    const view = render(
      <DiscoverPlaylistCard uuid="first" name="First" climbCount={1} variant="scroll" onOpen={oldOpen} onPin={onPin} />,
    );
    view.rerender(<DiscoverPlaylistCard uuid="first" name="First" climbCount={1} variant="scroll" onOpen={newOpen} />);
    fireEvent.click(view.getByText('First'));
    expect(newOpen).toHaveBeenCalledWith('first');
    expect(oldOpen).not.toHaveBeenCalled();
    expect(view.queryByText('pin')).toBeNull();
  });
  it('smart hydration and recycling bind the current smart type', () => {
    const onOpen = vi.fn();
    const onPin = vi.fn();
    const view = render(
      <DiscoverSmartPlaylistCard smartType="LIKED_CLIMBS" name="Liked" climbCount={1} variant="grid" onOpen={onOpen} />,
    );
    expect(view.queryByText('pin')).toBeNull();
    view.rerender(
      <DiscoverSmartPlaylistCard
        smartType="PROJECTS"
        name="Projects"
        climbCount={2}
        variant="grid"
        onOpen={onOpen}
        onPin={onPin}
      />,
    );
    fireEvent.click(view.getByText('Projects'));
    fireEvent.click(view.getByText('pin'));
    expect(onOpen).toHaveBeenCalledWith('PROJECTS');
    expect(onPin).toHaveBeenCalledWith('PROJECTS');
  });
  it('updates translated display text without recreating unchanged action props', () => {
    const onOpen = vi.fn();
    const onPin = vi.fn();
    const view = render(
      <DiscoverSmartPlaylistCard
        smartType="PROJECTS"
        name="Projects"
        climbCount={2}
        variant="grid"
        onOpen={onOpen}
        onPin={onPin}
      />,
    );
    const first = cardRender.mock.lastCall?.[0] as PlaylistCardProps;
    view.rerender(
      <DiscoverSmartPlaylistCard
        smartType="PROJECTS"
        name="Projets"
        climbCount={2}
        variant="grid"
        onOpen={onOpen}
        onPin={onPin}
      />,
    );
    const translated = cardRender.mock.lastCall?.[0] as PlaylistCardProps;
    expect(view.getByText('Projets')).toBeTruthy();
    expect(translated.onPress).toBe(first.onPress);
    expect(translated.onTogglePin).toBe(first.onTogglePin);
  });
});
