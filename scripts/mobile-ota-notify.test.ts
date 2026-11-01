import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyCommand } from './mobile-ota-notify';
import { emptyDeploymentOutbox, parseDeploymentOutbox, queueDeploymentEvent } from './lib/ota-deployment-events';
import { initialStableState, parseStableState } from './lib/ota-stable';

const temporaryPaths: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function eventPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'ota-notify-test-'));
  temporaryPaths.push(root);
  return join(root, 'events.json');
}
describe('trusted deployment notification CLI', () => {
  it('retains a failed delivery and suppresses a later attempt to record its delivered event', async () => {
    const path = eventPath();
    const environment = { GITHUB_REPOSITORY: 'boardsesh/boardsesh', GITHUB_RUN_ID: '123' };
    const record = [
      'record',
      '--events',
      path,
      '--kind',
      'candidate-frozen',
      '--branch',
      'main',
      '--commit',
      'a'.repeat(40),
      '--platform',
      'ios',
      '--runtime',
      'b'.repeat(40),
      '--key',
      'main-ios-123',
    ];
    await notifyCommand(record, environment);
    await expect(notifyCommand(['deliver', '--events', path], environment)).rejects.toThrow('remain pending');
    expect(parseDeploymentOutbox(JSON.parse(readFileSync(path, 'utf8')) as unknown).pending).toHaveLength(1);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await notifyCommand(['deliver', '--events', path], {
      ...environment,
      DISCORD_DEPLOY_WEBHOOK: 'https://discord.test/webhook',
    });
    await notifyCommand(record, environment);
    expect(parseDeploymentOutbox(JSON.parse(readFileSync(path, 'utf8')) as unknown)).toMatchObject({
      pending: [],
      sent: [expect.any(String)],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('updates only notification receipts while preserving the stable checkpoint producer', async () => {
    const path = eventPath();
    const notifications = emptyDeploymentOutbox();
    queueDeploymentEvent(notifications, { kind: 'qa-passed', branch: 'production' }, 'qa-pass');
    writeFileSync(path, JSON.stringify({ ...initialStableState(), checkpointRunId: '101', notifications }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    await notifyCommand(['deliver', '--state', path], { DISCORD_DEPLOY_WEBHOOK: 'https://discord.test/webhook' });
    const restored = parseStableState(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    expect(restored.checkpointRunId).toBe('101');
    expect(restored.notifications?.pending).toEqual([]);
    expect(restored.notifications?.sent).toHaveLength(1);
  });
});
