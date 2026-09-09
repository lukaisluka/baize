// Browsers happily send cross-site requests to localhost: any web page can
// attempt ws://127.0.0.1:<port>, and DNS rebinding can forge the Host header.
// Shared guard for every HTTP surface and the /acp WebSocket upgrade.

export function isLocalHostHeader(host) {
  return /^(127\.0.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host ?? '')
}

// Origin is sent by browsers only. Absent Origin = non-browser client (tests,
// tooling) — allowed. Present Origin must name a local host, which blocks
// evil.example pages and DNS-rebound origins while letting the SPA (served
// from this same server) connect.
export function isLocalOrigin(origin) {
  if (!origin) return true
  try {
    return isLocalHostHeader(new URL(origin).host)
  } catch {
    return false
  }
}
