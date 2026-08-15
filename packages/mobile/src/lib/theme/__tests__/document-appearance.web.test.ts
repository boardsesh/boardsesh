// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { syncDocumentAppearance } from '../document-appearance.web';

describe('syncDocumentAppearance on web', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('takes over the dark startup shell and follows later light hydration', () => {
    syncDocumentAppearance('dark', '#15101E');

    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(21, 16, 30)');
    expect(document.body.style.backgroundColor).toBe('rgb(21, 16, 30)');
    expect(document.getElementById('root')?.style.backgroundColor).toBe('rgb(21, 16, 30)');

    syncDocumentAppearance('light', '#F3EFFA');

    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(243, 239, 250)');
    expect(document.body.style.backgroundColor).toBe('rgb(243, 239, 250)');
    expect(document.getElementById('root')?.style.backgroundColor).toBe('rgb(243, 239, 250)');
  });
});
