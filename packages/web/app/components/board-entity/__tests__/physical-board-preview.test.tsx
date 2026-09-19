import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';
import type { BoardProps } from '@/app/components/board-renderer/board-renderer';
import PhysicalBoardPreview from '../physical-board-preview';

const renderBoard = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/board-renderer/board-renderer', () => ({
  default: (props: BoardProps) => {
    renderBoard(props);
    return <div data-testid="catalogue-art" />;
  },
}));

describe('PhysicalBoardPreview', () => {
  it('shows the actual catalogue board unlit without a verified selected climb', () => {
    render(<PhysicalBoardPreview board={discoveryBoard()} label="Northside board preview" />);
    expect(screen.getByTestId('catalogue-art')).toBeTruthy();
    expect(renderBoard).toHaveBeenLastCalledWith(expect.objectContaining({ litUpHoldsMap: undefined }));
  });

  it('lights only the holds supplied by the selected climb snapshot', () => {
    render(
      <PhysicalBoardPreview
        board={discoveryBoard({
          currentClimb: { uuid: 'climb-one', name: 'Night shift', frames: 'p100r42p200r43', angle: 35 },
        })}
        label="Northside board preview"
      />,
    );
    const props = renderBoard.mock.lastCall?.[0] as BoardProps;
    expect(Object.keys(props.litUpHoldsMap ?? {})).toEqual(['100', '200']);
  });

  it('uses the genuine MoonBoard renderer inputs rather than substituting Kilter art', () => {
    render(
      <PhysicalBoardPreview
        board={discoveryBoard({
          boardType: 'moonboard',
          layoutId: 1,
          sizeId: 1,
          setIds: '1',
        })}
        label="MoonBoard preview"
      />,
    );
    const props = renderBoard.mock.lastCall?.[0] as BoardProps;
    expect(props.boardDetails.board_name).toBe('moonboard');
    expect(props.boardDetails.layoutFolder).toBeTruthy();
  });

  it('keeps unsupported artwork honest with a text fallback', () => {
    render(<PhysicalBoardPreview board={discoveryBoard({ boardType: 'future-board' })} label="New board preview" />);
    expect(screen.getByRole('img', { name: 'New board preview' })).toBeTruthy();
    expect(screen.queryByTestId('catalogue-art')).toBeNull();
  });
});
