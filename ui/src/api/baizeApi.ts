/**
 * BaiZe management API client (#16) — the SPA's second server channel
 * besides ACP: /api/* over same-origin fetch. The server gates POSTs on
 * content-type application/json (415 otherwise) and every surface on a
 * local Host header, which a same-origin browser fetch satisfies for free.
 *
 * Wire shapes mirror the server's handlers (src/server.js handleApi):
 * errors arrive as { error: string } and are rethrown as Error with that
 * message — the UI surfaces them verbatim instead of guessing.
 */

export type BaizeSelection = { type: 'group'; path: string } | { type: 'repos'; repos: string[] };

export type BaizeGitlabSettings = {
  baseUrl: string | null;
  hasToken: boolean;
  selection: BaizeSelection | null;
};

/** A discovered repo as /api/gitlab/discover returns it — sizeBytes is null
 * when GitLab withheld statistics (unknown, never zero). */
export type BaizeDiscoveredRepo = {
  name: string;
  defaultBranch: string | null;
  webUrl: string;
  sshUrl: string | null;
  httpUrl: string | null;
  archived: boolean;
  sizeBytes: number | null;
};

export type BaizeMirrorState = {
  status: 'idle' | 'cloning' | 'fetching' | 'needs-auth' | 'error';
  lastSyncAt?: string;
  lastRevision?: string;
  error?: string;
  backoffAttempt: number;
  backoffUntil?: string;
  branch?: string | null;
};

export type BaizeRepoStatus = {
  name: string;
  path: string;
  addedAt?: string;
  mirror?: boolean;
  lastIndexedRevision?: string | null;
  status: 'indexing' | 'ready' | 'error' | 'unindexed';
  error?: string;
  stats?: { nodes: number; edges: number };
  indexedAt?: string;
  retryAt?: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function getBaizeSettings(): Promise<BaizeGitlabSettings> {
  return api('/api/gitlab/settings');
}

/** An absent token keeps the stored one server-side (re-verify flows). */
export function saveBaizeSettings(body: {
  baseUrl: string;
  token?: string;
  selection?: BaizeSelection | null;
}): Promise<BaizeGitlabSettings> {
  return api('/api/gitlab/settings', { method: 'POST', body: JSON.stringify(body) });
}

export function verifyBaizeToken(): Promise<{ username: string }> {
  return api('/api/gitlab/verify', { method: 'POST', body: JSON.stringify({}) });
}

export function discoverBaize(
  input: { group: string } | { repos: string[] },
): Promise<{ repos: BaizeDiscoveredRepo[]; missing?: string[] }> {
  return api('/api/gitlab/discover', { method: 'POST', body: JSON.stringify(input) });
}

export function getBaizeSync(): Promise<{
  states: Record<string, BaizeMirrorState>;
  pollIntervalMinutes: number;
}> {
  return api('/api/sync');
}

/** Long-running: a full first sync only resolves after every clone finished.
 * Callers that want live progress fire this without awaiting and poll
 * getBaizeSync()/getBaizeRepos() instead. */
export function triggerBaizeSyncAll(): Promise<
  { synced: number; failed: number } | { synced: 0; failed: 0; reason: string }
> {
  return api('/api/sync', { method: 'POST', body: JSON.stringify({}) });
}

export function getBaizeRepos(): Promise<{ repos: BaizeRepoStatus[] }> {
  return api('/api/repos');
}
