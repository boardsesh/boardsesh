import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findChannelIdByName,
  fetchBranches,
  fetchChannels,
  updateChannelBranchMapping,
  type EASChannel,
} from '../eas-api';

describe('findChannelIdByName', () => {
  const channels: EASChannel[] = [
    { id: 'ch1', name: 'preview-1', branchMapping: '{}' },
    { id: 'ch2', name: 'preview-2', branchMapping: '{}' },
    { id: 'ch3', name: 'production', branchMapping: '{}' },
  ];

  it('returns the id of the matching channel by name', () => {
    expect(findChannelIdByName(channels, 'preview-2')).toBe('ch2');
    expect(findChannelIdByName(channels, 'production')).toBe('ch3');
  });

  it('returns null when no channel matches the name', () => {
    expect(findChannelIdByName(channels, 'preview-99')).toBeNull();
  });

  it('returns null when name is empty', () => {
    expect(findChannelIdByName(channels, '')).toBeNull();
  });

  it('returns null when the channel list is empty', () => {
    expect(findChannelIdByName([], 'preview-1')).toBeNull();
  });
});

describe('fetchBranches', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the data array on success and forwards the platform header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'b1', name: 'main', updates: [] }] }),
    } as Response);

    const result = await fetchBranches('proj-1', 'token-x', 'ios');

    expect(result).toEqual([{ id: 'b1', name: 'main', updates: [] }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.expo.dev/v2/projects/proj-1/updates/branches?limit=50',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-x',
          'expo-platform': 'ios',
        }),
      }),
    );
  });

  it('sends expo-platform: android when called with android', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);
    globalThis.fetch = fetchMock;

    await fetchBranches('proj-1', 'token-x', 'android');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'expo-platform': 'android' }),
      }),
    );
  });

  it('throws when the response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Unauthorized',
    } as Response);

    await expect(fetchBranches('proj-1', 'bad-token', 'ios')).rejects.toThrow('Unauthorized');
  });
});

describe('fetchChannels', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the data array on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'ch1', name: 'preview-1', branchMapping: '{}' }] }),
    } as Response);

    const result = await fetchChannels('proj-1', 'token-x');

    expect(result).toEqual([{ id: 'ch1', name: 'preview-1', branchMapping: '{}' }]);
  });

  it('throws when the response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Forbidden',
    } as Response);

    await expect(fetchChannels('proj-1', 'bad-token')).rejects.toThrow('Forbidden');
  });
});

describe('updateChannelBranchMapping', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts a GraphQL mutation with the correct payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { updateChannel: { id: 'ch1' } } }),
    } as Response);
    globalThis.fetch = fetchMock;

    await updateChannelBranchMapping('ch1', 'branch-42', 'token-x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.expo.dev/graphql');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      variables: { channelId: string; branchMapping: string };
    };
    expect(body.variables.channelId).toBe('ch1');
    expect(JSON.parse(body.variables.branchMapping)).toEqual({
      data: [{ branchId: 'branch-42', branchMappingLogic: 'true' }],
      version: 0,
    });
  });

  it('throws on HTTP error before attempting to parse the body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => {
        throw new Error('json should not be called');
      },
    } as unknown as Response);

    await expect(updateChannelBranchMapping('ch1', 'b1', 'token-x')).rejects.toThrow(/500.*Internal Server Error/);
  });

  it('throws when GraphQL returns errors despite 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'Channel not found' }] }),
    } as Response);

    await expect(updateChannelBranchMapping('ch1', 'b1', 'token-x')).rejects.toThrow(
      'GraphQL error: Channel not found',
    );
  });
});
