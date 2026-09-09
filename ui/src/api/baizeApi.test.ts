import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  discoverBaize,
  getBaizeSettings,
  saveBaizeSettings,
  verifyBaizeToken,
} from './baizeApi';

/** Stubs global fetch and records every call — the client is a thin wire
 * layer, so tests assert the exact request line (path, method, JSON
 * content-type against the server's 415 gate) and error unwrapping. */
function stubFetch(status: number, body: unknown) {
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('baizeApi wire contract', () => {
  it('GETs settings and returns the parsed body', async () => {
    const calls = stubFetch(200, { baseUrl: 'https://gitlab.test', hasToken: true, selection: null });
    const settings = await getBaizeSettings();
    expect(settings).toEqual({ baseUrl: 'https://gitlab.test', hasToken: true, selection: null });
    expect(calls[0]!.path).toBe('/api/gitlab/settings');
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it('POSTs JSON bodies with the application/json content-type (the 415 gate)', async () => {
    const calls = stubFetch(200, { baseUrl: 'https://x', hasToken: true, selection: null });
    await saveBaizeSettings({ baseUrl: 'https://x', token: 'glpat-1' });
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ baseUrl: 'https://x', token: 'glpat-1' });
  });

  it('throws the server error message on non-2xx (no HTML soup in the UI)', async () => {
    stubFetch(409, { error: 'gitlab is not configured' });
    await expect(verifyBaizeToken()).rejects.toThrow('gitlab is not configured');
  });

  it('falls back to HTTP status when the body carries no error field', async () => {
    stubFetch(500, { unexpected: true });
    await expect(verifyBaizeToken()).rejects.toThrow('HTTP 500');
  });

  it('a non-JSON error body (proxy page) degrades to the status, not a SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    await expect(verifyBaizeToken()).rejects.toThrow('HTTP 502');
  });

  it('discovers with the input verbatim (group or explicit repos)', async () => {
    const calls = stubFetch(200, { repos: [] });
    await discoverBaize({ group: 'grp/sub' });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ group: 'grp/sub' });
    await discoverBaize({ repos: ['a/b', 'c/d'] });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ repos: ['a/b', 'c/d'] });
  });
});
