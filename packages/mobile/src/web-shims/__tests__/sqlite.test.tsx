// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SQLiteProvider, useSQLiteContext } from '../sqlite';

describe('Expo web SQLite shim', () => {
  it('keeps the provider tree mounted', () => {
    const { getByText } = render(
      <SQLiteProvider>
        <span>content</span>
      </SQLiteProvider>,
    );
    expect(getByText('content')).toBeTruthy();
  });

  it('returns one stable inert database', async () => {
    const first = useSQLiteContext();
    const second = useSQLiteContext();
    expect(first).toBe(second);
    await expect(first.getFirstAsync('SELECT 1')).resolves.toBeNull();
    await expect(first.getAllAsync('SELECT 1')).resolves.toEqual([]);
    await expect(first.runAsync('DELETE FROM climbs')).resolves.toEqual({ lastInsertRowId: 0, changes: 0 });
  });
});
