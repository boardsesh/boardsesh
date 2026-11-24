import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ClimbBoardStageOrientation } from '../climb-board-stage-orientation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: () => 'Mirrored' }),
}));

const stage = (
  <ClimbBoardStageOrientation aspectRatio="1">
    <img src="/board-art.webp" alt="Climb holds" />
  </ClimbBoardStageOrientation>
);

function changeFragment(fragment: string) {
  window.history.replaceState({}, '', `/${fragment}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

afterEach(() => window.history.replaceState({}, '', '/'));

describe('named LED climb mirror fragment', () => {
  it('keeps original first-render art and only flips the painted layers for the exact fragment', () => {
    changeFragment('#mirrored');
    const firstHtml = renderToString(stage);
    expect(firstHtml).toContain('/board-art.webp');
    expect(firstHtml).not.toContain('data-mirrored');
    expect(firstHtml).not.toContain('Mirrored');

    render(stage);
    const image = screen.getByRole('img', { name: 'Climb holds' });
    expect(image.parentElement?.getAttribute('data-mirrored')).toBe('true');
    expect(screen.getByText('Mirrored')).toBeTruthy();
    act(() => changeFragment('#beta'));
    expect(image.parentElement?.getAttribute('data-mirrored')).toBeNull();
    expect(screen.queryByText('Mirrored')).toBeNull();
    expect(image.getAttribute('src')).toBe('/board-art.webp');
  });
});
