export type EASBranchUpdate = {
  id: string;
  createdAt: string;
  message: string | null;
  runtimeVersion: string;
  platform: string;
};

export type EASBranch = {
  id: string;
  name: string;
  updates: EASBranchUpdate[];
};

export type EASChannel = {
  id: string;
  name: string;
  branchMapping: string;
};

export function isPreviewBuild(): boolean {
  return (
    typeof process.env.EXPO_PUBLIC_EAS_TOKEN === 'string' &&
    process.env.EXPO_PUBLIC_EAS_TOKEN.length > 0 &&
    typeof process.env.EXPO_PUBLIC_EAS_PROJECT_ID === 'string' &&
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID.length > 0
  );
}

export function getEASConfig(): { token: string; projectId: string } {
  if (!isPreviewBuild()) {
    throw new Error('getEASConfig called outside a preview build — EAS env vars are missing');
  }
  return {
    token: process.env.EXPO_PUBLIC_EAS_TOKEN as string,
    projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID as string,
  };
}

const EAS_API_BASE = 'https://api.expo.dev/v2/projects';
const EAS_GRAPHQL_ENDPOINT = 'https://api.expo.dev/graphql';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export type EASPlatform = 'ios' | 'android';

export async function fetchBranches(projectId: string, token: string, platform: EASPlatform): Promise<EASBranch[]> {
  const url = `${EAS_API_BASE}/${projectId}/updates/branches?limit=50`;
  const response = await fetch(url, {
    headers: {
      ...authHeaders(token),
      'expo-platform': platform,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch branches: ${response.statusText}`);
  }

  const json: { data: EASBranch[] } = (await response.json()) as { data: EASBranch[] };
  return json.data;
}

export async function fetchChannels(projectId: string, token: string): Promise<EASChannel[]> {
  const url = `${EAS_API_BASE}/${projectId}/channels`;
  const response = await fetch(url, {
    headers: authHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch channels: ${response.statusText}`);
  }

  const json: { data: EASChannel[] } = (await response.json()) as { data: EASChannel[] };
  return json.data;
}

export async function updateChannelBranchMapping(channelId: string, branchId: string, token: string): Promise<void> {
  const query = `
    mutation UpdateChannel($channelId: ID!, $branchMapping: String!) {
      updateChannel(channelId: $channelId, branchMapping: $branchMapping) {
        id
        name
        branchMapping
      }
    }
  `;

  const branchMapping = JSON.stringify({
    data: [{ branchId, branchMappingLogic: 'true' }],
    version: 0,
  });

  const response = await fetch(EAS_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { channelId, branchMapping },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update channel: ${response.status} ${response.statusText}`);
  }

  type GraphQLResponse = {
    errors?: Array<{ message: string }>;
  };

  const json: GraphQLResponse = (await response.json()) as GraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
}

export function findChannelIdByName(channels: EASChannel[], name: string): string | null {
  if (!name) return null;
  return channels.find((channel) => channel.name === name)?.id ?? null;
}
