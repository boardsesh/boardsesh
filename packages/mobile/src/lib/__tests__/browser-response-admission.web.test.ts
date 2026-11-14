import { describe, expect, it } from 'vitest';
import { admitBrowserResponse, assertBrowserResponseCurrent } from '../browser-response-admission.web';

function fixture() {
  let current = true;
  const assert = () => {
    if (!current) throw new Error('original request retired');
  };
  return { assert, retire: () => (current = false) };
}
function heldBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(created) {
          controller = created;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
    finish() {
      controller.enqueue(new TextEncoder().encode('{"private":"owned A"}'));
      controller.close();
    },
  };
}

describe('selected Expo response original-receipt admission', () => {
  it('keeps ordinary Response metadata and a current decoded body', async () => {
    const scope = fixture();
    const response = admitBrowserResponse(Response.json({ private: 'owned A' }, { status: 201 }), scope.assert);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ private: 'owned A' });
    expect(() => assertBrowserResponseCurrent(response)).not.toThrow();
  });
  it('discards delayed JSON after account retirement before the body completes', async () => {
    const scope = fixture();
    const held = heldBody();
    const response = admitBrowserResponse(held.response, scope.assert);
    const pending = response.json();
    scope.retire();
    held.finish();
    await expect(pending).rejects.toThrow('original request retired');
  });
  it('does not lend a fresh same-owner receipt to an older body', async () => {
    const old = fixture();
    const held = heldBody();
    const first = admitBrowserResponse(held.response, old.assert);
    const pending = first.text();
    old.retire();
    const current = fixture();
    const second = admitBrowserResponse(Response.json({ private: 'new lease' }), current.assert);
    expect(await second.json()).toEqual({ private: 'new lease' });
    held.finish();
    await expect(pending).rejects.toThrow('original request retired');
  });
  it('requires another synchronous check after the callers own await', async () => {
    const scope = fixture();
    const response = admitBrowserResponse(Response.json({ private: 'owned A' }), scope.assert);
    await response.json();
    scope.retire();
    expect(() => assertBrowserResponseCurrent(response)).toThrow('original request retired');
  });
  it('keeps clones bound to the original receipt before and after decoding', async () => {
    const scope = fixture();
    const response = admitBrowserResponse(Response.json({ private: 'owned A' }), scope.assert);
    const clone = response.clone();
    expect(await clone.text()).toContain('owned A');
    scope.retire();
    await expect(response.json()).rejects.toThrow('original request retired');
    expect(() => assertBrowserResponseCurrent(clone)).toThrow('original request retired');
    expect(() => response.clone()).toThrow('original request retired');
  });
  it.each(['arrayBuffer', 'blob', 'text'] as const)('guards delayed %s completion', async (method) => {
    const scope = fixture();
    const held = heldBody();
    const response = admitBrowserResponse(held.response, scope.assert);
    const pending = response[method]();
    scope.retire();
    held.finish();
    await expect(pending).rejects.toThrow('original request retired');
  });
  it('guards actual streaming reader delivery after its own await', async () => {
    const scope = fixture();
    const held = heldBody();
    const reader = admitBrowserResponse(held.response, scope.assert).body!.getReader();
    const pending = reader.read();
    scope.retire();
    held.finish();
    await expect(pending).rejects.toThrow('original request retired');
    await expect(reader.read()).rejects.toThrow('original request retired');
    reader.releaseLock();
  });
  it('keeps both tee branches guarded and refuses unqualified pipe destinations', async () => {
    const scope = fixture();
    const response = admitBrowserResponse(Response.json({ private: 'owned A' }), scope.assert);
    const [first, second] = response.body!.tee();
    expect(() => first.pipeTo(new WritableStream())).toThrow('explicit owner barrier');
    scope.retire();
    expect(() => second.getReader()).toThrow('original request retired');
  });
  it('does not claim ordinary legacy responses have a selected receipt', () => {
    expect(() => assertBrowserResponseCurrent(Response.json({ public: true }))).not.toThrow();
  });
});
