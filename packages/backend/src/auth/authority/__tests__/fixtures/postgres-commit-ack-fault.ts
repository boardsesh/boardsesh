import { createServer, connect, type Socket } from 'node:net';

/** Real PostgreSQL wire fault: drop only the server's COMMIT acknowledgement.
 * Arm AFTER preflight/hash so qualification/read commits are never the target.
 * No SQL/admission/result is manufactured; the real server already committed.
 */
export async function startPostgresTransactionAckFault(
  upstreamUrl: string,
  options: { readonly acknowledgement: 'COMMIT' | 'ROLLBACK'; readonly ordinal: 1 | 2 },
) {
  const target = new URL(upstreamUrl);
  const ci = process.env.GITHUB_ACTIONS === 'true' && target.port === '5432';
  if (
    target.hostname !== '127.0.0.1' ||
    (target.port !== '55483' && !ci) ||
    !/^\/epic6975_identity_import_[0-9a-f]{32}$/.test(target.pathname) ||
    target.username !== 'boardsesh_identity_writer'
  )
    throw new Error('OWNED_COMMIT_FAULT_TARGET_REQUIRED');
  const sockets = new Set<Socket>();
  let armed = false;
  let dropped = false;
  let acknowledgements = 0;
  const server = createServer((client) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(client);
    sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    let buffered: Buffer = Buffer.alloc(0);
    upstream.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const length = buffered.readUInt32BE(1);
        if (length < 4 || length > 1_048_576) {
          client.destroy();
          upstream.destroy();
          return;
        }
        if (buffered.length < length + 1) return;
        const message = buffered.subarray(0, length + 1);
        buffered = buffered.subarray(length + 1);
        if (armed && message[0] === 67 && message.subarray(5).toString('utf8') === `${options.acknowledgement}\0`) {
          acknowledgements += 1;
          if (acknowledgements === options.ordinal) {
            armed = false;
            dropped = true;
            // The real server completed this operation. Hide only its ACK.
            // ROLLBACK TO and outer ROLLBACK both have CommandComplete ROLLBACK;
            // the armed ordinal distinguishes them without fabricating SQL.
            client.destroy();
            upstream.destroy();
            return;
          }
        }
        client.write(message);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OWNED_COMMIT_FAULT_BINDING_REQUIRED');
  return {
    port: address.port,
    arm: () => {
      armed = true;
      acknowledgements = 0;
    },
    dropped: () => dropped,
    acknowledgements: () => acknowledgements,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Existing COMMIT-only proof keeps its exact default behaviour. */
export const startPostgresCommitAckFault = (upstreamUrl: string) =>
  startPostgresTransactionAckFault(upstreamUrl, { acknowledgement: 'COMMIT', ordinal: 1 });
