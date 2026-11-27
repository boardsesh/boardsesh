import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

function createQueryWrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderWithQueryClient(element: Parameters<typeof render>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(element, { wrapper: createQueryWrapper(client) }), queryClient: client };
}

export function renderHookWithQueryClient<Result>(hook: () => Result) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...renderHook(hook, { wrapper: createQueryWrapper(client) }), queryClient: client };
}
