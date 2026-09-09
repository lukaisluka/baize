import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { isLocalHostHeader } from './local-host.js'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

// Static handler for the built SPA (ui/dist). Unknown paths fall back to
// index.html so client-side routing works on deep links; /api/* and /fleet
// are handled before this ever runs.
function serveStatic(res, distDir, urlPath) {
  const root = resolve(distDir)
  const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return send(res, 400, '{"error":"malformed path encoding"}\n', 'application/json')
  }
  const candidate = resolve(root, decoded)
  // Prefix must include the separator, else a sibling dir (ui/dist-evil)
  // would pass the check.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return send(res, 403, '{"error":"forbidden"}\n', 'application/json')
  }
  let file = candidate
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html')
    if (!existsSync(file)) {
      return send(res, 500, '{"error":"UI build missing"}\n', 'application/json')
    }
  }
  const type = MIME_TYPES[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  // The existsSync above can race a concurrent delete; an unhandled stream
  // error would take down the whole server.
  createReadStream(file).on('error', (err) => {
    if (!res.headersSent) send(res, 500, '{"error":"read failed"}\n', 'application/json')
    else res.end()
  }).pipe(res)
  return 200
}

const NO_BUILD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BaiZe</title></head>
<body style="font:16px/1.6 system-ui;padding:3rem;">
<p><strong>BaiZe server is running, but the UI has not been built.</strong></p>
<p>Build it from the repository root: <code>npm run build:ui</code>, then restart baize.</p>
<p>The fleet status page remains available at <a href="/fleet">/fleet</a>.</p>
</body></html>
`

// Fleet status page (#8 surface, extended by #11 with GitLab settings +
// discovery) mounted at /fleet; the chat SPA from the vendored Panda UI is
// served at /. Self-contained vanilla JS, no assets.
const FLEET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaiZe — Fleet</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; font: 16px/1.6 system-ui, -apple-system, sans-serif; }
  header { text-align: center; padding: 2.5rem 1rem 1rem; }
  h1 { font-size: 2.6rem; margin: 0 0 .25rem; letter-spacing: -.04em; }
  header p { color: color-mix(in srgb, currentColor 60%, transparent); margin: .2rem 0; }
  section { max-width: 720px; margin: 0 auto; padding: 1rem; }
  h2 { font-size: 1.1rem; color: color-mix(in srgb, currentColor 70%, transparent); }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  form input[name=path] { flex: 1; min-width: 14rem; }
  input, button, select, textarea {
    font: inherit; padding: .45rem .7rem; border-radius: .45rem;
    border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit;
  }
  button { cursor: pointer; }
  textarea { width: 100%; min-height: 4.5rem; font-family: ui-monospace, monospace; font-size: .9em; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(127,127,127,.25); }
  th { color: color-mix(in srgb, currentColor 55%, transparent); font-weight: 500; }
  .status { padding: .1rem .55rem; border-radius: 1em; font-size: .85em; white-space: nowrap;
            border: 1px solid rgba(127,127,127,.4); }
  .status.indexing { color: #b8860b; border-color: #b8860b; }
  .status.ready { color: #2e7d32; border-color: #2e7d32; }
  .status.error { color: #c62828; border-color: #c62828; }
  .status.unindexed { color: color-mix(in srgb, currentColor 55%, transparent); }
  .error-text { color: #c62828; font-size: .9em; }
  .muted { color: color-mix(in srgb, currentColor 55%, transparent); font-size: .9em; }
  .notice { display: none; padding: .7rem 1rem; border-radius: .5rem; margin-bottom: 1rem;
            background: rgba(198,40,40,.12); border: 1px solid #c62828; color: #c62828; }
  .notice.visible { display: block; }
  .card { border: 1px solid rgba(127,127,127,.3); border-radius: .7rem; padding: 1rem; margin: 1rem 0; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .3rem 0; }
  .ok-text { color: #2e7d32; font-size: .9em; }
</style>
</head>
<body>
<header>
  <h1>BaiZe</h1>
  <p>Local-first multi-repo code Q&amp;A.</p>
  <p>Fleet status — the chat UI lives at <a href="/">/</a>.</p>
</header>
<section>
  <div id="gitlab-notice" class="notice"></div>

  <div class="card">
    <h2>GitLab connection</h2>
    <div class="row">
      <input id="gl-url" placeholder="https://gitlab.example.com" style="flex:1; min-width:14rem">
      <input id="gl-pat" type="password" placeholder="access token (leave blank to keep)" style="flex:1; min-width:12rem">
      <button id="gl-save">Save</button>
      <button id="gl-verify">Test</button>
    </div>
    <div id="gl-status" class="muted"></div>
  </div>

  <div class="card">
    <h2>Discover repositories</h2>
    <div class="row">
      <select id="disc-mode">
        <option value="group">Group (recursive)</option>
        <option value="repos">Explicit repo list</option>
      </select>
      <input id="disc-group" placeholder="group/subgroup" style="flex:1">
      <button id="disc-run">Discover</button>
    </div>
    <textarea id="disc-repos" hidden placeholder="one project path per line, e.g.&#10;group/project-a&#10;group/sub/project-b"></textarea>
    <div id="disc-error" class="error-text"></div>
    <table id="disc-table" hidden>
      <thead><tr><th>Repository</th><th>Default branch</th><th>Archived</th></tr></thead>
      <tbody id="disc-rows"></tbody>
    </table>
    <div id="disc-missing" class="muted"></div>
  </div>

  <div class="card">
    <h2>Local repositories</h2>
    <form id="add-repo">
      <input name="path" placeholder="/absolute/path/to/git/repo" required>
      <button type="submit">Index repo</button>
    </form>
    <div id="error" class="error-text"></div>
    <table id="repo-table" hidden>
      <thead><tr><th>Repo</th><th>Status</th><th>Symbols</th><th>Relations</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" class="muted">No repos indexed yet — point BaiZe at a local git repository above.</div>
  </div>
</section>
<script>
const notice = document.getElementById('gitlab-notice');
const urlInput = document.getElementById('gl-url');
const patInput = document.getElementById('gl-pat');
const glStatus = document.getElementById('gl-status');
const discMode = document.getElementById('disc-mode');
const discGroup = document.getElementById('disc-group');
const discRepos = document.getElementById('disc-repos');
const discError = document.getElementById('disc-error');
const discTable = document.getElementById('disc-table');
const discRows = document.getElementById('disc-rows');
const discMissing = document.getElementById('disc-missing');
let glSettings = { baseUrl: null, hasToken: false };

function showNotice(message) {  // the single global PAT/connection prompt (PRD §7.3)
  notice.textContent = message;
  notice.classList.add('visible');
}
function clearNotice() { notice.classList.remove('visible'); }

async function api(path, { method = 'POST', body = {} } = {}) {
  const res = await fetch(path, method === 'GET' ? {} : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  return data;
}

function renderGlStatus() {
  glStatus.textContent = glSettings.baseUrl
    ? (glSettings.hasToken ? 'Connected configuration: ' + glSettings.baseUrl + ' (token stored)'
                           : glSettings.baseUrl + ' — no token stored yet')
    : 'Not configured.';
}

async function loadGlSettings() {
  try { glSettings = await api('/api/gitlab/settings', { method: 'GET' }); } catch { /* not configured yet */ }
  urlInput.value = glSettings.baseUrl ?? '';
  renderGlStatus();
}

document.getElementById('gl-save').addEventListener('click', async () => {
  clearNotice();
  try {
    glSettings = await api('/api/gitlab/settings', { body: {
      baseUrl: urlInput.value.trim(),
      ...(patInput.value.trim() ? { token: patInput.value.trim() } : {}),
    }});
    patInput.value = '';
    renderGlStatus();
  } catch (err) { showNotice('Could not save GitLab settings: ' + err.message); }
});

document.getElementById('gl-verify').addEventListener('click', async () => {
  clearNotice();
  glStatus.textContent = 'Checking token…';
  try {
    const { username } = await api('/api/gitlab/verify');
    glStatus.textContent = 'Token OK — authenticated as ' + username + '.';
  } catch (err) {
    if (err.code === 'GITLAB_UNAUTHORIZED') showNotice('GitLab rejected the token — paste a new one above and Save.');
    else showNotice('GitLab check failed: ' + err.message);
    renderGlStatus();
  }
});

discMode.addEventListener('change', () => {
  discGroup.hidden = discMode.value !== 'group';
  discRepos.hidden = discMode.value !== 'repos';
});

document.getElementById('disc-run').addEventListener('click', async () => {
  clearNotice(); discError.textContent = ''; discMissing.textContent = '';
  const isGroup = discMode.value === 'group';
  try {
    const result = await api('/api/gitlab/discover', { body: isGroup
      ? { group: discGroup.value.trim() }
      : { repos: discRepos.value.split('\\n').map((l) => l.trim()).filter(Boolean) } });
    discTable.hidden = result.repos.length === 0;
    discRows.replaceChildren(...result.repos.map((repo) => {
      const tr = document.createElement('tr');
      const link = document.createElement('a');
      link.href = repo.webUrl; link.textContent = repo.name;
      const td = (content) => { const c = document.createElement('td'); c.append(content); return c; };
      tr.append(td(link), td(repo.defaultBranch ?? ''), td(repo.archived ? 'yes' : ''));
      return tr;
    }));
    if (result.missing?.length) discMissing.textContent = 'Not found: ' + result.missing.join(', ');
    // Persist the working selection for the mirror/sync phase (#12).
    if (result.repos.length > 0) {
      glSettings = await api('/api/gitlab/settings', { body: {
        baseUrl: glSettings.baseUrl,
        selection: isGroup ? { type: 'group', path: discGroup.value.trim() }
                           : { type: 'repos', repos: result.repos.map((r) => r.name) },
      }});
      renderGlStatus();
    }
  } catch (err) {
    if (err.code === 'GITLAB_UNAUTHORIZED') showNotice('GitLab rejected the token — update it in the GitLab connection card above.');
    else if (err.code === 'GITLAB_NOT_CONFIGURED') showNotice('Configure the GitLab connection above first.');
    else discError.textContent = err.message;
  }
});

const form = document.getElementById('add-repo');
const errorBox = document.getElementById('error');
const table = document.getElementById('repo-table');
const rows = document.getElementById('rows');
const empty = document.getElementById('empty');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  const path = form.path.value.trim();
  try {
    const res = await fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    form.path.value = '';
    refresh();
  } catch (err) {
    errorBox.textContent = err.message;
  }
});

async function refresh() {
  let repos = [];
  try {
    const res = await fetch('/api/repos');
    if (res.ok) repos = (await res.json()).repos;
  } catch { /* next poll retries */ }
  empty.hidden = repos.length > 0;
  table.hidden = repos.length === 0;
  rows.replaceChildren(...repos.map((repo) => {
    const tr = document.createElement('tr');
    const td = (content) => {
      const cell = document.createElement('td');
      if (typeof content === 'object') cell.append(content);
      else cell.textContent = content;
      return cell;
    };
    const chip = document.createElement('span');
    chip.className = 'status ' + repo.status;
    chip.textContent = repo.status;
    tr.append(
      td(repo.name),
      td(chip),
      td(repo.stats?.nodes ?? ''),
      td(repo.stats?.edges ?? ''),
      td(repo.error || ''),
    );
    return tr;
  }));
}

loadGlSettings();
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`

function send(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
  return status
}

function sendJson(res, status, payload) {
  return send(res, status, `${JSON.stringify(payload)}\n`, 'application/json')
}

const MAX_BODY_BYTES = 1024 * 1024

// Respond 413 instead of destroying the socket (a destroyed socket surfaces
// as ECONNRESET on the client, hiding the real status). The request is
// paused so the oversized body is never buffered.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        req.pause()
        req.removeAllListeners('data')
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// The API binds 127.0.0.1 only, but browsers happily send cross-site requests
// to localhost: a hostile page can POST text/plain (no preflight) and make
// baize index arbitrary local paths, and DNS rebinding can forge the Host.
// Every surface requires an explicit local Host; writes additionally require
// a JSON content-type.
async function handleApi(req, res, path, { registry, gitlab }) {
  const getLike = req.method === 'GET' || req.method === 'HEAD'

  if (getLike && path === '/api/health') {
    return sendJson(res, 200, { status: 'ok' })
  }

  if (getLike && path === '/api/repos') {
    return sendJson(res, 200, { repos: await registry.list() })
  }

  if (req.method === 'POST' && path === '/api/repos') {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'content-type must be application/json' })
    }
    const body = await readJsonBody(req)
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'field "path" (absolute git repo path) is required' })
    }
    const added = registry.add(body.path, body.name)
    return sendJson(res, added.alreadyRegistered ? 200 : 201, added)
  }

  if (getLike && path === '/api/gitlab/settings') {
    return sendJson(res, 200, gitlab.getSettings())
  }

  if (req.method === 'POST' && path === '/api/gitlab/settings') {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'content-type must be application/json' })
    }
    const body = await readJsonBody(req)
    if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
      return sendJson(res, 400, { error: 'field "baseUrl" is required' })
    }
    return sendJson(res, 200, gitlab.saveSettings(body))
  }

  if (req.method === 'POST' && path === '/api/gitlab/verify') {
    // Same content-type gate as the other writes: a hostile page must not be
    // able to trigger PAT-authenticated requests via a no-preflight form POST.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'content-type must be application/json' })
    }
    await readJsonBody(req) // drain
    return sendJson(res, 200, await gitlab.verify())
  }

  if (req.method === 'POST' && path === '/api/gitlab/discover') {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'content-type must be application/json' })
    }
    return sendJson(res, 200, await gitlab.discover(await readJsonBody(req)))
  }

  return sendJson(res, 404, { error: 'not found' })
}

export function createBaizeServer({ logger, registry, gitlab, uiDist } = {}) {
  const spaAvailable = uiDist ? existsSync(join(uiDist, 'index.html')) : false

  return createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    // One guard for every surface (API, SPA, fleet) — not just /api/*:
    // a DNS-rebound page must not read or drive anything on this server.
    if (!isLocalHostHeader(req.headers.host)) {
      const status = sendJson(res, 403, { error: 'forbidden: non-local Host header' })
      logger?.info(`${req.method} ${path} -> ${status}`)
      return
    }
    // HEAD rides the GET branches (Node suppresses the body for HEAD).
    const getLike = req.method === 'GET' || req.method === 'HEAD'
    let status

    try {
      if (path.startsWith('/api/')) {
        status = await handleApi(req, res, path, { registry, gitlab })
      } else if (getLike && (path === '/fleet' || path === '/fleet/')) {
        status = send(res, 200, FLEET_HTML, 'text/html; charset=utf-8')
      } else if (getLike && uiDist && spaAvailable) {
        status = serveStatic(res, uiDist, path)
      } else if (getLike && uiDist && !spaAvailable) {
        status = send(res, 200, NO_BUILD_HTML, 'text/html; charset=utf-8')
      } else {
        status = sendJson(res, 404, { error: 'not found' })
      }
    } catch (err) {
      status = err.statusCode || 500
      // err.code carries machine-readable causes (e.g. GITLAB_UNAUTHORIZED)
      // the UI acts on; the PAT itself must never be part of any error body.
      sendJson(res, status, { error: err.message, ...(err.code ? { code: err.code } : {}) })
    }

    logger?.info(`${req.method} ${path} -> ${status}`)
  })
}

export function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({ host: address.address, port: address.port })
    })
  })
}

export function close(server) {
  return new Promise((resolve, reject) => server.close(resolve).once('error', reject))
}
