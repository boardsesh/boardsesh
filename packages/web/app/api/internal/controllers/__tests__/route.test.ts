vi.mock('server-only', () => ({}));
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { NextRequest } from 'next/server';

const insertedValues = vi.hoisted(() => vi.fn());

vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: async () => ({ user: { id: 'user-1' } }),
}));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedValues(values);
        return { returning: async () => [{ id: 'controller-1', createdAt: new Date(), ...values }] };
      },
    }),
  }),
}));

import { POST } from '../route';

function register(body: unknown) {
  return POST(
    new Request('http://localhost/api/internal/controllers', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

beforeEach(() => {
  insertedValues.mockClear();
});

describe('POST /api/internal/controllers', () => {
  it('stores a Spraywall key with the placeholder configuration', async () => {
    const response = await register({ name: 'Projector', boardName: 'spray' });

    expect(response.status).toBe(200);
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'spray', layoutId: 0, sizeId: 0, setIds: '' }),
    );
  });

  // The server owns these values, so a client cannot write a config for a spray key.
  it('ignores a configuration sent with a Spraywall key', async () => {
    const response = await register({ boardName: 'spray', layoutId: 8, sizeId: 17, setIds: '26' });

    expect(response.status).toBe(200);
    expect(insertedValues).toHaveBeenCalledWith(expect.objectContaining({ layoutId: 0, sizeId: 0, setIds: '' }));
  });

  it('stores a Kilter controller as it was sent', async () => {
    const response = await register({ boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27' });

    expect(response.status).toBe(200);
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27' }),
    );
  });

  it('still requires a configuration for Kilter and Tension', async () => {
    const response = await register({ boardName: 'tension' });

    expect(response.status).toBe(400);
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it('refuses a board type that has no controller support', async () => {
    const response = await register({ boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1' });

    expect(response.status).toBe(400);
    expect(insertedValues).not.toHaveBeenCalled();
  });
});
