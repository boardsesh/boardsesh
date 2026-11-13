import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { checkpoints, digestKey, privateDirectory } from '../private-state';
import { runImportIdentities } from '../../auth-import-identities';
const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});
function folder() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'ba04-pr8-')));
  chmodSync(path, 0o700);
  created.push(path);
  return path;
}
describe('private operator state', () => {
  it('resumes immutable checkpoints and refuses another database/key binding', () => {
    const path = folder();
    const state = checkpoints(path, 'binding');
    expect(state.lastUserId).toBeUndefined();
    state.save('synthetic-private-cursor');
    expect(checkpoints(path, 'binding').lastUserId).toBe('synthetic-private-cursor');
    expect(() => checkpoints(path, 'another')).toThrow();
    state.save('next');
    expect(checkpoints(path, 'binding').lastUserId).toBe('next');
  });
  it('cannot connect or import until activation code gates close', async () => {
    const path = folder();
    const key = join(path, 'key');
    writeFileSync(key, 'ab'.repeat(32), { mode: 0o600 });
    const cursor = join(path, 'checkpoints');
    mkdirSync(cursor, { mode: 0o700 });
    await expect(
      runImportIdentities(['--confirm-host', '127.0.0.1', '--key-file', key, '--checkpoint', cursor], {
        AUTH_OPERATOR_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
        AUTH_IDENTITY_MIRROR: 'on',
      }),
    ).rejects.toThrow('ACTIVATION_CODE_GATES_OPEN');
  });
  it('rejects symlinks, nonprivate permissions, git worktrees, and malformed journals', () => {
    const path = folder();
    const linked = join(path, 'linked');
    symlinkSync(path, linked);
    expect(() => privateDirectory(linked)).toThrow();
    chmodSync(path, 0o755);
    expect(() => privateDirectory(path)).toThrow();
    chmodSync(path, 0o700);
    writeFileSync(join(path, '.git'), 'gitdir: /synthetic');
    const nested = join(path, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    expect(() => privateDirectory(nested)).toThrow();
    const malformed = folder();
    writeFileSync(join(malformed, 'checkpoint-000000000002.json'), '{}', { mode: 0o600 });
    expect(() => checkpoints(malformed, 'binding')).toThrow();
  });
  it('requires owner-only hex key and refuses symlink files', () => {
    const path = folder();
    const key = join(path, 'key');
    writeFileSync(key, 'ab'.repeat(32), { mode: 0o600 });
    expect(digestKey(key)).toHaveLength(32);
    chmodSync(key, 0o644);
    expect(() => digestKey(key)).toThrow();
    chmodSync(key, 0o600);
    const linked = join(path, 'alias');
    symlinkSync(key, linked);
    expect(() => digestKey(linked)).toThrow();
  });
});
