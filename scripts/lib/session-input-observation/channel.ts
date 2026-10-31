import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  INPUT_TRACE_BOOLEANS,
  INPUT_TRACE_STAGES,
  INPUT_TRACE_STRINGS,
  type InputTrace,
  type InputTraceCounters,
  type InputTracePacket,
} from '../../../packages/mobile/src/lib/native-input-transport';
const id = (input: unknown): input is string => typeof input === 'string' && /^[\w.:+-]{1,120}$/.test(input);
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('trace_transport_unverified');
  return input as Record<string, unknown>;
}
export function parseInputTracePacket(input: unknown): InputTracePacket {
  const packet = object(input);
  if (!id(packet.runtimeId) || !Array.isArray(packet.events) || packet.events.length < 1 || packet.events.length > 4)
    throw Error('trace_transport_unverified');
  if (Object.keys(packet).some((key) => !['runtimeId', 'events', 'counters'].includes(key)))
    throw Error('trace_transport_unverified');
  const counters = object(packet.counters);
  if (
    Object.keys(counters).sort().join(',') !== 'dropped,errors,queueDepth,sourceSequence' ||
    Object.values(counters).some((count) => !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 10000)
  )
    throw Error('trace_transport_unverified');
  const events = packet.events.map((inputEvent) => {
    const event = object(inputEvent);
    for (const [key, content] of Object.entries(event)) {
      if ((INPUT_TRACE_STRINGS as readonly string[]).includes(key)) {
        if (!id(content)) throw Error('trace_transport_unverified');
      } else if ((INPUT_TRACE_BOOLEANS as readonly string[]).includes(key)) {
        if (typeof content !== 'boolean') throw Error('trace_transport_unverified');
      } else if (key === 'sourceSequence') {
        if (!Number.isSafeInteger(content) || Number(content) < 1 || Number(content) > 512)
          throw Error('trace_transport_unverified');
      } else throw Error('trace_transport_unverified');
    }
    if (
      event.runtimeId !== packet.runtimeId ||
      !INPUT_TRACE_STAGES.includes(event.stage as (typeof INPUT_TRACE_STAGES)[number]) ||
      typeof event.sourceSequence !== 'number'
    )
      throw Error('trace_transport_unverified');
    return event as InputTrace;
  });
  if (
    Number(counters.sourceSequence) > 512 ||
    Number(counters.queueDepth) > 128 ||
    Number(counters.sourceSequence) < Math.max(...events.map((event) => Number(event.sourceSequence))) ||
    (counters.queueDepth === 0 &&
      Number(counters.sourceSequence) !== Math.max(...events.map((event) => Number(event.sourceSequence))))
  )
    throw Error('trace_transport_unverified');
  return { runtimeId: packet.runtimeId, events, counters: counters as InputTraceCounters };
}
export type InputBaseline = { runtimeId: string; parentId: string; switchRowId: string; sourceSequence: number };
export async function startInputObservationChannel() {
  const retired = new Set<string>(),
    readyRuntimes = new Set<string>();
  const traces = new Map<string, Map<number, InputTrace>>();
  const latestCounters = new Map<string, InputTraceCounters>();
  const acknowledgements = new Map<string, { runtimeId: string; counters: InputTraceCounters }>();
  let runtimeId: string | undefined,
    challengeId: string | undefined,
    rejected = 0,
    staleReady = 0,
    foreignPackets = 0,
    latePackets = 0,
    totalEvents = 0,
    sealed = false;
  let frozen: InputBaseline | undefined;
  let windowClosed = false,
    lateApplicationEvents = 0;
  const events = () =>
    [...(traces.get(runtimeId ?? '')?.values() ?? [])].sort(
      (first, second) => Number(first.sourceSequence) - Number(second.sourceSequence),
    );
  function healthy(ack: { runtimeId: string; counters: InputTraceCounters } | undefined) {
    if (
      !ack ||
      ack.runtimeId !== runtimeId ||
      rejected ||
      ack.counters.queueDepth ||
      ack.counters.dropped ||
      ack.counters.errors
    )
      return false;
    const latest = latestCounters.get(ack.runtimeId);
    if (latest?.dropped || latest?.errors) return false;
    const list = events().filter((event) => Number(event.sourceSequence) <= ack.counters.sourceSequence);
    return (
      list.length === ack.counters.sourceSequence && list.every((event, index) => event.sourceSequence === index + 1)
    );
  }
  function baseline(): InputBaseline {
    if (!runtimeId) throw Error('trace_transport_unverified');
    const list = events();
    const active = (mount: string, unmount: string) => {
      const instances = new Map<string, InputTrace>();
      for (const event of list)
        if (typeof event.componentId === 'string') {
          if (event.stage === mount) instances.set(event.componentId, event);
          if (event.stage === unmount) instances.delete(event.componentId);
        }
      return [...instances.values()];
    };
    const parents = active('pre-session-mounted', 'pre-session-unmounted');
    if (parents.length !== 1) throw Error('trace_transport_unverified');
    const parentId = String(parents[0].componentId);
    const parentCommit = list
      .filter((event) => event.stage === 'pre-session-state-committed' && event.componentId === parentId)
      .at(-1);
    const rows = active('switch-row-mounted', 'switch-row-unmounted').filter(
      (event) => event.semanticRole === 'session-visibility' && event.parentId === parentId,
    );
    if (rows.length !== 1 || parentCommit?.isPublic !== true || parentCommit.isStartPending !== false)
      throw Error('trace_transport_unverified');
    const switchRowId = String(rows[0].componentId);
    const row = list
      .filter((event) => event.stage === 'switch-row-props-committed' && event.componentId === switchRowId)
      .at(-1);
    if (
      row?.value !== true ||
      row.disabled !== false ||
      row.parentId !== parentId ||
      row.semanticRole !== 'session-visibility'
    )
      throw Error('trace_transport_unverified');
    return { runtimeId, parentId, switchRowId, sourceSequence: Number(list.at(-1)?.sourceSequence ?? 0) };
  }
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/ready') {
      const incoming = url.searchParams.get('runtimeId');
      if (!id(incoming)) {
        rejected++;
        response.writeHead(400);
        response.end('{}');
        return;
      }
      if (retired.has(incoming) || (runtimeId && runtimeId !== incoming)) {
        staleReady++;
        response.writeHead(409);
        response.end('{}');
        return;
      }
      runtimeId = incoming;
      readyRuntimes.add(incoming);
      response.end('{}');
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/trace') {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    let body = '',
      oversize = false;
    const timeout = setTimeout(() => {
      rejected++;
      request.destroy();
    }, 2000);
    request.once('close', () => clearTimeout(timeout));
    request.on('data', (chunk: Buffer) => {
      if (oversize) return;
      if (Buffer.byteLength(body) + chunk.length > 8192) {
        oversize = true;
        rejected++;
        response.writeHead(413);
        response.end('{}');
        request.resume();
      } else body += chunk;
    });
    request.on('error', () => {
      clearTimeout(timeout);
      rejected++;
    });
    request.on('end', () => {
      clearTimeout(timeout);
      if (oversize) return;
      try {
        const packet = parseInputTracePacket(JSON.parse(body));
        if (sealed) {
          latePackets++;
          response.writeHead(409);
          response.end('{}');
          return;
        }
        if (retired.has(packet.runtimeId) || (runtimeId && packet.runtimeId !== runtimeId)) {
          foreignPackets++;
          response.writeHead(409);
          response.end('{}');
          return;
        }
        const runtimeEvents = traces.get(packet.runtimeId) ?? new Map<number, InputTrace>();
        if (windowClosed)
          lateApplicationEvents += packet.events.filter(
            (event) => !['diagnostic-heartbeat', 'trace-window-ack'].includes(String(event.stage)),
          ).length;
        for (const event of packet.events) {
          const sequence = Number(event.sourceSequence);
          const previous = runtimeEvents.get(sequence);
          if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw Error('trace_transport_unverified');
          if (!previous) {
            if (++totalEvents > 512) throw Error('trace_transport_unverified');
            runtimeEvents.set(sequence, event);
          }
        }
        traces.set(packet.runtimeId, runtimeEvents);
        const priorCounters = latestCounters.get(packet.runtimeId);
        latestCounters.set(packet.runtimeId, {
          ...(!priorCounters || packet.counters.sourceSequence >= priorCounters.sourceSequence
            ? packet.counters
            : priorCounters),
          errors: Math.max(packet.counters.errors, priorCounters?.errors ?? 0),
          dropped: Math.max(packet.counters.dropped, priorCounters?.dropped ?? 0),
        });
        for (const event of packet.events)
          if (event.stage === 'trace-window-ack' && event.challengeId === challengeId)
            acknowledgements.set(String(event.challengeId), {
              runtimeId: packet.runtimeId,
              counters: { ...packet.counters },
            });
        response.end(JSON.stringify({ challengeId }));
      } catch {
        rejected++;
        response.writeHead(400);
        response.end('{}');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    readinessUrl: origin + '/ready',
    traceUrl: origin + '/trace',
    beginLaunch() {
      for (const known of readyRuntimes) retired.add(known);
      for (const known of traces.keys()) retired.add(known);
      runtimeId = undefined;
      frozen = undefined;
      challengeId = undefined;
      sealed = false;
      windowClosed = false;
      lateApplicationEvents = 0;
    },
    homeReady() {
      return runtimeId !== undefined;
    },
    baseline,
    requestAcknowledgement(challenge: string) {
      if (!id(challenge)) throw Error('invalid_ack_challenge');
      challengeId = challenge;
    },
    closeWindow(challenge: string) {
      if (!id(challenge)) throw Error('invalid_ack_challenge');
      windowClosed = true;
      challengeId = challenge;
    },
    acknowledged(challenge: string) {
      return healthy(acknowledgements.get(challenge));
    },
    freezeBaseline(challenge: string) {
      if (!healthy(acknowledgements.get(challenge))) throw Error('trace_transport_unverified');
      const current = baseline();
      if (
        frozen &&
        (current.runtimeId !== frozen.runtimeId ||
          current.parentId !== frozen.parentId ||
          current.switchRowId !== frozen.switchRowId)
      )
        throw Error('trace_transport_unverified');
      frozen = current;
      return { ...current };
    },
    finishWindow(challenge: string) {
      if (!frozen || !windowClosed || lateApplicationEvents || !healthy(acknowledgements.get(challenge)))
        throw Error('trace_transport_unverified');
      const list = events().filter((event) => Number(event.sourceSequence) > frozen!.sourceSequence);
      const targetChanged = list.some(
        (event) =>
          (event.stage === 'pre-session-unmounted' && event.componentId === frozen!.parentId) ||
          (event.stage === 'switch-row-unmounted' && event.componentId === frozen!.switchRowId) ||
          (event.stage === 'switch-row-mounted' && event.semanticRole === 'session-visibility'),
      );
      if (targetChanged) throw Error('trace_transport_unverified');
      sealed = true;
      return list;
    },
    allTraces() {
      return [...traces.values()].flatMap((runtimeEvents) => [...runtimeEvents.values()]);
    },
    snapshot() {
      return {
        runtimeId,
        frozen,
        traceCount: events().length,
        rejected,
        staleReady,
        foreignPackets,
        latePackets,
        totalEvents,
        lateApplicationEvents,
        counters: latestCounters.get(runtimeId ?? ''),
        acknowledgements: [...acknowledgements].map(([challengeId, ack]) => ({ challengeId, ...ack })),
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
