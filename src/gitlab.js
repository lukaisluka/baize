// GitLab REST v4 client + settings service (PRD §7.1–7.2).
//
// Hard rule (§7.2): the PAT must never appear in logs or audit records. Here
// that means every logger call prints only paths, statuses and error codes —
// the token travels exclusively in the PRIVATE-TOKEN header and config.json.
// A test pins this by scanning captured log lines for the token.
//
// The PAT is for API calls only; git clone/fetch keeps using the user's
// ambient credentials (§7.3), so no token ever lands in a remote URL.

const API_PREFIX = '/api/v4'
const PER_PAGE = 100
const MAX_PAGES = 500 // runaway-loop guard: 50k projects is beyond any real group

export class GitLabError extends Error {
  constructor(message, code, statusCode) {
    super(message)
    this.name = 'GitLabError'
    this.code = code // GITLAB_UNAUTHORIZED | GITLAB_FORBIDDEN | GITLAB_NOT_FOUND | GITLAB_UNREACHABLE | GITLAB_BAD_REQUEST | GITLAB_NOT_CONFIGURED | GITLAB_API_ERROR
    this.statusCode = statusCode // HTTP status the baize API should answer with
  }
}

// Accepts what users paste: host, https://host, trailing slashes, even a full
// /api/v4 suffix — and normalizes to a bare origin-style base.
export function normalizeBaseUrl(raw) {
  let url = String(raw ?? '').trim()
  if (!url) throw new GitLabError('GitLab base URL is required', 'GITLAB_BAD_REQUEST', 400)
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new GitLabError(`invalid GitLab base URL: ${raw}`, 'GITLAB_BAD_REQUEST', 400)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/api\/v4$/i, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

function encodePathSegment(segment) {
  return encodeURIComponent(String(segment).replace(/^\/+|\/+$/g, ''))
}

// '<url>; rel="next", <url>; rel="first"' — the next page URL or null.
function nextLink(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match) return match[1]
  }
  return null
}

export function createGitLabClient({ baseUrl, token, fetchImpl = fetch, logger }) {
  const root = normalizeBaseUrl(baseUrl)

  // One request + one error vocabulary for every call site. Logs never carry
  // the token: only the path and the HTTP status.
  async function request(path) {
    let response
    try {
      response = await fetchImpl(`${root}${API_PREFIX}${path}`, {
        headers: token ? { 'PRIVATE-TOKEN': token } : {},
      })
    } catch (err) {
      logger?.warn(`gitlab: request to ${path.split('?')[0]} failed: ${err.message}`)
      throw new GitLabError(`GitLab is unreachable: ${err.message}`, 'GITLAB_UNREACHABLE', 502)
    }
    if (response.ok) return response
    const status = response.status
    logger?.warn(`gitlab: ${path.split('?')[0]} -> ${status}`)
    if (status === 401) throw new GitLabError('GitLab rejected the token (401)', 'GITLAB_UNAUTHORIZED', 401)
    if (status === 403) throw new GitLabError('GitLab denied access (403) — check token scopes', 'GITLAB_FORBIDDEN', 402)
    if (status === 404) throw new GitLabError(`GitLab reports not found: ${path.split('?')[0]}`, 'GITLAB_NOT_FOUND', 404)
    throw new GitLabError(`GitLab API error ${status} on ${path.split('?')[0]}`, 'GITLAB_API_ERROR', 502)
  }

  // Keyset pagination (order_by=id&sort=asc is required for keyset; the API
  // signals the next page via the Link header and an id_after cursor).
  async function paged(path) {
    const basePath = path.split('?')[0]
    let query = `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&pagination=keyset&order_by=id&sort=asc`
    const items = []
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await request(query)
      const batch = await response.json()
      items.push(...batch)
      const next = nextLink(response.headers.get('link'))
      if (!next || batch.length === 0) return items
      // GitLab sends absolute links; resolve defensively so relative ones work too.
      query = `${basePath}${new URL(next, root).search}`
    }
    logger?.warn(`gitlab: ${basePath} exceeded ${MAX_PAGES} pages; stopping`)
    return items
  }

  function toRepo(project) {
    return {
      name: project.path_with_namespace,
      defaultBranch: project.default_branch,
      webUrl: project.web_url,
      sshUrl: project.ssh_url_to_repo,
      httpUrl: project.http_url_to_repo,
      archived: Boolean(project.archived),
    }
  }

  return {
    baseUrl: root,
    async verifyToken() {
      const user = await (await request('/user')).json()
      return { username: user.username }
    },
    async discoverGroup(groupPath) {
      if (!groupPath?.trim()) throw new GitLabError('group path is required', 'GITLAB_BAD_REQUEST', 400)
      const projects = await paged(`/groups/${encodePathSegment(groupPath)}/projects?include_subgroups=true`)
      return { repos: projects.map(toRepo) }
    },
    async resolveRepos(paths) {
      const repos = []
      const missing = []
      for (const entry of paths) {
        try {
          const project = await (await request(`/projects/${encodePathSegment(entry)}`)).json()
          repos.push(toRepo(project))
        } catch (err) {
          if (err.code === 'GITLAB_NOT_FOUND') missing.push(entry)
          else throw err
        }
      }
      if (repos.length === 0 && missing.length > 0) {
        throw new GitLabError(`none of the listed repositories exist: ${missing.join(', ')}`, 'GITLAB_NOT_FOUND', 404)
      }
      return { repos, missing }
    },
  }
}

function validSelection(selection) {
  if (selection === null || selection === undefined) return null
  if (typeof selection !== 'object' || Array.isArray(selection)) return undefined
  if (selection.type === 'group') {
    return typeof selection.path === 'string' && selection.path.trim()
      ? { type: 'group', path: selection.path.trim() }
      : undefined
  }
  if (selection.type === 'repos') {
    const repos = Array.isArray(selection.repos)
      ? selection.repos.map((r) => String(r).trim()).filter(Boolean)
      : null
    return repos && repos.length > 0 ? { type: 'repos', repos } : undefined
  }
  return undefined
}

// Settings + discovery over config.json. The token never echoes back to the
// API surface — the UI learns only whether one is stored (hasToken).
export function createGitLabService({ config, save, logger, fetchImpl }) {
  function client() {
    const { baseUrl, token } = config.gitlab ?? {}
    if (!baseUrl || !token) {
      throw new GitLabError(
        'GitLab is not configured yet — set base URL and token first',
        'GITLAB_NOT_CONFIGURED',
        409,
      )
    }
    return createGitLabClient({ baseUrl, token, logger, fetchImpl })
  }

  return {
    getSettings() {
      const { baseUrl, token, selection } = config.gitlab ?? {}
      return { baseUrl: baseUrl ?? null, hasToken: Boolean(token), selection: selection ?? null }
    },
    saveSettings({ baseUrl, token, selection }) {
      const normalized = normalizeBaseUrl(baseUrl)
      const picked = validSelection(selection)
      if (selection !== undefined && picked === undefined) {
        throw new GitLabError(
          'selection must be {type:"group", path} or {type:"repos", repos:[...]}',
          'GITLAB_BAD_REQUEST',
          400,
        )
      }
      const tokenChanged = Boolean(token)
      config.gitlab = {
        baseUrl: normalized,
        // Empty/missing token keeps the stored one — the UI never receives it
        // back, so "leave the field blank" must not wipe the credential.
        token: token ? String(token) : config.gitlab?.token ?? null,
        selection: picked ?? config.gitlab?.selection ?? null,
      }
      save()
      logger?.info(`gitlab: settings saved (baseUrl ${normalized}, token ${tokenChanged ? 'updated' : 'unchanged'})`)
      return this.getSettings()
    },
    discover(input) {
      const api = client()
      if (input?.group !== undefined) return api.discoverGroup(input.group)
      if (input?.repos !== undefined) {
        const list = Array.isArray(input.repos) ? input.repos.map((r) => String(r).trim()).filter(Boolean) : []
        if (list.length === 0) throw new GitLabError('repos must be a non-empty list', 'GITLAB_BAD_REQUEST', 400)
        return api.resolveRepos(list)
      }
      throw new GitLabError('discover needs {group} or {repos}', 'GITLAB_BAD_REQUEST', 400)
    },
    verify() {
      return client().verifyToken()
    },
  }
}
