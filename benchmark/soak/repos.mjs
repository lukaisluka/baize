/**
 * Fleet for the CBM WAL/daemon soak (#15, PRD §17 item 8): 20 real
 * open-source repositories, mixed languages, each small enough for a
 * --depth 1 clone. The point is realistic write pressure on CBM's SQLite
 * WAL under concurrent indexing + query load, so the fleet spans the
 * languages CBM parses with different extractors (JS/TS, Go, Rust, Python,
 * C) rather than maximizing code volume.
 */

export const FLEET = [
  // JavaScript / TypeScript
  { project: 'expressjs-express', url: 'https://github.com/expressjs/express' },
  { project: 'chalk-chalk', url: 'https://github.com/chalk/chalk' },
  { project: 'alpinejs-alpine', url: 'https://github.com/alpinejs/alpine' },
  { project: 'graphql-graphql-js', url: 'https://github.com/graphql/graphql-js' },
  { project: 'fastify-fastify', url: 'https://github.com/fastify/fastify' },
  { project: 'colinhacks-zod', url: 'https://github.com/colinhacks/zod' },
  { project: 'sindresorhus-got', url: 'https://github.com/sindresorhus/got' },
  // Go
  { project: 'go-yaml-yaml', url: 'https://github.com/go-yaml/yaml' },
  { project: 'urfave-cli', url: 'https://github.com/urfave/cli' },
  { project: 'junegunn-fzf', url: 'https://github.com/junegunn/fzf' },
  { project: 'go-playground-validator', url: 'https://github.com/go-playground/validator' },
  // Rust
  { project: 'tokio-rs-bytes', url: 'https://github.com/tokio-rs/bytes' },
  { project: 'serde-rs-json', url: 'https://github.com/serde-rs/json' },
  { project: 'BurntSushi-ripgrep', url: 'https://github.com/BurntSushi/ripgrep' },
  // Python
  { project: 'psf-requests', url: 'https://github.com/psf/requests' },
  { project: 'pallets-click', url: 'https://github.com/pallets/click' },
  { project: 'encode-httpx', url: 'https://github.com/encode/httpx' },
  // C
  { project: 'antirez-kilo', url: 'https://github.com/antirez/kilo' },
  { project: 'json-c-json-c', url: 'https://github.com/json-c/json-c' },
  { project: 'libgit2-libgit2', url: 'https://github.com/libgit2/libgit2' },
]
