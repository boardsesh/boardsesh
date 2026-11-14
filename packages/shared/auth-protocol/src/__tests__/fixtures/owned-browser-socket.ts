/** Owned in-memory transport for installed graphql-ws browser composition tests. */
export class OwnedSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: OwnedSocket[] = [];
  readyState = OwnedSocket.CONNECTING;
  readonly protocol = 'graphql-transport-ws';
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private closeListener: ((event: Event) => void) | undefined;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    OwnedSocket.instances.push(this);
  }
  set onclose(handler: ((event: CloseEvent) => void) | null) {
    if (this.closeListener) this.removeEventListener('close', this.closeListener);
    this.closeListener = handler ? (event) => handler(event as CloseEvent) : undefined;
    if (this.closeListener) this.addEventListener('close', this.closeListener);
  }
  open() {
    this.readyState = OwnedSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  send(contents: string) {
    const message = JSON.parse(contents) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'connection_init') queueMicrotask(() => this.receive({ type: 'connection_ack' }));
  }
  receive(message: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  close(code = 1000, reason = '') {
    this.readyState = OwnedSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }));
  }
}
