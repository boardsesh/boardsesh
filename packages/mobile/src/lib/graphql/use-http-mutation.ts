import { useCallback, useRef } from 'react';
import { useMutation, type DefaultError, type UseMutationOptions } from '@tanstack/react-query';
import { useHttpQueryScope, type HttpQueryOperation } from './use-http-query-scope';

type Callbacks<Result, Error, Variables, Context> = {
  signal?: AbortSignal;
  onSuccess?: (
    result: Result,
    variables: Variables,
    context: Context | undefined,
    operation: HttpQueryOperation,
  ) => unknown;
  onError?: (
    error: Error,
    variables: Variables,
    context: Context | undefined,
    operation: HttpQueryOperation,
  ) => unknown;
  onSettled?: (
    result: Result | undefined,
    error: Error | null,
    variables: Variables,
    context: Context | undefined,
    operation: HttpQueryOperation,
  ) => unknown;
};

export type HttpMutationOptions<Result, Error, Variables, Context> = Pick<
  UseMutationOptions<Result, Error, Variables, Context>,
  'mutationKey' | 'gcTime' | 'retry' | 'retryDelay' | 'networkMode' | 'meta' | 'throwOnError'
> &
  Callbacks<Result, Error, Variables, Context> & {
    signal?: AbortSignal;
    mutationFn: (variables: Variables, operation: HttpQueryOperation) => Promise<Result>;
    onMutate?: (variables: Variables, operation: HttpQueryOperation) => Context | Promise<Context>;
  };

/** Capture before TanStack's first await, including paused/offline onMutate.
 * Callbacks retain their original closure and receive the actual operation for
 * checks after their own awaits. UI effects after mutateWithReceipt must check
 * its returned guard again; mutateAsync alone cannot authorize that continuation. */
export function useHttpMutation<Result, Error = DefaultError, Variables = void, Context = unknown>(
  options: HttpMutationOptions<Result, Error, Variables, Context>,
) {
  const scope = useHttpQueryScope();
  type Invocation = Readonly<{
    variables: Variables;
    operation: HttpQueryOperation;
    original: HttpMutationOptions<Result, Error, Variables, Context>;
    callbacks: Callbacks<Result, Error, Variables, Context>;
  }>;
  const issued = useRef(new WeakSet<Invocation>());
  const currentOptions = useRef(options);
  currentOptions.current = options;
  const originalInvocation = (invocation: Invocation) => {
    if (!issued.current.has(invocation)) throw new Error('Unrecognized HTTP mutation invocation');
    return invocation;
  };
  const {
    mutationFn: _mutationFn,
    onMutate: _onMutate,
    onSuccess: _onSuccess,
    onError: _onError,
    onSettled: _onSettled,
    signal: _signal,
    ...behavior
  } = options;
  const mutation = useMutation<Result, Error, Invocation, Context | undefined>({
    ...behavior,
    async onMutate(input) {
      const { variables, operation, original } = originalInvocation(input);
      operation.assertView();
      const context = await original.onMutate?.(variables, operation);
      operation.assertView();
      return context;
    },
    async mutationFn(input) {
      const { variables, operation, original } = originalInvocation(input);
      operation.assertView();
      const result = await original.mutationFn(variables, operation);
      operation.assertDeliveries();
      return result;
    },
    async onSuccess(result, input, context) {
      const { variables, operation, original, callbacks } = originalInvocation(input);
      for (const callback of [original.onSuccess, callbacks.onSuccess]) {
        operation.assertDeliveries();
        await callback?.(result, variables, context, operation);
        operation.assertDeliveries();
      }
    },
    async onError(error, input, context) {
      const { variables, operation, original, callbacks } = originalInvocation(input);
      // Retired-view error/rollback callbacks must not publish under a new view.
      try {
        operation.assertView();
      } catch {
        return;
      }
      for (const callback of [original.onError, callbacks.onError]) {
        operation.assertView();
        await callback?.(error, variables, context, operation);
        operation.assertView();
      }
    },
    async onSettled(result, error, input, context) {
      const { variables, operation, original, callbacks } = originalInvocation(input);
      const assertCurrent = error ? operation.assertView : operation.assertDeliveries;
      try {
        assertCurrent();
      } catch {
        return;
      }
      for (const callback of [original.onSettled, callbacks.onSettled]) {
        assertCurrent();
        await callback?.(result, error, variables, context, operation);
        assertCurrent();
      }
    },
  });
  const capture = useCallback(
    (variables: Variables, callbacks: Callbacks<Result, Error, Variables, Context> = {}) => {
      const hookSignal = currentOptions.current.signal;
      const callSignal = callbacks.signal;
      const signal = hookSignal && callSignal ? AbortSignal.any([hookSignal, callSignal]) : (callSignal ?? hookSignal);
      const operation = scope.create({ signal });
      operation.assertView();
      const invocation: Invocation = Object.freeze({
        variables,
        operation,
        original: { ...currentOptions.current },
        callbacks: { ...callbacks },
      });
      issued.current.add(invocation);
      return invocation;
    },
    [scope],
  );
  const { mutate: submit, mutateAsync: submitAsync, variables: internalVariables, ...state } = mutation;
  const mutate = useCallback(
    (variables: Variables, callbacks?: Callbacks<Result, Error, Variables, Context>) => {
      submit(capture(variables, callbacks));
    },
    [capture, submit],
  );
  const mutateWithReceipt = useCallback(
    async (variables: Variables, callbacks?: Callbacks<Result, Error, Variables, Context>) => {
      const invocation = capture(variables, callbacks);
      const result = await submitAsync(invocation);
      invocation.operation.assertDeliveries();
      return Object.freeze({
        result,
        assertCurrent: invocation.operation.assertDeliveries,
        dispose: invocation.operation.dispose,
      });
    },
    [capture, submitAsync],
  );
  const mutateAsync = useCallback(
    async (variables: Variables, callbacks?: Callbacks<Result, Error, Variables, Context>) => {
      const receipt = await mutateWithReceipt(variables, callbacks);
      receipt.assertCurrent();
      return receipt.result;
    },
    [mutateWithReceipt],
  );
  return { ...state, variables: internalVariables?.variables, mutate, mutateAsync, mutateWithReceipt };
}
