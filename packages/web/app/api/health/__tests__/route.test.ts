import { describe, it, expect } from 'vite-plus/test';
import { GET, type HealthResponse } from '../route';

describe('GET /api/health', () => {
  it('returns 200 with an ok status', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({ status: 'ok' });
  });
});
