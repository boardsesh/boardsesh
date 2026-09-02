import { importPKCS8, SignJWT } from 'jose';

const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const WORKFLOW_FILE = 'discord-feedback-issues.yml';
const WORKFLOW_REF = 'main';

type GitHubAppDispatcherConfig = {
  appId: string;
  privateKey: string;
  owner: string;
  repository: string;
};

export type DiscordIssueWorkflowInput = {
  channelId: string;
  triggerMessageId: string;
};

export type GitHubActionsDispatcher = {
  dispatchDiscordIssueWorkflow: (input: DiscordIssueWorkflowInput) => Promise<void>;
};

type InstallationResponse = {
  id?: unknown;
};

type InstallationTokenResponse = {
  token?: unknown;
};

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function readGitHubError(response: Response): Promise<string> {
  const responseText = await response.text();
  return responseText.slice(0, 500) || response.statusText;
}

async function expectGitHubSuccess(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;
  throw new Error(`${operation} failed (${response.status}): ${await readGitHubError(response)}`);
}

async function mintAppJwt(config: GitHubAppDispatcherConfig, now: Date): Promise<string> {
  const privateKey = await importPKCS8(config.privateKey.replaceAll('\\n', '\n'), 'RS256');
  const issuedAtSeconds = Math.floor(now.getTime() / 1000) - 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(config.appId)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + 9 * 60)
    .sign(privateKey);
}

export function createGitHubActionsDispatcher(
  config: GitHubAppDispatcherConfig,
  fetchImplementation: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): GitHubActionsDispatcher {
  const repositoryApiPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;

  return {
    async dispatchDiscordIssueWorkflow(input): Promise<void> {
      const appJwt = await mintAppJwt(config, now());
      const installationResponse = await expectGitHubSuccess(
        await fetchImplementation(`${GITHUB_API_ROOT}${repositoryApiPath}/installation`, {
          headers: githubHeaders(appJwt),
        }),
        'GitHub App installation lookup',
      );
      const installation = (await installationResponse.json()) as InstallationResponse;
      if (typeof installation.id !== 'number' || !Number.isSafeInteger(installation.id)) {
        throw new Error('GitHub App installation lookup returned no numeric installation id');
      }

      const tokenResponse = await expectGitHubSuccess(
        await fetchImplementation(`${GITHUB_API_ROOT}/app/installations/${installation.id}/access_tokens`, {
          method: 'POST',
          headers: { ...githubHeaders(appJwt), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repositories: [config.repository],
            permissions: { actions: 'write' },
          }),
        }),
        'GitHub App installation-token creation',
      );
      const installationToken = (await tokenResponse.json()) as InstallationTokenResponse;
      if (typeof installationToken.token !== 'string' || installationToken.token.length === 0) {
        throw new Error('GitHub App installation-token creation returned no token');
      }

      await expectGitHubSuccess(
        await fetchImplementation(
          `${GITHUB_API_ROOT}${repositoryApiPath}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
          {
            method: 'POST',
            headers: { ...githubHeaders(installationToken.token), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ref: WORKFLOW_REF,
              inputs: {
                channel_id: input.channelId,
                trigger_message_id: input.triggerMessageId,
              },
            }),
          },
        ),
        'Discord issue workflow dispatch',
      );
    },
  };
}

export function createGitHubActionsDispatcherFromEnvironment(): GitHubActionsDispatcher {
  const appId = process.env.DISCORD_GITHUB_APP_ID?.trim();
  const privateKey = process.env.DISCORD_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) {
    throw new Error('DISCORD_GITHUB_APP_ID and DISCORD_GITHUB_APP_PRIVATE_KEY are required');
  }
  if (!/^\d+$/.test(appId)) throw new Error('DISCORD_GITHUB_APP_ID must be numeric');

  return createGitHubActionsDispatcher({
    appId,
    privateKey,
    owner: 'boardsesh',
    repository: 'boardsesh',
  });
}
