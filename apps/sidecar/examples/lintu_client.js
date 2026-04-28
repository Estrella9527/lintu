/**
 * 灵图 Open API v1 — Node SDK Demo (zero-dep, Node 18+ uses built-in fetch)
 *
 * Usage:
 *   import { LintuClient } from './lintu_client.js'
 *   const lintu = new LintuClient({
 *     baseUrl: 'https://api.your-domain.com',
 *     token:   'lk_live_xxx.your_secret',
 *   })
 *   const stats = await lintu.stats()
 *   console.log(stats)
 *
 * For browser (H5) use, see "H5 集成" in docs/open-api-guide.md — short
 * version: do NOT put the secret in JS shipped to the browser. Run this
 * client in your H5 product's BACKEND, expose a thin proxy to the page.
 */

export class LintuAPIError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`)
    this.name = 'LintuAPIError'
    this.status = status
    this.body = body
  }
}

export class LintuClient {
  /**
   * @param {{ baseUrl: string, token: string, timeoutMs?: number }} opts
   */
  constructor({ baseUrl, token, timeoutMs = 30000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '') + '/open-api/v1'
    this.token = token
    this.timeoutMs = timeoutMs
  }

  async _request(method, path, { params, body, accept = 'application/json' } = {}) {
    let url = this.baseUrl + path
    if (params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v == null) continue
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)))
        else qs.set(k, String(v))
      }
      const s = qs.toString()
      if (s) url += '?' + s
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const resp = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!resp.ok) {
        throw new LintuAPIError(resp.status, await resp.text())
      }
      if (accept === 'application/json') return await resp.json()
      return new Uint8Array(await resp.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Endpoints ──

  health() { return this._request('GET', '/health') }
  stats(projectId) { return this._request('GET', '/stats', { params: { project_id: projectId } }) }

  /** @param {{ project_id?: string, source_type?: string, scene?: string[], season?: string[], offset?: number, limit?: number }} q */
  listImages(q = {}) { return this._request('GET', '/images', { params: q }) }

  getImage(id) { return this._request('GET', `/images/${id}`) }
  listDerivatives(id) { return this._request('GET', `/images/${id}/derivatives`) }
  downloadImage(id, { size } = {}) {
    return this._request('GET', `/images/${id}/file`, {
      params: size ? { size } : undefined, accept: 'image/jpeg',
    })
  }

  listTags({ projectId, dimension } = {}) {
    return this._request('GET', '/tags', { params: { project_id: projectId, dimension } })
  }

  matrix(projectId, { row = 'scene', col = 'season' } = {}) {
    return this._request('GET', '/matrix', { params: { project_id: projectId, row, col } })
  }

  listBatches({ projectId, status } = {}) {
    return this._request('GET', '/batches', { params: { project_id: projectId, status } })
  }
  getBatch(id) { return this._request('GET', `/batches/${id}`) }

  submitBatch(body) {
    // body: { project_id, name, task_type, seed_image_ids, prompt_ids, concurrency?, max_retry?, budget_usd? }
    return this._request('POST', '/batches', { body })
  }
}

// ── Demo when run directly ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.LINTU_BASE || 'http://localhost:7879'
  const token = process.env.LINTU_TOKEN
  if (!token) {
    console.error('Set LINTU_TOKEN=lk_live_xxx.secret first')
    process.exit(1)
  }
  const c = new LintuClient({ baseUrl: base, token })
  console.log('health:', await c.health())
  console.log('stats:', await c.stats())
  const images = await c.listImages({ limit: 3 })
  console.log(`got ${images.total} images, first 3:`)
  for (const img of images.items) {
    console.log(`  ${img.id}  ${img.file_name}  ${img.width}x${img.height}`)
  }
}
