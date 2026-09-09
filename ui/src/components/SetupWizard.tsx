/**
 * First-run setup wizard (#16, PRD §6.2): GitLab URL + PAT → pick a group or
 * explicit repos (count + disk estimate from GitLab statistics) → first sync
 * with live mirror/index progress. Replaces the main column until the
 * settings are complete (baseUrl + token + selection), then never shows
 * again — management after setup stays on the /fleet page.
 *
 * The step helpers below are pure and exported for tests; the three step
 * components talk to /api/* through ui/src/api/baizeApi.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import {
  discoverBaize,
  getBaizeRepos,
  getBaizeSettings,
  getBaizeSync,
  saveBaizeSettings,
  triggerBaizeSyncAll,
  verifyBaizeToken,
  type BaizeDiscoveredRepo,
  type BaizeGitlabSettings,
  type BaizeMirrorState,
  type BaizeRepoStatus,
  type BaizeSelection,
} from '../api/baizeApi';
import './SetupWizard.css';

/** Unconfigured = any of the three wizard deliverables missing. A null
 * argument means "still loading" — never flash the wizard on a slow /api. */
export function wizardNeedsSetup(settings: BaizeGitlabSettings | null): boolean {
  if (!settings) return false;
  return !settings.baseUrl || !settings.hasToken || settings.selection === null;
}

/** Sums the known sizes. Repos without GitLab statistics stay excluded —
 * a partial sum is a lower bound, which the UI must say ("at least"). */
export function estimateBytes(repos: { sizeBytes: number | null }[]): { total: number; known: number } {
  let total = 0;
  let known = 0;
  for (const repo of repos) {
    if (typeof repo.sizeBytes === 'number') {
      total += repo.sizeBytes;
      known += 1;
    }
  }
  return { total, known };
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Integral values stay integral (2 KB, not 2.0 KB); fractions get one digit.
  return `${unit === 0 || value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One path per line, trimmed, deduped, order preserved. */
export function parseRepoList(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

export type SyncRepoRow = {
  name: string;
  mirror: BaizeMirrorState | null;
  index: BaizeRepoStatus | null;
};

/** Joins mirror states with index statuses by repo name and decides whether
 * the initial sync has settled: something is known, nothing is cloning/
 * fetching, nothing is indexing. Error/needs-auth states still count as
 * settled — they are final for this round and shown as such. */
export function initialSyncSnapshot(
  states: Record<string, BaizeMirrorState>,
  repos: BaizeRepoStatus[],
): { rows: SyncRepoRow[]; settled: boolean } {
  const names = new Set<string>([...Object.keys(states), ...repos.map((r) => r.name)]);
  const rows = [...names].sort().map((name) => ({
    name,
    mirror: states[name] ?? null,
    index: repos.find((r) => r.name === name) ?? null,
  }));
  const mirrorBusy = Object.values(states).some((s) => s.status === 'cloning' || s.status === 'fetching');
  const indexBusy = repos.some((r) => r.status === 'indexing');
  return { rows, settled: names.size > 0 && !mirrorBusy && !indexBusy };
}

/** Loads the settings once and re-loads on refresh(); drives whether the
 * wizard replaces the main column. A failed probe counts as unconfigured —
 * the wizard's own actions will surface the real error if /api is down. */
export function useBaizeSetup(): {
  phase: 'loading' | 'needed' | 'done';
  settings: BaizeGitlabSettings | null;
  refresh: () => void;
} {
  const [settings, setSettings] = useState<BaizeGitlabSettings | null>(null);
  const refresh = useCallback(() => {
    getBaizeSettings()
      .then(setSettings)
      .catch(() => setSettings({ baseUrl: null, hasToken: false, selection: null }));
  }, []);
  useEffect(refresh, [refresh]);
  return { phase: settings === null ? 'loading' : wizardNeedsSetup(settings) ? 'needed' : 'done', settings, refresh };
}

type Step = 'connect' | 'select' | 'sync';

export default function SetupWizard({ settings, onFinished }: {
  settings: BaizeGitlabSettings;
  onFinished: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>('connect');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');

  const steps: { id: Step; label: string }[] = [
    { id: 'connect', label: t('setup.step.connect') },
    { id: 'select', label: t('setup.step.select') },
    { id: 'sync', label: t('setup.step.sync') },
  ];
  const currentIndex = steps.findIndex((s) => s.id === step);

  return (
    <div className="setup-wizard">
      <div className="setup-body">
        <div className="setup-hero">
          <h1 className="setup-title">{t('setup.title')}</h1>
          <p className="setup-subtitle">{t('setup.subtitle')}</p>
          <ol className="setup-steps" aria-label={t('setup.stepsLabel')}>
            {steps.map((s, i) => (
              <li key={s.id} className={`setup-step ${i === currentIndex ? 'setup-step--current' : ''} ${i < currentIndex ? 'setup-step--done' : ''}`}>
                <span className="setup-step-num">{i < currentIndex ? '✓' : i + 1}</span>
                <span className="setup-step-label">{s.label}</span>
              </li>
            ))}
          </ol>
        </div>
        {step === 'connect' && (
          <ConnectStep initialBaseUrl={baseUrl} hasStoredToken={settings.hasToken} onConnected={(url) => { setBaseUrl(url); setStep('select') }} />
        )}
        {step === 'select' && baseUrl && <SelectStep baseUrl={baseUrl} onSelected={() => setStep('sync')} />}
        {step === 'sync' && <SyncStep onFinished={onFinished} />}
        <footer className="setup-footer">
          <button type="button" className="setup-link" onClick={onFinished}>
            {t('setup.skip')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConnectStep({ initialBaseUrl, hasStoredToken, onConnected }: {
  initialBaseUrl: string;
  hasStoredToken: boolean;
  onConnected: (baseUrl: string) => void;
}) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setUsername(null);
    try {
      // An empty token keeps the stored one server-side.
      await saveBaizeSettings({ baseUrl, ...(token ? { token } : {}) });
      const { username: verified } = await verifyBaizeToken();
      setUsername(verified);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="setup-card">
      <h2 className="setup-card-title">{t('setup.step.connect')}</h2>
      <label className="setup-field">
        <span className="setup-field-label">{t('setup.connect.baseUrl')}</span>
        <input
          className="setup-input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gitlab.example.com"
          spellCheck={false}
          autoComplete="url"
        />
        <span className="setup-field-hint">{t('setup.connect.baseUrlHint')}</span>
      </label>
      <label className="setup-field">
        <span className="setup-field-label">{t('setup.connect.token')}</span>
        <input
          className="setup-input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasStoredToken ? t('setup.connect.tokenStored') : 'glpat-…'}
          autoComplete="off"
        />
        <span className="setup-field-hint">{t('setup.connect.tokenHint')}</span>
      </label>
      {error && <p className="setup-error" role="alert">{error}</p>}
      {username && <p className="setup-verified">{t('setup.connect.verified', { name: username })}</p>}
      <div className="setup-actions">
        <button type="button" className="setup-btn" disabled={busy || !baseUrl.trim()} onClick={connect}>
          {busy ? t('setup.connect.busy') : t('setup.connect.submit')}
        </button>
        {username && (
          <button type="button" className="setup-btn setup-btn--primary" onClick={() => onConnected(baseUrl.trim())}>
            {t('setup.connect.continue')}
          </button>
        )}
      </div>
    </section>
  );
}

function SelectStep({ baseUrl, onSelected }: { baseUrl: string; onSelected: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'group' | 'repos'>('group');
  const [groupPath, setGroupPath] = useState('');
  const [repoText, setRepoText] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [result, setResult] = useState<{ repos: BaizeDiscoveredRepo[]; missing?: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoList = parseRepoList(repoText);
  const discover = async () => {
    setDiscovering(true);
    setError(null);
    setResult(null);
    try {
      const found = mode === 'group'
        ? await discoverBaize({ group: groupPath.trim() })
        : await discoverBaize({ repos: repoList });
      if (found.repos.length === 0) {
        setError(t('setup.select.empty'));
      } else {
        setResult(found);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const confirm = async () => {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      const selection: BaizeSelection = mode === 'group'
        ? { type: 'group', path: groupPath.trim() }
        : { type: 'repos', repos: result.repos.map((r) => r.name) };
      await saveBaizeSettings({ baseUrl, selection });
      onSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const estimate = result ? estimateBytes(result.repos) : null;
  const archived = result?.repos.filter((r) => r.archived).length ?? 0;
  const canDiscover = mode === 'group' ? groupPath.trim().length > 0 : repoList.length > 0;

  return (
    <section className="setup-card">
      <h2 className="setup-card-title">{t('setup.step.select')}</h2>
      <div className="setup-mode" role="radiogroup" aria-label={t('setup.select.modeLabel')}>
        {(['group', 'repos'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`setup-mode-item ${mode === m ? 'setup-mode-item--active' : ''}`}
            onClick={() => { setMode(m); setResult(null); setError(null) }}
          >
            {t(`setup.select.mode.${m}`)}
          </button>
        ))}
      </div>
      {mode === 'group' ? (
        <label className="setup-field">
          <span className="setup-field-label">{t('setup.select.groupPath')}</span>
          <input
            className="setup-input"
            value={groupPath}
            onChange={(e) => setGroupPath(e.target.value)}
            placeholder="my-team/my-product"
            spellCheck={false}
          />
          <span className="setup-field-hint">{t('setup.select.groupPathHint')}</span>
        </label>
      ) : (
        <label className="setup-field">
          <span className="setup-field-label">{t('setup.select.repoList')}</span>
          <textarea
            className="setup-input setup-input--area"
            value={repoText}
            onChange={(e) => setRepoText(e.target.value)}
            placeholder={'team/repo-a\nteam/repo-b'}
            spellCheck={false}
          />
          <span className="setup-field-hint">{t('setup.select.repoListHint')}</span>
        </label>
      )}
      <div className="setup-actions">
        <button type="button" className="setup-btn" disabled={discovering || !canDiscover} onClick={discover}>
          {discovering ? t('setup.select.discovering') : t('setup.select.discover')}
        </button>
      </div>
      {error && <p className="setup-error" role="alert">{error}</p>}
      {result && (
        <div className="setup-discovered">
          <p className="setup-summary">
            {estimate && estimate.known > 0 ? (
              estimate.known < result.repos.length
                ? t('setup.select.summaryPartial', {
                    n: result.repos.length,
                    size: formatBytes(estimate.total),
                    known: estimate.known,
                    total: result.repos.length,
                  })
                : t('setup.select.summary', { n: result.repos.length, size: formatBytes(estimate.total) })
            ) : (
              t('setup.select.summaryUnknown', { n: result.repos.length })
            )}
            {archived > 0 ? ` · ${t('setup.select.archived', { n: archived })}` : ''}
          </p>
          {result.missing && result.missing.length > 0 && (
            <p className="setup-warning">{t('setup.select.missing', { names: result.missing.join(', ') })}</p>
          )}
          <ul className="setup-list">
            {result.repos.map((repo) => (
              <li key={repo.name} className="setup-list-row">
                <span className="setup-list-name" title={repo.name}>{repo.name}</span>
                <span className="setup-list-meta">
                  {repo.archived && <span className="setup-badge">{t('setup.select.archivedBadge')}</span>}
                  <span className="setup-list-size">
                    {repo.sizeBytes === null ? t('setup.select.sizeUnknown') : formatBytes(repo.sizeBytes)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="setup-actions">
            <button type="button" className="setup-btn setup-btn--primary" disabled={saving} onClick={confirm}>
              {saving ? t('setup.select.saving') : t('setup.select.confirm')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SyncStep({ onFinished }: { onFinished: () => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ rows: SyncRepoRow[]; settled: boolean } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // Fire without awaiting: a full first sync resolves only after every
    // clone finished — progress comes from the poll below.
    triggerBaizeSyncAll().catch((err) => {
      if (alive.current) setSyncError(err instanceof Error ? err.message : String(err));
    });
    const tick = async () => {
      try {
        const [sync, repos] = await Promise.all([getBaizeSync(), getBaizeRepos()]);
        if (!alive.current) return;
        setSnapshot(initialSyncSnapshot(sync.states, repos.repos));
        setSyncError(null);
      } catch (err) {
        if (alive.current) setSyncError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="setup-card">
      <h2 className="setup-card-title">
        {snapshot?.settled ? t('setup.sync.done') : t('setup.sync.title')}
      </h2>
      {syncError && <p className="setup-error" role="alert">{t('setup.sync.error', { error: syncError })}</p>}
      {snapshot && snapshot.rows.length > 0 && (
        <ul className="setup-list">
          {snapshot.rows.map((row) => (
            <li key={row.name} className="setup-list-row">
              <span className="setup-list-name" title={row.name}>{row.name}</span>
              <span className="setup-list-meta">
                <span className={`setup-state setup-state--${row.mirror?.status ?? 'pending'}`}>
                  {t(`setup.state.mirror.${row.mirror?.status ?? 'pending'}`)}
                </span>
                <span className={`setup-state setup-state--${row.index?.status ?? 'pending'}`}>
                  {t(`setup.state.index.${row.index?.status ?? 'pending'}`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {snapshot && snapshot.rows.length === 0 && !syncError && (
        <p className="setup-field-hint">{t('setup.sync.waiting')}</p>
      )}
      {snapshot?.settled && snapshot.rows.some((r) => r.mirror?.status === 'error' || r.index?.status === 'error') && (
        <p className="setup-warning">{t('setup.sync.someFailed')}</p>
      )}
      <div className="setup-actions">
        {snapshot?.settled ? (
          <button type="button" className="setup-btn setup-btn--primary" onClick={onFinished}>
            {t('setup.sync.finish')}
          </button>
        ) : (
          <button type="button" className="setup-btn" onClick={onFinished}>
            {t('setup.sync.background')}
          </button>
        )}
      </div>
    </section>
  );
}
