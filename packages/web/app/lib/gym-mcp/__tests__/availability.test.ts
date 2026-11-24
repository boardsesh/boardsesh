// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const { isGymMcpAvailable } = await import('../availability.server');

afterEach(() => vi.unstubAllGlobals());

describe('gym MCP availability', () => {
  it.each([
    [{ enabled: true }, true],
    [{ enabled: false }, false],
    [{ enabled: 'true' }, false],
    [{}, false],
    [null, false],
  ])('only shows the entry for an explicit enabled response: %j', async (status, expected) => {
    const request = vi.fn(async () => Response.json(status));
    vi.stubGlobal('fetch', request);
    expect(await isGymMcpAvailable()).toBe(expected);
    expect(request).toHaveBeenCalledWith('https://api.boardsesh.com/mcp/gyms/status', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });

  it('keeps gym management available when the backend probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    expect(await isGymMcpAvailable()).toBe(false);
  });

  it('refuses enabled-looking error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ enabled: true }, { status: 503 })),
    );
    expect(await isGymMcpAvailable()).toBe(false);
  });
});
