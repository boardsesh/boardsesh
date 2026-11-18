import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';

/**
 * The run's mail server under `better-auth`: an SMTPS listener on 127.0.0.1
 * with the run's certificate, which www's shared mailer (`@boardsesh/email`,
 * `secure: true`) trusts through NODE_EXTRA_CA_CERTS. It accepts mail only
 * after AUTH PLAIN with this run's user and password, delivers nothing
 * anywhere, and keeps each message in memory for the control server
 * (`GET /mail?to=`). Only the emailed first-password link needs it
 * (acceptance-4-first-password.spec.ts): the link is a credential, so the
 * spec reads it here and nowhere else, and nothing in the product is changed
 * for the run.
 *
 * Just enough SMTP (RFC 5321) for nodemailer: EHLO, AUTH PLAIN, MAIL, RCPT,
 * DATA with dot-unstuffing, RSET, NOOP, QUIT.
 */

export interface CapturedMail {
  readonly recipients: readonly string[];
  /** The message as sent, quoted-printable soft breaks and escapes decoded. */
  readonly text: string;
}

export interface MailSink {
  readonly server: Server;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly messages: CapturedMail[];
  /** Stops listening and ends every open connection. */
  close(): Promise<void>;
}

const HOST_NAME = 'mail.boardsesh.test';

/** Undoes quoted-printable: soft line breaks, then `=XX` escapes. Plain 7-bit text passes through. */
export function decodeQuotedPrintable(raw: string): string {
  const joined = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const escape = joined.slice(index + 1, index + 3);
    if (joined[index] === '=' && /^[0-9A-F]{2}$/.test(escape)) {
      bytes.push(Number.parseInt(escape, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(joined[index], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function addressIn(command: string): string {
  return /<([^>]*)>/.exec(command)?.[1]?.toLowerCase() ?? '';
}

export async function startMailSink(
  certificate: { key: Buffer; cert: Buffer },
  credentials: { user: string; password: string },
): Promise<MailSink> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<TLSSocket>();
  const expectedPlain = Buffer.from(`\0${credentials.user}\0${credentials.password}`).toString('base64');
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffered = '';
    let authenticated = false;
    let awaitingPlain = false;
    let recipients: string[] = [];
    let data: string[] | undefined;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    const handle = (line: string) => {
      if (data) {
        if (line === '.') {
          messages.push({ recipients, text: decodeQuotedPrintable(data.join('\r\n')) });
          data = undefined;
          recipients = [];
          reply('250 2.0.0 kept');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        return;
      }
      if (awaitingPlain) {
        awaitingPlain = false;
        authenticated = line === expectedPlain;
        reply(authenticated ? '235 2.7.0 ok' : '535 5.7.8 refused');
        return;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') {
        reply(`250-${HOST_NAME}`);
        reply('250-AUTH PLAIN');
        reply('250 8BITMIME');
      } else if (verb === 'HELO') reply(`250 ${HOST_NAME}`);
      else if (/^AUTH PLAIN$/i.test(line)) {
        awaitingPlain = true;
        reply('334 ');
      } else if (/^AUTH PLAIN /i.test(line)) {
        authenticated = line.slice('AUTH PLAIN '.length) === expectedPlain;
        reply(authenticated ? '235 2.7.0 ok' : '535 5.7.8 refused');
      } else if (!authenticated && ['MAIL', 'RCPT', 'DATA'].includes(verb)) reply('530 5.7.0 authenticate first');
      else if (verb === 'MAIL') {
        recipients = [];
        reply('250 2.1.0 ok');
      } else if (verb === 'RCPT') {
        recipients.push(addressIn(line));
        reply('250 2.1.5 ok');
      } else if (verb === 'DATA') {
        data = [];
        reply('354 end with .');
      } else if (verb === 'RSET') {
        recipients = [];
        reply('250 2.0.0 ok');
      } else if (verb === 'NOOP') reply('250 2.0.0 ok');
      else if (verb === 'QUIT') {
        reply('221 2.0.0 bye');
        socket.end();
      } else reply('502 5.5.1 not implemented');
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let end = buffered.indexOf('\r\n');
      while (end !== -1) {
        handle(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf('\r\n');
      }
    });
    socket.on('error', () => socket.destroy());
    reply(`220 ${HOST_NAME} ESMTP`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      for (const socket of sockets) socket.destroy();
    });
  return { server, port: (server.address() as AddressInfo).port, ...credentials, messages, close };
}
