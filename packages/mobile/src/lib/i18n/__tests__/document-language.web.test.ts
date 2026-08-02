// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { syncDocumentLanguage } from '../document-language.web';

describe('syncDocumentLanguage on web', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en-US';
  });

  it.each(['es', 'fr', 'de', 'en-US'] as const)('sets the document language to %s', (language) => {
    syncDocumentLanguage(language);

    expect(document.documentElement.lang).toBe(language);
  });
});
