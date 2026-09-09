import { createServer } from 'node:http'

// Placeholder until the Panda-derived SPA lands (#9). Self-contained: no
// external assets, so the page renders with the server offline from npm.
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaiZe</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 system-ui, -apple-system, sans-serif;
  }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 3rem; margin: 0 0 .25rem; letter-spacing: -.04em; }
  p { color: color-mix(in srgb, currentColor 65%, transparent); margin: .25rem 0; }
  code { background: rgba(127,127,127,.15); padding: .1em .35em; border-radius: .3em; }
</style>
</head>
<body>
<main>
  <h1>BaiZe</h1>
  <p>Local-first multi-repo code Q&amp;A.</p>
  <p>Skeleton placeholder — the UI arrives with #9.</p>
  <p><code>GET /api/health</code></p>
</main>
</body>
</html>
`

function send(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
  return status
}

export function createBaizeServer({ logger } = {}) {
  return createServer((req, res) => {
    const path = req.url.split('?')[0]
    let status

    if (path === '/api/health') {
      status = send(res, 200, '{"status":"ok"}\n', 'application/json')
    } else if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      status = send(res, 200, PLACEHOLDER_HTML, 'text/html; charset=utf-8')
    } else {
      status = send(res, 404, '{"error":"not found"}\n', 'application/json')
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
