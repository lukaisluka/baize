import { createServer } from 'node:http'

// Placeholder until the Panda-derived SPA lands (#9), now with the repo/index
// surface #8 needs. Self-contained: no external assets, vanilla JS only.
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaiZe</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; font: 16px/1.6 system-ui, -apple-system, sans-serif; }
  header { text-align: center; padding: 2.5rem 1rem 1rem; }
  h1 { font-size: 2.6rem; margin: 0 0 .25rem; letter-spacing: -.04em; }
  header p { color: color-mix(in srgb, currentColor 60%, transparent); margin: .2rem 0; }
  section { max-width: 640px; margin: 0 auto; padding: 1rem; }
  form { display: flex; gap: .5rem; }
  form input[name=path] { flex: 1; }
  input, button {
    font: inherit; padding: .45rem .7rem; border-radius: .45rem;
    border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit;
  }
  button { cursor: pointer; }
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
  #empty { color: color-mix(in srgb, currentColor 55%, transparent); text-align: center; padding: 1.5rem 0; }
</style>
</head>
<body>
<header>
  <h1>BaiZe</h1>
  <p>Local-first multi-repo code Q&amp;A.</p>
  <p>Skeleton placeholder — the UI arrives with #9.</p>
</header>
<section>
  <form id="add-repo">
    <input name="path" placeholder="/absolute/path/to/git/repo" required>
    <button type="submit">Index repo</button>
  </form>
  <div id="error" class="error-text"></div>
  <table hidden>
    <thead><tr><th>Repo</th><th>Status</th><th>Symbols</th><th>Relations</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty">No repos indexed yet — point BaiZe at a local git repository above.</div>
</section>
<script>
const form = document.getElementById('add-repo');
const errorBox = document.getElementById('error');
const table = document.querySelector('table');
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
// Require an explicit local Host and, for writes, a JSON content-type.
function isLocalHostHeader(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host ?? '')
}

async function handleApi(req, res, path, { registry }) {
  if (!isLocalHostHeader(req.headers.host)) {
    return sendJson(res, 403, { error: 'forbidden: non-local Host header' })
  }

  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { status: 'ok' })
  }

  if (req.method === 'GET' && path === '/api/repos') {
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
    return sendJson(res, 201, added)
  }

  return sendJson(res, 404, { error: 'not found' })
}

export function createBaizeServer({ logger, registry } = {}) {
  return createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    let status

    try {
      if (path.startsWith('/api/')) {
        status = await handleApi(req, res, path, { registry })
      } else if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        status = send(res, 200, PLACEHOLDER_HTML, 'text/html; charset=utf-8')
      } else {
        status = sendJson(res, 404, { error: 'not found' })
      }
    } catch (err) {
      status = err.statusCode || 500
      sendJson(res, status, { error: err.message })
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
