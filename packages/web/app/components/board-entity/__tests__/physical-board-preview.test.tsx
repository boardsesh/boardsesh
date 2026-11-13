import React from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';
import PhysicalBoardPreview from '../physical-board-preview';

const LABEL = 'Northside board preview';

function previewImage(): HTMLImageElement {
  const image = screen.getByRole('img', { name: LABEL }).querySelector('img');
  if (!image) throw new Error('Expected a backend-rendered board image');
  return image;
}

function imageParameters(): URLSearchParams {
  return new URL(previewImage().getAttribute('src') ?? '', 'https://www.boardsesh.com').searchParams;
}

describe('PhysicalBoardPreview', () => {
  it('requests the real bare board from the backend without SVG hold coordinates', () => {
    const { container } = render(<PhysicalBoardPreview board={discoveryBoard()} label={LABEL} />);
    const parameters = imageParameters();
    expect(parameters.get('board_name')).toBe('kilter');
    expect(parameters.get('frames')).toBe('');
    expect(parameters.get('include_background')).toBe('1');
    expect(parameters.get('thumbnail')).toBe('1');
    expect(parameters.get('v')).toBe(BOARD_RENDER_VERSION);
    expect(parameters.has('color_scheme')).toBe(false);
    expect(previewImage().getAttribute('loading')).toBe('lazy');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.innerHTML).not.toContain('holdsData');
  });

  it('sends only flattened selected-climb frames in the image URL', () => {
    render(
      <PhysicalBoardPreview
        board={discoveryBoard({
          currentClimb: { uuid: 'climb-one', name: 'Night shift', frames: 'p100r42,p200r43', angle: 35 },
        })}
        label={LABEL}
      />,
    );
    const frames = imageParameters().get('frames');
    expect(frames).toContain('p100r42');
    expect(frames).toContain('p200r43');
    expect(frames).not.toContain(',');
  });

  it('requests genuine MoonBoard art rather than substituting a different board', () => {
    render(
      <PhysicalBoardPreview
        board={discoveryBoard({ boardType: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1' })}
        label={LABEL}
      />,
    );
    expect(imageParameters().get('board_name')).toBe('moonboard');
    expect(imageParameters().get('layout_id')).toBe('1');
    expect(imageParameters().get('set_ids')).toBe('1');
  });

  it('keeps Woods artwork dark in the website preview', () => {
    render(
      <PhysicalBoardPreview
        board={discoveryBoard({ boardType: 'woods', layoutId: 1, sizeId: 1, setIds: '1' })}
        label={LABEL}
      />,
    );
    expect(imageParameters().get('board_name')).toBe('woods');
    expect(imageParameters().get('color_scheme')).toBe('dark');
  });

  it.each([{ boardType: 'future-board' }, { layoutId: 99999, sizeId: 99999 }])(
    'keeps unsupported artwork honest with a named fallback: %j',
    (overrides) => {
      render(<PhysicalBoardPreview board={discoveryBoard(overrides)} label={LABEL} />);
      expect(screen.getByRole('img', { name: LABEL }).querySelector('img')).toBeNull();
    },
  );

  it('falls back on image failure and shows a new image when the climb changes', () => {
    const { rerender } = render(<PhysicalBoardPreview board={discoveryBoard()} label={LABEL} />);
    fireEvent.error(previewImage());
    expect(screen.getByRole('img', { name: LABEL }).querySelector('img')).toBeNull();
    expect(screen.getByText('Kilter')).toBeTruthy();

    rerender(
      <PhysicalBoardPreview
        board={discoveryBoard({
          currentClimb: { uuid: 'climb-two', name: 'Fresh beta', frames: 'p300r42', angle: 40 },
        })}
        label={LABEL}
      />,
    );
    expect(imageParameters().get('frames')).toBe('p300r42');
  });
});
