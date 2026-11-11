// A fake WLED controller for testing spray-wall LEDs without hardware.
//
//   vp run dev:wled-sim                    # 300 LEDs on port 8080
//   vp run dev:wled-sim -- --leds 120 --port 8090
//
// In the app, enter the address it prints (http://<this PC's IP>:<port>) as the
// WLED URL. Every command the app sends is drawn as a strip of coloured blocks,
// with the indices of the lit LEDs, so wiring and mapping mistakes show up here.
// The phone must be on the same network; on Windows, allow Node.js on private
// networks when the firewall asks.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import {
  applyWledCommand,
  createWledSimulatorState,
  litIndices,
  nightlightRemaining,
  renderStrip,
  tickNightlight,
  wledInfo,
  wledState,
} from './lib/wled-simulator-state';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    port: { type: 'string', default: '8080' },
    leds: { type: 'string', default: '300' },
    row: { type: 'string', default: '50' },
    name: { type: 'string', default: 'Boardsesh WLED simulator' },
    verbose: { type: 'boolean', default: false },
  },
});
const port = Number(values.port);
const perRow = Number(values.row);
const state = createWledSimulatorState(Number(values.leds), values.name);

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // WLED's own JSON buffer is far smaller; refuse anything absurd.
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function describe(changes: string[]) {
  const lit = litIndices(state);
  const remaining = nightlightRemaining(state, Date.now());
  const summary = [
    state.on ? `ON  bri ${state.bri}/255` : 'OFF',
    `${lit.length} lit`,
    remaining >= 0 ? `auto-off in ${Math.ceil(remaining / 60)} min` : null,
    changes.length ? `(${changes.join(', ')})` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const shown = lit.length > 40 ? `${lit.slice(0, 40).join(', ')} … +${lit.length - 40}` : lit.join(', ');
  console.log(`\n[${new Date().toLocaleTimeString()}] ${summary}`);
  if (lit.length) console.log(`lit: ${shown}`);
  // `vp run` pipes our output, so isTTY is unreliable; honour NO_COLOR instead.
  console.log(renderStrip(state, perRow, !process.env.NO_COLOR));
}

const server = createServer((request, response) => {
  void (async () => {
    const path = (request.url ?? '/').split('?')[0].replace(/\/+$/u, '');
    try {
      if (request.method === 'GET' && (path === '/json/info' || path === '/json/si' || path === '/json')) {
        const body =
          path === '/json/info' ? wledInfo(state) : { state: wledState(state, Date.now()), info: wledInfo(state) };
        return send(response, 200, body);
      }
      if (request.method === 'GET' && path === '/json/state') return send(response, 200, wledState(state, Date.now()));
      if (request.method === 'POST' && (path === '/json/state' || path === '/json')) {
        const raw = await readBody(request);
        const command: unknown = JSON.parse(raw);
        if (values.verbose) console.log(`POST ${path} ${raw}`);
        const changes = applyWledCommand(state, command, Date.now());
        send(response, 200, { success: true });
        return describe(changes);
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      console.error(`Rejected ${request.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      send(response, 400, { error: 9 });
    }
  })();
});

setInterval(() => {
  if (tickNightlight(state, Date.now())) describe(['auto-off timer ran out']);
}, 1000);

server.listen(port, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    // Skip loopback and 169.254.x.x (no DHCP lease): a phone can't reach either.
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
    .map((entry) => `http://${entry?.address}:${port}`);
  console.log(`Fake WLED "${state.name}" with ${state.ledCount} LEDs is listening.`);
  console.log(
    `Enter one of these as the WLED URL in the app:\n  ${addresses.join('\n  ') || `http://localhost:${port}`}`,
  );
  console.log('Press Ctrl+C to stop.');
});
