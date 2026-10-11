import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

/** One persistent graphql-transport-ws connection: session context belongs to this socket. */
export class CrewParticipant {
  private socket: WebSocket;
  private pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private ready: Promise<void>;
  constructor(backend: URL, jwt: string) {
    this.socket = new WebSocket(new URL('/graphql', backend).href.replace(/^http/, 'ws'), 'graphql-transport-ws');
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Crew WebSocket handshake timed out')), 15_000);
      this.socket.once('open', () =>
        this.socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: jwt } })),
      );
      this.socket.on('message', (payload) => {
        const message = JSON.parse(
          (Buffer.isBuffer(payload)
            ? payload
            : Array.isArray(payload)
              ? Buffer.concat(payload)
              : Buffer.from(payload)
          ).toString('utf8'),
        ) as {
          type: string;
          id?: string;
          payload?: { data?: unknown; errors?: { message: string }[] };
        };
        if (message.type === 'connection_ack') {
          clearTimeout(timer);
          resolveReady();
        }
        if (message.type === 'ping') this.socket.send(JSON.stringify({ type: 'pong' }));
        const pending = message.id ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        if (message.type === 'next' || message.type === 'error') {
          clearTimeout(pending.timer);
          this.pending.delete(message.id!);
          if (message.type === 'error' || message.payload?.errors?.length)
            pending.reject(new Error(JSON.stringify(message.payload)));
          else pending.resolve(message.payload?.data);
        }
      });
      this.socket.on('error', (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      this.socket.on('close', () => {
        clearTimeout(timer);
        rejectReady(new Error('Crew WebSocket closed'));
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Crew connection closed'));
        }
        this.pending.clear();
      });
    });
  }
  async execute(query: string, variables: object): Promise<unknown> {
    await this.ready;
    return new Promise((resolveResult, rejectResult) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error('Crew GraphQL operation timed out'));
      }, 20_000);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
      this.socket.send(JSON.stringify({ id, type: 'subscribe', payload: { query, variables } }));
    });
  }
  close(): void {
    this.socket.close();
  }
}
