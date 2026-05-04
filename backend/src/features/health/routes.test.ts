import { describe, expect, test } from 'bun:test';
import { buildApp } from '../../app.ts';
import type { HealthResponse } from './routes.ts';

const REQUEST_ID_HEADER = 'X-Request-ID';

describe('GET /health', () => {
  test('returns 200 with {ok: true}', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({ ok: true });
  });

  test('sets X-Request-ID header when none provided', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    const reqId = res.headers.get(REQUEST_ID_HEADER);
    expect(reqId).toBeTruthy();
    // Generated IDs are RFC 4122 UUIDs (36 chars including dashes).
    expect(reqId?.length).toBe(36);
  });

  test('echoes inbound X-Request-ID header verbatim', async () => {
    const app = buildApp();
    const inbound = 'test-request-id-123';
    const res = await app.request('/health', {
      headers: { [REQUEST_ID_HEADER]: inbound },
    });

    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(inbound);
  });

  test('rejects malformed inbound X-Request-ID and generates a fresh one', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { [REQUEST_ID_HEADER]: 'has whitespace' },
    });

    const reqId = res.headers.get(REQUEST_ID_HEADER);
    expect(reqId).not.toBe('has whitespace');
    expect(reqId?.length).toBe(36);
  });
});
