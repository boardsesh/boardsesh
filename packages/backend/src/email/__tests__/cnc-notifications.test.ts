import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { createTransportMock, createConnectionMock, sendMailMock, closeMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  createConnectionMock: vi.fn(),
  sendMailMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));
vi.mock('node:net', async (original) => ({
  ...(await original<typeof import('node:net')>()),
  createConnection: createConnectionMock,
}));

type SocketCallback = (error: Error | null, result?: { connection: Socket }) => void;
type NotificationTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
  getSocket?: (options: unknown, callback: SocketCallback) => void;
};

class FakeSocket extends EventEmitter {
  destroy = vi.fn((_error?: Error) => {
    this.emit('close');
    return this;
  });
}

const mail = { to: 'buyer@example.com', from: 'boardsesh@example.com', subject: 'Your pack', text: 'Ready' };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('SMTP_USER', 'cnc-notification-test');
  vi.stubEnv('SMTP_PASSWORD', 'test-only-password');
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_PORT', '465');
  vi.stubEnv('SMTP_SECURE', '');
  createTransportMock.mockReset().mockReturnValue({ sendMail: sendMailMock, close: closeMock });
  createConnectionMock.mockReset();
  sendMailMock.mockReset().mockResolvedValue({});
  closeMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function transportOptions(): NotificationTransportOptions {
  return createTransportMock.mock.calls[0][0] as NotificationTransportOptions;
}

describe('bounded backend CNC notifications', () => {
  it.each([
    ['465', true],
    ['587', false],
  ] as const)('preserves TLS mode on port %s and leaves default mail unchanged', async (port, secure) => {
    vi.stubEnv('SMTP_PORT', port);
    const { getTransporter, sendBoundedCncNotification } = await import('../email-service');
    getTransporter();
    expect(transportOptions()).toMatchObject({ host: 'smtp.example.test', port: Number(port), secure });
    expect(transportOptions()).not.toHaveProperty('socketTimeout');
    await sendBoundedCncNotification(mail);
    expect(createTransportMock.mock.calls[1][0]).toMatchObject({
      host: 'smtp.example.test',
      port: Number(port),
      secure,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('destroys its own connected socket at the total deadline without waiting for SMTP', async () => {
    const socket = new FakeSocket();
    createConnectionMock.mockReturnValue(socket);
    const supplied = vi.fn();
    sendMailMock.mockImplementation(() => {
      transportOptions().getSocket?.({}, supplied);
      socket.emit('connect');
      return new Promise(() => {});
    });
    const { sendBoundedCncNotification } = await import('../email-service');
    const sent = sendBoundedCncNotification(mail);
    const rejection = expect(sent).rejects.toThrow('CNC_NOTIFICATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(supplied).toHaveBeenCalledWith(null, { connection: socket });
    expect(socket.destroy).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a late socket request after timeout without opening a connection', async () => {
    sendMailMock.mockImplementation(() => new Promise(() => {}));
    const { sendBoundedCncNotification } = await import('../email-service');
    const sent = sendBoundedCncNotification(mail);
    const rejection = expect(sent).rejects.toThrow('CNC_NOTIFICATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    const supplied = vi.fn();
    transportOptions().getSocket?.({}, supplied);
    expect(supplied.mock.calls[0][0]).toMatchObject({ message: 'CNC_NOTIFICATION_TIMEOUT' });
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('bounds the supplied raw TCP connection before Nodemailer starts its handshake', async () => {
    const socket = new FakeSocket();
    createConnectionMock.mockReturnValue(socket);
    const supplied = vi.fn();
    sendMailMock.mockImplementation(() => {
      transportOptions().getSocket?.({}, supplied);
      return new Promise(() => {});
    });
    const { sendBoundedCncNotification } = await import('../email-service');
    const sent = sendBoundedCncNotification(mail);
    const rejection = expect(sent).rejects.toThrow('CNC_NOTIFICATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.destroy).toHaveBeenCalled();
    expect(supplied.mock.calls[0][0]).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a failed-send receipt instead of allowing the notifier to stamp delivery', async () => {
    sendMailMock.mockRejectedValue(new Error('SMTP_UNAVAILABLE'));
    const { sendCncPackReadyEmail, sendCncPackFailedAdminEmail } = await import('../cnc-emails');
    expect(
      await sendCncPackReadyEmail(
        {
          to: 'buyer@example.com',
          licenseeName: 'Buyer',
          licenceId: 'BS-CNC-TEST',
          boardLabel: 'Homewall',
          orderUrl: 'https://www.boardsesh.com/build-plans/orders/BS-CNC-TEST',
        },
        { bounded: true },
      ),
    ).toBe(false);
    expect(
      await sendCncPackFailedAdminEmail(
        {
          licenceId: 'BS-CNC-TEST',
          orderId: 1,
          boardLabel: 'Homewall',
          licenseeEmail: 'buyer@example.com',
          attempts: 3,
          lastError: 'GENERATION_FAILED',
        },
        { bounded: true },
      ),
    ).toBe(false);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });
});
