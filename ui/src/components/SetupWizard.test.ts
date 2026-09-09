import { describe, expect, it } from 'vitest';
import {
  estimateBytes,
  formatBytes,
  initialSyncSnapshot,
  parseRepoList,
  wizardNeedsSetup,
} from './SetupWizard';
import type { BaizeGitlabSettings, BaizeMirrorState, BaizeRepoStatus } from '../api/baizeApi';

describe('wizardNeedsSetup (#16: empty ~/.baize lands in the wizard)', () => {
  const settings = (patch: Partial<BaizeGitlabSettings>): BaizeGitlabSettings => ({
    baseUrl: 'https://gitlab.test',
    hasToken: true,
    selection: { type: 'group', path: 'grp' },
    ...patch,
  });

  it('a fully configured instance is done', () => {
    expect(wizardNeedsSetup(settings({}))).toBe(false);
  });

  it('missing URL, token, or selection each need the wizard', () => {
    expect(wizardNeedsSetup(settings({ baseUrl: null }))).toBe(true);
    expect(wizardNeedsSetup(settings({ hasToken: false }))).toBe(true);
    expect(wizardNeedsSetup(settings({ selection: null }))).toBe(true);
  });

  it('never shows the wizard while settings are still loading', () => {
    expect(wizardNeedsSetup(null)).toBe(false);
  });
});

describe('estimateBytes (GitLab statistics disk estimate)', () => {
  it('sums known sizes', () => {
    expect(estimateBytes([{ sizeBytes: 100 }, { sizeBytes: 50 }, { sizeBytes: null }])).toEqual({
      total: 150,
      known: 2,
    });
  });

  it('all-unknown is zero known — the UI must say unknown, not 0 B', () => {
    expect(estimateBytes([{ sizeBytes: null }, { sizeBytes: null }])).toEqual({ total: 0, known: 0 });
  });

  it('empty discovery is zero over zero', () => {
    expect(estimateBytes([])).toEqual({ total: 0, known: 0 });
  });
});

describe('formatBytes', () => {
  it('walks the units and keeps bytes integral', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('rounds large values to integers', () => {
    expect(formatBytes(123.7 * 1024)).toBe('124 KB');
  });
});

describe('parseRepoList', () => {
  it('trims, drops blanks, dedupes, preserves order', () => {
    expect(parseRepoList('  a/b \n\nc/d\na/b\n  \n e/f ')).toEqual(['a/b', 'c/d', 'e/f']);
  });

  it('empty input is an empty list', () => {
    expect(parseRepoList('\n  \n')).toEqual([]);
  });
});

describe('initialSyncSnapshot (live first-sync progress)', () => {
  const mirror = (status: BaizeMirrorState['status']): BaizeMirrorState => ({
    status,
    backoffAttempt: 0,
  });
  const index = (status: BaizeRepoStatus['status']): BaizeRepoStatus => ({
    name: 'x',
    path: '/x',
    status,
  });

  it('joins mirror and index states by name, sorted', () => {
    const snap = initialSyncSnapshot(
      { 'grp/b': mirror('idle'), 'grp/a': mirror('fetching') },
      [{ ...index('indexing'), name: 'grp/a' }, { ...index('ready'), name: 'grp/b' }],
    );
    expect(snap.rows.map((r) => r.name)).toEqual(['grp/a', 'grp/b']);
    expect(snap.rows[0]).toMatchObject({ mirror: { status: 'fetching' }, index: { status: 'indexing' } });
    expect(snap.rows[1]).toMatchObject({ mirror: { status: 'idle' }, index: { status: 'ready' } });
    expect(snap.settled).toBe(false);
  });

  it('a repo known to only one side renders the other as null', () => {
    const snap = initialSyncSnapshot({ 'grp/a': mirror('cloning') }, [{ ...index('ready'), name: 'grp/z' }]);
    expect(snap.rows[0]).toMatchObject({ name: 'grp/a', index: null });
    expect(snap.rows[1]).toMatchObject({ name: 'grp/z', mirror: null });
  });

  it('settles when nothing is cloning/fetching/indexing', () => {
    const snap = initialSyncSnapshot({ 'grp/a': mirror('idle') }, [index('ready')]);
    expect(snap.settled).toBe(true);
  });

  it('error and needs-auth are final — they settle, shown as failures', () => {
    const snap = initialSyncSnapshot(
      { 'grp/a': mirror('needs-auth'), 'grp/b': mirror('error') },
      [index('error')],
    );
    expect(snap.settled).toBe(true);
  });

  it('nothing known yet is not settled (waiting for the fleet to register)', () => {
    expect(initialSyncSnapshot({}, []).settled).toBe(false);
  });
});
