import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { adbPath, resolveAndroidHome } from '../lib/android-sdk';

export type Family = 'kilter' | 'tension' | 'moonboard';
export type Role = 'ios' | 'android';
export type Led = { position: number; r: number; g: number; b: number };
export type Phone = {
  id: string;
  appId: string;
  scheme: string;
  email: string;
  wdaUrl?: string;
  runnerBundleId?: string;
};
export type ClimbFixture = string | { name: string; uuid: string };
export type QaConfig = {
  schemaVersion: 1;
  backendUrl: string;
  serialPort: string;
  adb: string;
  phones: Record<Role, Phone>;
  credentialsFile: string;
  boards: Array<{ family: Family; slug: string; serial: string; climbs: ClimbFixture[] }>;
};
export type CatalogClimb = { uuid: string; name: string; frames: string; commands: Led[]; packetBytes: number };
export type Board = QaConfig['boards'][number] & {
  uuid: string;
  boardId: number;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  catalog: CatalogClimb[];
};

export function record(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Expected an object');
  return candidate as Record<string, unknown>;
}
export function string(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Expected nonempty text');
  return candidate;
}
export function loadConfig(filename: string): QaConfig {
  const candidate = record(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported QA configuration version');
  const endpoint = new URL(string(candidate.backendUrl));
  if (
    endpoint.origin !== 'https://ws.boardsesh.com' ||
    endpoint.pathname !== '/graphql' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('This suite is scoped to the production QA gym backend');
  const phones = record(candidate.phones);
  const parsePhone = (role: Role): Phone => {
    const phone = record(phones[role]);
    const parsed: Phone = {
      id: string(phone.id),
      appId: string(phone.appId),
      scheme: string(phone.scheme),
      email: string(phone.email),
    };
    if (role === 'ios') {
      parsed.wdaUrl = string(phone.wdaUrl);
      const origin = new URL(parsed.wdaUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
        origin.protocol !== 'http:' ||
        origin.username ||
        origin.password
      )
        throw new Error('Use a loopback USB-forwarded WDA endpoint');
      parsed.runnerBundleId = string(phone.runnerBundleId);
    }
    return parsed;
  };
  const parsedPhones = { ios: parsePhone('ios'), android: parsePhone('android') };
  if (parsedPhones.ios.id === parsedPhones.android.id || parsedPhones.ios.email === parsedPhones.android.email)
    throw new Error('Two distinct phones and accounts are required');
  if (!Array.isArray(candidate.boards) || candidate.boards.length !== 3)
    throw new Error('All three QA boards are required');
  const boards = candidate.boards.map((entry) => {
    const board = record(entry);
    const family = string(board.family);
    if (!['kilter', 'tension', 'moonboard'].includes(family) || !Array.isArray(board.climbs) || board.climbs.length < 3)
      throw new Error('Each QA board needs three named static climbs');
    const slug = string(board.slug);
    if (!slug.startsWith('boardsesh-qa-')) throw new Error('Only named Boardsesh QA fixture boards may be driven');
    return {
      family: family as Family,
      slug,
      serial: string(board.serial),
      climbs: board.climbs.map((entry): ClimbFixture => {
        if (typeof entry === 'string') return string(entry);
        const climb = record(entry);
        return { name: string(climb.name), uuid: string(climb.uuid) };
      }),
    };
  });
  if (new Set(boards.map((board) => board.family)).size !== 3) throw new Error('Missing QA board family');
  return {
    schemaVersion: 1,
    backendUrl: endpoint.href,
    serialPort: string(candidate.serialPort),
    adb: string(candidate.adb),
    phones: parsedPhones,
    credentialsFile: resolve(string(candidate.credentialsFile)),
    boards,
  };
}

export function loadPasswords(filename: string, emails: string[]): Record<string, string> {
  const metadata = statSync(filename);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error('Credentials must be an owner-only regular file (chmod 600)');
  const credentials = record(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
  return Object.fromEntries(emails.map((email) => [email, string(credentials[email])]));
}

export const EXAMPLE_CONFIG: QaConfig = {
  schemaVersion: 1,
  backendUrl: 'https://ws.boardsesh.com/graphql',
  serialPort: '/dev/cu.usbmodemXXXX',
  adb: adbPath(resolveAndroidHome()),
  phones: {
    ios: {
      id: 'YOUR_IPHONE_UDID',
      appId: 'com.boardsesh.app',
      scheme: 'com.boardsesh.app',
      email: 'test@boardsesh.com',
      wdaUrl: 'http://127.0.0.1:8211',
      runnerBundleId: 'com.boardsesh.boardqa.runner.xctrunner',
    },
    android: {
      id: 'YOUR_ANDROID_SERIAL',
      appId: 'com.boardsesh.app.dev',
      scheme: 'com.boardsesh.app',
      email: 'test2@boardsesh.com',
    },
  },
  credentialsFile: '.boardsesh/board-qa.credentials.json',
  boards: [
    {
      family: 'kilter',
      slug: 'boardsesh-qa-kilter-homewall-full',
      serial: '99000001',
      climbs: [
        { name: 'Moon Landing', uuid: '2657B92D24E541098E27963FFE5B5B0C' },
        { name: 'Angel Eyes', uuid: '9CD48F5E74D04A22AFF6371135790345' },
        { name: 'Half Mast', uuid: 'EBF35B35CF384C53840F4B39EC6D3FBE' },
      ],
    },
    {
      family: 'tension',
      slug: 'boardsesh-qa-tension-2-mirror',
      serial: '99000002',
      climbs: [
        { name: 'Putty', uuid: 'BA608169C0114B8ABB0AD7E7BA0D27C1' },
        { name: 'Propagation', uuid: '823A103296DA449C90C4B865B5031629' },
        { name: 'Compliments To The Climber', uuid: 'D6B81C3306C74A308E795CFCBADB78DB' },
      ],
    },
    {
      family: 'moonboard',
      slug: 'boardsesh-qa-moonboard-2024',
      serial: '99000003',
      climbs: [
        { name: 'FUNNY THING', uuid: '483c1234-b9c4-5570-b871-7ddc37ed534d' },
        { name: 'DUNES', uuid: 'fcda5dce-4493-5b9a-8d88-43fe0ba86a86' },
        { name: 'MOON GIRL', uuid: '62f43f16-9ac8-59d7-8803-794268fec151' },
      ],
    },
  ],
};
