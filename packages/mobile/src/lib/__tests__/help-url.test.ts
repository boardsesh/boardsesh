import { describe, expect, it } from 'vitest';
import { buildHelpUrl } from '../help-url';

const BASE = 'https://www.boardsesh.com';

describe('buildHelpUrl', () => {
  it('leaves English unprefixed', () => {
    expect(buildHelpUrl('spray-walls', 'en-US', BASE)).toBe('https://www.boardsesh.com/help/spray-walls');
  });

  it('prefixes the other app languages', () => {
    expect(buildHelpUrl('spray-walls', 'es', BASE)).toBe('https://www.boardsesh.com/es/help/spray-walls');
    expect(buildHelpUrl('spray-walls', 'fr', BASE)).toBe('https://www.boardsesh.com/fr/help/spray-walls');
    expect(buildHelpUrl('spray-walls', 'de', BASE)).toBe('https://www.boardsesh.com/de/help/spray-walls');
  });

  it('falls back to English for a language www does not serve', () => {
    expect(buildHelpUrl('spray-walls', 'pt-BR', BASE)).toBe('https://www.boardsesh.com/help/spray-walls');
    expect(buildHelpUrl('spray-walls', undefined, BASE)).toBe('https://www.boardsesh.com/help/spray-walls');
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildHelpUrl('spray-walls', 'es', 'http://localhost:3000/')).toBe(
      'http://localhost:3000/es/help/spray-walls',
    );
  });
});
