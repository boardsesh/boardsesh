/** The selected request keeps its ORIGINAL lease receipt through every body
 * read. A later same-owner renewal cannot extend an earlier response. Callers
 * still recheck immediately before publishing decoded data after their awaits. */
const responses = new WeakMap<Response, () => void>();
const bodyMethods = new Set<PropertyKey>(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);

/** Capture once before a derived value escapes its original response. */
export function captureBrowserResponseCurrent(response: Response): (() => void) | null {
  return responses.get(response) ?? null;
}

export function assertBrowserResponseCurrent(response: Response): void {
  responses.get(response)?.();
}

function guardedReader(reader: object, assertCurrent: () => void): object {
  return new Proxy(reader, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (property !== 'read') return member.bind(target);
      return async (...arguments_: unknown[]) => {
        assertCurrent();
        const result: unknown = await Reflect.apply(member, target, arguments_);
        assertCurrent();
        return result;
      };
    },
  });
}

function guardedBody(body: ReadableStream<Uint8Array>, assertCurrent: () => void): ReadableStream<Uint8Array> {
  return new Proxy(body, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (property === 'getReader')
        return (...arguments_: unknown[]) => {
          assertCurrent();
          return guardedReader(Reflect.apply(member, target, arguments_), assertCurrent);
        };
      if (property === 'tee')
        return () => {
          assertCurrent();
          return target.tee().map((branch) => guardedBody(branch, assertCurrent));
        };
      if (property === Symbol.asyncIterator || property === 'values')
        return (...arguments_: unknown[]) => {
          assertCurrent();
          const iterator = Reflect.apply(member, target, arguments_) as AsyncIterator<Uint8Array>;
          return {
            async next() {
              assertCurrent();
              const next = await iterator.next();
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
          throw new Error('Selected response piping requires an explicit owner barrier');
        };
      return member.bind(target);
    },
  });
}

export function admitBrowserResponse(response: Response, assertCurrent: () => void): Response {
  assertCurrent();
  let body: ReadableStream<Uint8Array> | null | undefined;
  const admitted = new Proxy(response, {
    get(target, property) {
      if (property === 'body') {
        assertCurrent();
        if (body === undefined) body = target.body === null ? null : guardedBody(target.body, assertCurrent);
        return body;
      }
      if (property === 'clone')
        return () => {
          assertCurrent();
          return admitBrowserResponse(target.clone(), assertCurrent);
        };
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (!bodyMethods.has(property)) return member.bind(target);
      return async (...arguments_: unknown[]) => {
        assertCurrent();
        const result: unknown = await Reflect.apply(member, target, arguments_);
        assertCurrent();
        return result;
      };
    },
  });
  responses.set(admitted, assertCurrent);
  return admitted;
}
