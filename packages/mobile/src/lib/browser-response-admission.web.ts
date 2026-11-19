/** A response keeps the check it was admitted with through every body read,
 * clone and stream reader (browser-session-guard.web.ts supplies the session
 * check). Callers still recheck before publishing decoded data after their awaits. */
type CheckDelivery = () => void | Promise<void>;

const responses = new WeakMap<Response, () => void>();
const bodyMethods = new Set<PropertyKey>(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);

export function assertBrowserResponseCurrent(response: Response): void {
  responses.get(response)?.();
}

function guardedReader(reader: object, assertCurrent: () => void, checkDelivery: CheckDelivery): object {
  return new Proxy(reader, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (property !== 'read') return member.bind(target);
      return async (...arguments_: unknown[]) => {
        assertCurrent();
        const result: unknown = await Reflect.apply(member, target, arguments_);
        await checkDelivery();
        assertCurrent();
        return result;
      };
    },
  });
}

function guardedBody(
  body: ReadableStream<Uint8Array>,
  assertCurrent: () => void,
  checkDelivery: CheckDelivery,
): ReadableStream<Uint8Array> {
  return new Proxy(body, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (property === 'getReader')
        return (...arguments_: unknown[]) => {
          assertCurrent();
          return guardedReader(Reflect.apply(member, target, arguments_), assertCurrent, checkDelivery);
        };
      if (property === 'tee')
        return () => {
          assertCurrent();
          return target.tee().map((branch) => guardedBody(branch, assertCurrent, checkDelivery));
        };
      if (property === Symbol.asyncIterator || property === 'values')
        return (...arguments_: unknown[]) => {
          assertCurrent();
          const iterator = Reflect.apply(member, target, arguments_) as AsyncIterator<Uint8Array>;
          return {
            async next() {
              assertCurrent();
              const next = await iterator.next();
              await checkDelivery();
              assertCurrent();
              return next;
            },
            return: iterator.return?.bind(iterator),
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        };
      if (property === 'pipeTo' || property === 'pipeThrough')
        return () => {
          // Existing authenticated consumers use explicit body/reader awaits.
          // A destination with independent queues needs its own owner barrier.
          throw new Error('Response piping requires an explicit owner barrier');
        };
      return member.bind(target);
    },
  });
}

export function admitBrowserResponse(
  response: Response,
  assertCurrent: () => void,
  checkDelivery: CheckDelivery = assertCurrent,
): Response {
  assertCurrent();
  let body: ReadableStream<Uint8Array> | null | undefined;
  const admitted = new Proxy(response, {
    get(target, property) {
      if (property === 'body') {
        assertCurrent();
        if (body === undefined)
          body = target.body === null ? null : guardedBody(target.body, assertCurrent, checkDelivery);
        return body;
      }
      if (property === 'clone')
        return () => {
          assertCurrent();
          return admitBrowserResponse(target.clone(), assertCurrent, checkDelivery);
        };
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (!bodyMethods.has(property)) return member.bind(target);
      return async (...arguments_: unknown[]) => {
        assertCurrent();
        const result: unknown = await Reflect.apply(member, target, arguments_);
        await checkDelivery();
        assertCurrent();
        return result;
      };
    },
  });
  responses.set(admitted, assertCurrent);
  return admitted;
}
