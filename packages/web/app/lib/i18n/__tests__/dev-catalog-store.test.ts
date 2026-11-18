// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDevCatalog, saveDevTranslation } from '../dev-catalog-store';

let directory: string;
const edit = (key: string, previous: string, replacement: string) => ({
  locale: 'en-US',
  namespace: 'common',
  key,
  previous,
  replacement,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boardsesh-translations-'));
  await mkdir(join(directory, 'en-US'));
  await writeFile(
    join(directory, 'en-US', 'common.json'),
    JSON.stringify(
      { greeting: 'Hello {{name}}', actions: { save: 'Save', close: 'Close' }, messages: ['First', 'Second'] },
      null,
      2,
    ) + '\n',
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('dev catalog writes', () => {
  it('retains unrelated values when concurrent saves target one file', async () => {
    await Promise.all([
      saveDevTranslation(edit('actions.save', 'Save', 'Save now'), directory),
      saveDevTranslation(edit('actions.close', 'Close', 'Close window'), directory),
    ]);
    expect(await readDevCatalog('en-US', 'common', directory)).toEqual({
      greeting: 'Hello {{name}}',
      actions: { save: 'Save now', close: 'Close window' },
      messages: ['First', 'Second'],
    });
    expect(await readdir(join(directory, 'en-US'))).toEqual(['common.json']);
  });

  it('rejects a stale same-key save without discarding the first edit', async () => {
    const outcomes = await Promise.allSettled([
      saveDevTranslation(edit('actions.save', 'Save', 'Save now'), directory),
      saveDevTranslation(edit('actions.save', 'Save', 'Save later'), directory),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    await expect(saveDevTranslation(edit('actions.save', 'Save', 'Again'), directory)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('supports existing string array entries', async () => {
    await saveDevTranslation(edit('messages.1', 'Second', 'Next'), directory);
    expect(await readDevCatalog('en-US', 'common', directory)).toMatchObject({ messages: ['First', 'Next'] });
  });

  it.each([
    edit('__proto__.injected', '', 'bad'),
    edit('actions.constructor', '', 'bad'),
    edit('missing', '', 'bad'),
    edit('actions', '', 'bad'),
    { ...edit('actions.save', 'Save', 'bad'), locale: '../../..' },
    { ...edit('actions.save', 'Save', 'bad'), namespace: '../common' },
    edit('greeting', 'Hello {{name}}', 'Hello'),
  ])('rejects invalid paths and formatting without modifying the catalog', async (input) => {
    const before = await readFile(join(directory, 'en-US', 'common.json'), 'utf8');
    await expect(saveDevTranslation(input, directory)).rejects.toBeDefined();
    expect(await readFile(join(directory, 'en-US', 'common.json'), 'utf8')).toBe(before);
  });
});
