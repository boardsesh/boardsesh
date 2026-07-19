import { describe, expect, it } from 'vitest';
import { syncDocumentLanguage } from '../document-language';

describe('syncDocumentLanguage on native', () => {
  it('is safe without a browser document', () => {
    expect(() => syncDocumentLanguage('fr')).not.toThrow();
  });
});
