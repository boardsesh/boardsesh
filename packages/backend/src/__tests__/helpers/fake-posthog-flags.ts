import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PARTNER_DEVELOPER_CONSOLE_FLAG } from '@boardsesh/auth-protocol/partner-oauth';

/**
 * A stand-in for PostHog's `/flags` endpoint on 127.0.0.1, so a real server in
 * a test asks the `developer-console` question over HTTP, the way production
 * does, and gets "yes" for exactly the accounts the test invites. Point the
 * backend at it with `environment`. Like the backend's contract, it answers 400
 * unless the request pins the `distinct_id` person property to the distinct id.
 */
export interface FakePosthogFlags {
  /** `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST` for the deployment under test. */
  environment: { POSTHOG_PROJECT_KEY: string; POSTHOG_HOST: string };
  invite(...userIds: string[]): void;
  uninvite(...userIds: string[]): void;
  /** While on, every flag request answers 503, as PostHog does in an outage. */
  setOutage(on: boolean): void;
  /** How many flag requests named this account, or all of them without one. */
  asked(userId?: string): number;
  close(): Promise<void>;
}

const PROJECT_KEY = 'phc_fake_posthog_for_tests';

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakePosthogFlags(): Promise<FakePosthogFlags> {
  const invited = new Set<string>();
  const requests = new Map<string, number>();
  let outage = false;
  const server = createServer((incoming, outgoing) => {
    void readBody(incoming).then((text) => {
      let distinctId = '';
      let token = '';
      let pinnedId: unknown;
      try {
        const parsed = JSON.parse(text) as {
          distinct_id?: unknown;
          token?: unknown;
          person_properties?: { distinct_id?: unknown };
        };
        distinctId = typeof parsed.distinct_id === 'string' ? parsed.distinct_id : '';
        token = typeof parsed.token === 'string' ? parsed.token : '';
        pinnedId = parsed.person_properties?.distinct_id;
      } catch {
        // Answered 400 below.
      }
      if (
        incoming.method !== 'POST' ||
        !incoming.url?.startsWith('/flags/') ||
        !distinctId ||
        pinnedId !== distinctId ||
        token !== PROJECT_KEY
      ) {
        outgoing.writeHead(400).end();
        return;
      }
      requests.set(distinctId, (requests.get(distinctId) ?? 0) + 1);
      if (outage) {
        outgoing.writeHead(503).end();
        return;
      }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          flags: {
            [PARTNER_DEVELOPER_CONSOLE_FLAG]: { key: PARTNER_DEVELOPER_CONSOLE_FLAG, enabled: invited.has(distinctId) },
          },
          errorsWhileComputingFlags: false,
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    environment: { POSTHOG_PROJECT_KEY: PROJECT_KEY, POSTHOG_HOST: `http://127.0.0.1:${port}` },
    invite: (...userIds) => {
      for (const userId of userIds) invited.add(userId);
    },
    uninvite: (...userIds) => {
      for (const userId of userIds) invited.delete(userId);
    },
    setOutage: (on) => {
      outage = on;
    },
    asked: (userId) =>
      userId === undefined
        ? [...requests.values()].reduce((total, count) => total + count, 0)
        : (requests.get(userId) ?? 0),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch keeps its connections alive; close would wait for them to idle out.
        server.closeAllConnections();
      }),
  };
}
