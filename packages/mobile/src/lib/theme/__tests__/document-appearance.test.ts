import { describe, expect, it } from 'vitest';
import { syncDocumentAppearance } from '../document-appearance';

describe('syncDocumentAppearance on native', () => {
  it('is safe without a browser document', () => {
    expect(() => syncDocumentAppearance('dark', '#15101E')).not.toThrow();
  });
});
