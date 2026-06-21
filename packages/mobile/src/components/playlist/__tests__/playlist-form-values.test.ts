import { describe, it, expect } from 'vitest';
import { buildPlaylistFormValues } from '../playlist-form-values';

const base = { name: 'My Playlist', description: '', color: undefined, icon: undefined, isPublic: false };

describe('buildPlaylistFormValues', () => {
  it('rejects an empty / whitespace name', () => {
    expect(buildPlaylistFormValues('create', { ...base, name: '   ' })).toEqual({ ok: false, error: 'name-required' });
  });

  it('rejects a name over 100 chars', () => {
    expect(buildPlaylistFormValues('create', { ...base, name: 'a'.repeat(101) })).toEqual({
      ok: false,
      error: 'name-too-long',
    });
  });

  it('rejects a description over 500 chars', () => {
    expect(buildPlaylistFormValues('edit', { ...base, name: 'P', description: 'a'.repeat(501) })).toEqual({
      ok: false,
      error: 'description-too-long',
    });
  });

  it('trims the name and description', () => {
    const result = buildPlaylistFormValues('create', { ...base, name: '  P  ', description: '  hi  ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.name).toBe('P');
      expect(result.values.description).toBe('hi');
    }
  });

  it('create omits empty description/colour/icon', () => {
    const result = buildPlaylistFormValues('create', {
      name: 'P',
      description: '',
      color: undefined,
      icon: undefined,
      isPublic: false,
    });
    expect(result).toEqual({
      ok: true,
      values: { name: 'P', description: undefined, color: undefined, icon: undefined },
    });
  });

  it('create keeps a chosen colour + emoji', () => {
    const result = buildPlaylistFormValues('create', {
      name: 'P',
      description: 'd',
      color: '#AABBCC',
      icon: '🔥',
      isPublic: false,
    });
    expect(result).toEqual({ ok: true, values: { name: 'P', description: 'd', color: '#AABBCC', icon: '🔥' } });
  });

  it("edit sends '' for cleared description/colour/icon (the clear signal)", () => {
    const result = buildPlaylistFormValues('edit', {
      name: 'P',
      description: '',
      color: undefined,
      icon: undefined,
      isPublic: true,
    });
    expect(result).toEqual({ ok: true, values: { name: 'P', description: '', color: '', icon: '', isPublic: true } });
  });

  it('edit keeps real values + isPublic', () => {
    const result = buildPlaylistFormValues('edit', {
      name: 'P',
      description: 'd',
      color: '#112233',
      icon: '⭐',
      isPublic: false,
    });
    expect(result).toEqual({
      ok: true,
      values: { name: 'P', description: 'd', color: '#112233', icon: '⭐', isPublic: false },
    });
  });
});
