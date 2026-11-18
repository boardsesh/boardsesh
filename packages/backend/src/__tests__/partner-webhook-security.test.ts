import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';

const { dns, httpsRequest } = vi.hoisted(() => ({ dns: vi.fn(), httpsRequest: vi.fn() }));
vi.mock('../lib/resolve-addresses', () => ({ resolveAddresses: dns }));
vi.mock('node:https', () => ({ request: httpsRequest }));
import { decryptWebhookSecret, encryptWebhookSecret, webhookSignature } from '../services/partner-webhooks/crypto';
import {
  isPublicWebhookAddress,
  parseWebhookUrl,
  postWebhook,
  resolveWebhookTarget,
} from '../services/partner-webhooks/transport';

describe('webhook SSRF and signing boundary', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '172.16.1.1',
    '192.168.1.1',
    '100.100.100.200',
    '0.0.0.0',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2002:7f00:1::1',
    '2001:db8::1',
  ])('refuses reserved address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', (address) =>
    expect(isPublicWebhookAddress(address)).toBe(true),
  );
  it.each([
    'http://example.com/hook',
    'https://example.com:8443/hook',
    'https://user:password@example.com/hook',
    'https://example.com/hook#secret',
  ])('refuses unsafe URL %s', (url) => expect(() => parseWebhookUrl(url)).toThrow());
  it('rejects mixed public/private DNS answers and noncanonical IP encodings', async () => {
    await expect(
      resolveWebhookTarget('https://hooks.example.com', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow();
    await expect(resolveWebhookTarget('https://2130706433/hook')).rejects.toThrow();
    await expect(resolveWebhookTarget('https://0x7f000001/hook')).rejects.toThrow();
  });
  it('pins the checked address, retains TLS hostname validation and never follows redirects', async () => {
    dns
      .mockReset()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    let connectedAddress: string | undefined;
    httpsRequest.mockImplementation(
      (
        options: {
          hostname: string;
          servername: string;
          lookup: (
            hostname: string,
            options: object,
            callback: (error: Error | null, address: string, family: number) => void,
          ) => void;
        },
        response: (reply: { statusCode: number; destroy: () => void }) => void,
      ) => ({
        once: vi.fn(),
        end: () => {
          options.lookup(options.hostname, {}, (_error, address) => {
            connectedAddress = address;
          });
          response({ statusCode: 302, destroy: vi.fn() });
        },
      }),
    );
    expect(await postWebhook('https://hooks.example.com/events', '{}', {})).toBe(302);
    expect(connectedAddress).toBe('8.8.8.8');
    expect(dns).toHaveBeenCalledTimes(1);
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(httpsRequest.mock.calls[0][0]).toMatchObject({
      hostname: 'hooks.example.com',
      servername: 'hooks.example.com',
      autoSelectFamily: false,
    });
  });
  it('encrypts secrets with versioned keys and rejects altered ciphertext', () => {
    const old = { version: 1, value: 'old-webhook-key-with-at-least-thirty-two-bytes' };
    const current = { version: 2, value: 'new-webhook-key-with-at-least-thirty-two-bytes' };
    const sealed = encryptWebhookSecret('secret_shown_once', [old]);
    expect(sealed).not.toContain('secret_shown_once');
    expect(decryptWebhookSecret(sealed, [current, old])).toBe('secret_shown_once');
    expect(() => decryptWebhookSecret(sealed, [current])).toThrow();
    const encoded = sealed.split('.');
    const bytes = Buffer.from(encoded[2], 'base64url');
    bytes[15] ^= 1;
    expect(() => decryptWebhookSecret(`${encoded[0]}.${encoded[1]}.${bytes.toString('base64url')}`, [old])).toThrow();
  });
  it('signs exact bytes with both rotating keys and a shared timestamp', () => {
    const raw = '{ "type": "webhook.test" }';
    const expected = (secret: string) => createHmac('sha256', secret).update(`1234.${raw}`).digest('hex');
    expect(webhookSignature(raw, ['new', 'old'], 1_234_000)).toBe(`t=1234,v1=${expected('new')},v1=${expected('old')}`);
    expect(webhookSignature(raw, ['new'], 1_234_000)).not.toBe(
      webhookSignature(JSON.stringify(JSON.parse(raw)), ['new'], 1_234_000),
    );
  });
});
