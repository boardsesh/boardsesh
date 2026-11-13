import { beforeEach, expect, it, vi } from 'vite-plus/test';
import { prepareOwnedDatabase } from '../database';
import { openRuntimePostgres } from '../isolated-runtime';
import { createRehearsalSecrets } from '../target-guard';
vi.mock('../isolated-runtime', () => ({ openRuntimePostgres: vi.fn() }));
let marker = '';
let tampered = false;
const client = vi.fn(async (template: TemplateStringsArray, ...parameters: unknown[]) => {
  const statement = template.join('');
  if (statement.includes('INSERT INTO auth_rehearsal_marker')) {
    if (typeof parameters[0] !== 'string') throw new Error('MARKER_STRING_REQUIRED');
    marker = parameters[0];
  }
  if (statement.includes('SELECT proof')) return [{ proof: tampered ? '0'.repeat(64) : marker }];
  return [];
});
const clientUnsafe = vi.fn(async () => []);
const end = vi.fn(async () => {});
const admin = Object.assign(
  vi.fn(async () => []),
  { unsafe: vi.fn(async () => []), end },
);
const ownedClient = Object.assign(client, { unsafe: clientUnsafe, end });
function fixture() {
  const revalidate = vi.fn(async () => {});
  const target = Object.freeze({
    runNonce: 'a'.repeat(32),
    networkNamespace: 'net:[12345]',
    secrets: createRehearsalSecrets(),
    revalidate,
  });
  return { target, revalidate };
}
beforeEach(() => {
  vi.clearAllMocks();
  marker = '';
  tampered = false;
  vi.mocked(openRuntimePostgres).mockImplementation(
    (_target, phase) =>
      (phase === 'admin-create' ? admin : ownedClient) as unknown as ReturnType<typeof openRuntimePostgres>,
  );
});
it('binds database marker to this run and refuses a replaced proof', async () => {
  const { target } = fixture();
  const database = await prepareOwnedDatabase(target);
  expect(vi.mocked(openRuntimePostgres).mock.calls.map(([, phase]) => phase)).toEqual([
    'admin-create',
    'owned-database',
  ]);
  await expect(database.assertMarker()).resolves.toBeUndefined();
  tampered = true;
  await expect(database.assertMarker()).rejects.toThrow('OWNED_DATABASE_MARKER_REQUIRED');
});
it('revalidates the runtime before either construction or marker SQL', async () => {
  const { target, revalidate } = fixture();
  const database = await prepareOwnedDatabase(target);
  revalidate.mockRejectedValueOnce(new Error('RUNTIME_CHANGED'));
  client.mockClear();
  await expect(database.assertMarker()).rejects.toThrow('RUNTIME_CHANGED');
  expect(client).not.toHaveBeenCalled();
  revalidate.mockRejectedValueOnce(new Error('RUNTIME_CHANGED'));
  vi.mocked(openRuntimePostgres).mockClear();
  await expect(prepareOwnedDatabase(target)).rejects.toThrow('RUNTIME_CHANGED');
  expect(openRuntimePostgres).not.toHaveBeenCalled();
});
