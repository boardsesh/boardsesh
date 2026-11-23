// @vitest-environment node
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vite-plus/test';
import { NodeNextResponse } from 'next/dist/server/base-http/node';

const requireFromTest = createRequire(import.meta.url);
type CloseResponse = Pick<NodeNextResponse, 'onClose'>;
const minimalServer = requireFromTest('next/dist/compiled/next-server/server.runtime.prod') as {
  default: { prototype: { normalizeRes(response: ServerResponse): CloseResponse } };
};

// Exercise both installed server implementations. The minimal production
// bundle embeds its own response class instead of importing base-http/node.
const implementations: Array<[string, (response: ServerResponse) => CloseResponse]> = [
  ['NodeNextResponse', (response) => new NodeNextResponse(response)],
  ['minimal production server', (response) => minimalServer.default.prototype.normalizeRes(response)],
];

function createResponse(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

describe.each(implementations)('%s close lifecycle', (_name, wrapResponse) => {
  it('runs callbacks in registration order on close and releases them afterward', () => {
    const response = createResponse();
    const wrapper = wrapResponse(response);
    const events: string[] = [];
    const finish = vi.fn();
    response.on('finish', finish);
    wrapper.onClose(() => events.push('first'));
    wrapper.onClose(() => events.push('second'));

    response.emit('finish');
    expect(events).toEqual([]);
    expect(finish).toHaveBeenCalledOnce();

    response.emit('close');
    expect(events).toEqual(['first', 'second']);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listeners('finish')).toEqual([finish]);
  });

  it('calls each callback once with the original response as its receiver', () => {
    const response = createResponse();
    const callback = vi.fn(function (this: ServerResponse) {
      expect(this).toBe(response);
    });
    wrapResponse(response).onClose(callback);

    response.emit('close');
    response.emit('close');

    expect(callback).toHaveBeenCalledOnce();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('removes a throwing callback before propagating its error', () => {
    const response = createResponse();
    const failure = new Error('close callback failed');
    wrapResponse(response).onClose(() => {
      throw failure;
    });

    expect(() => response.emit('close')).toThrow(failure);
    expect(response.listenerCount('close')).toBe(0);
  });
});
