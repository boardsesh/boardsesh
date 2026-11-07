import { describe, expect, it, vi } from 'vite-plus/test';

// A regression to a real generator connection must fail even when Postgres is
// available locally. The schema-only adapter does not instantiate this client.
vi.mock('postgres', () => ({
  default: () => {
    throw new Error('Schema generation attempted to create a PostgreSQL client');
  },
}));

describe('offline prototype schema generation', () => {
  it('fully initializes the pinned schema configuration without a database client', async () => {
    const { auth } = await import('../schema-config');
    const context = await auth.$context;
    expect(context.adapter.id).toBe('drizzle');
    expect(context.options.plugins.some((plugin) => plugin.id === 'oauth-provider')).toBe(true);
  });
});
