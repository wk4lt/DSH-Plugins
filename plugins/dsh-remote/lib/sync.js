// dsh-remote — remote-wins mirror pulls and three-way mirror pushes.
//
// To protect remote changes during pushes, we keep a per-mirror snapshot of the
// last-synced remote state (`.dsh-remote-sync-state.json`: relPath →
// {mtime,size}) and compare remote (R), local (L) and last-synced (S):
//
//   R==S && L==S          → unchanged, skip
//   R!=S && L==S          → remote changed → push conflict unless forced
//   R==S && L!=S          → local changed → normal upload
//   R!=S && L!=S && R!=L  → both changed → push conflict unless forced
//
// `dryRun: true` computes the full plan without writing anything.
// After a successful pull the local mtime is aligned to the remote mtime, and
// after a successful push the local mtime is aligned to the remote mtime the
// server assigned — so the invariant L==R==S holds and the next run is cheap.
import { chmodSync, readdirSync, lstatSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, utimesSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { joinRemotePath, relPathUnder } from './paths.js'

function mapLimit(items, limit, fn) {
  const limitN = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { await fn(items[i], i) } catch { /* per-item errors are the fn's concern */ }
    }
  }
  const workers = []
  for (let w = 0; w < limitN; w++) workers.push(worker())
  return Promise.all(workers)
}

const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`
const localKey = (st) => (st ? keyOf(st.size, st.mtimeMs / 1000) : null)
const remoteKey = (st) => (st ? keyOf(st.size, st.mtime) : null)

// A mapped checkout can already have files on both sides when there is no baseline.
async function sameFile(sftp, remote, local, remoteStat, localStat) {
  if (remoteStat.size !== localStat.size) return false
  try { return readFileSync(local).equals(await sftp.readFile(remote)) } catch { return false }
}

function alignMtime(local, remoteStat) {
  try { utimesSync(local, new Date(remoteStat.mtime * 1000), new Date(remoteStat.mtime * 1000)) } catch { /* best effort */ }
}

const usableLocalName = name => !!name && name !== '.' && name !== '..'
  && !/[\/\\\x00]/.test(name)
  && (process.platform !== 'win32' || !/[<>:"|?*]|[ .]$/.test(name))

function localEntryMatches(local, directory) {
  try {
    const stat = lstatSync(local)
    return directory ? stat.isDirectory() : stat.isFile()
  } catch (error) {
    return error.code === 'ENOENT'
  }
}

/** Resolve a mirror-relative download path and check every existing component. */
export function localDownloadPath(base, relative, directory) {
  const names = relative ? relative.split('/') : []
  let local = base
  if (!localEntryMatches(base, true) || (!directory && !names.length)) {
    throw new Error(`Expected a local directory at ${base}`)
  }
  for (const [i, name] of names.entries()) {
    if (!usableLocalName(name)) throw new Error(`Invalid local download name: ${name}`)
    local = path.join(local, name)
    const isDirectory = i < names.length - 1 || directory
    if (!localEntryMatches(local, isDirectory)) {
      throw new Error(`Expected a local ${isDirectory ? 'directory' : 'file'} at ${local}`)
    }
  }
  return local
}

export async function downloadFile(sftp, remote, local, remoteStat) {
  const previous = lstatSync(local, { throwIfNoEntry: false })
  if (previous && !previous.isFile()) throw new Error(`Expected a local file at ${local}`)
  const temporary = path.join(path.dirname(local), '.dsh-remote-download-' + randomUUID() + '.tmp')
  try {
    await sftp.fastGet(remote, temporary)
    if (previous) chmodSync(temporary, previous.mode & 0o777)
    alignMtime(temporary, remoteStat)
    renameSync(temporary, local)
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

/** Recursively pull remote files into the local mirror. */
export async function syncTree(sftp, remoteDir, localDir, opts = {}) {
  const {
    maxDepth = 8,
    maxFiles = 2000,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    state = {},
    workspaceRoot = remoteDir,
  } = opts
  const stats = { files: 0, bytes: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, errors: [], touched: [], truncated: false }
  const nextState = { ...state }
  let pending = 0
  const recordError = (path, error) => stats.errors.push({ path, reason: String(error.message || error), code: error.code })
  const recordPathError = (path, directory) => stats.errors.push({
    path, reason: directory ? 'expected a safe local directory path' : 'expected a safe local file path', code: 'LOCAL_PATH',
  })

  const walk = async (rDir, lDir, depth) => {
    let entries
    try {
      entries = await sftp.readdir(rDir) || []
      if (!dryRun) mkdirSync(lDir, { recursive: true })
    } catch (error) {
      recordError(rDir, error)
      return
    }
    // Directories first (sequential, depth-bounded) so every file has a home.
    for (const e of entries) {
      const name = String(e.filename)
      if (name === '.' || name === '..') continue
      const isDir = !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())
      if (!isDir) continue
      const rp = joinRemotePath(rDir, name)
      const lp = path.join(lDir, name)
      const rel = relPathUnder(workspaceRoot, rp)
      if (rel !== null && isIgnored(rel, true)) continue
      if (rel === null || !usableLocalName(name) || !localEntryMatches(lp, true)) {
        recordPathError(rp, true)
        continue
      }
      if (depth <= 0) {
        stats.truncated = true
        continue
      }
      await walk(rp, lp, depth - 1)
      stats.dirs++
    }

    const files = entries.filter(
      (e) => !(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()) &&
        String(e.filename) !== '.' && String(e.filename) !== '..',
    )
    await mapLimit(files, 4, async (e) => {
      const name = String(e.filename)
      const rp = joinRemotePath(rDir, name)
      const lp = path.join(lDir, name)
      const rel = relPathUnder(workspaceRoot, rp)
      if (rel === null || !usableLocalName(name)) {
        recordPathError(rp, false)
        return
      }
      if (isIgnored(rel, false)) return
      try {
        const l = lstatSync(lp, { throwIfNoEntry: false })
        if (l && !l.isFile()) {
          recordPathError(rp, false)
          return
        }
        const r = await sftp.stat(rp)
        if (!r.isFile()) throw new Error('expected a regular remote file')
        if (maxFileBytes > 0 && r.size > maxFileBytes) { stats.skippedLarge++; return }
        const rk = remoteKey(r)
        const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
        const lk = localKey(l)
        if (sk && rk === sk && lk === sk && await sameFile(sftp, rp, lp, r, l)) {
          stats.skippedUnchanged++
          return
        }
        if (stats.files + pending >= maxFiles) { stats.truncated = true; return }
        pending++
        try {
          if (!dryRun) await downloadFile(sftp, rp, lp, r)
          stats.files++
          stats.bytes += r.size
          stats.touched.push(rp)
          nextState[rel] = { size: r.size, mtime: r.mtime }
        } finally {
          pending--
        }
      } catch (error) {
        recordError(rp, error)
      }
    })
  }

  localDownloadPath(localDir, '', true)
  await walk(remoteDir, localDir, maxDepth)
  return { stats, nextState }
}

/** Recursively push local mirror → remote (three-way, ignore-aware). */
export async function pushTree(sftp, localDir, remoteDir, opts = {}) {
  const {
    maxFiles = 2000,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    force = false,
    state = {},
    protectExisting = false,
  } = opts
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, conflicts: [], staleLocal: 0, pushed: [], truncated: false }
  const nextState = { ...state }

  const walk = async (lDir, rDir) => {
    const entries = readdirSync(lDir, { withFileTypes: true }).filter(
      (e) => e.name !== '.dsh-remote-meta.json' && e.name !== '.dsh-remote-sync-state.json',
    )
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (stats.files >= maxFiles) break
      const rp = joinRemotePath(rDir, e.name)
      const rel = relPathUnder(remoteDir, rp) || e.name
      if (isIgnored(rel, true)) continue
      if (!dryRun) { try { await sftp.mkdir(rp) } catch { /* already exists */ } }
      stats.dirs++
      await walk(path.join(lDir, e.name), rp)
      if (stats.files >= maxFiles) break
    }
    if (stats.files >= maxFiles) { stats.truncated = true; return }

    const files = entries.filter((e) => !e.isDirectory())
    await mapLimit(files, 4, async (e) => {
      if (stats.files >= maxFiles) { stats.truncated = true; return }
      const lp = path.join(lDir, e.name)
      const rp = joinRemotePath(rDir, e.name)
      const rel = relPathUnder(remoteDir, rp) || e.name
      if (isIgnored(rel, false) || (protectExisting && !e.isFile())) return
      let l
      try { l = statSync(lp) } catch { return }
      if (maxFileBytes > 0 && l.size > maxFileBytes) { stats.skippedLarge++; return }
      const lk = localKey(l)
      let r = null
      try { r = await sftp.stat(rp) } catch { /* absent → upload */ }
      const rk = remoteKey(r)
      const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
      if (protectExisting && r && !force && !sk) {
        if (!await sameFile(sftp, rp, lp, r, l)) {
          stats.conflicts.push({ path: rp, reason: 'local and remote files differ before the first push' })
        } else {
          if (!dryRun) alignMtime(lp, r)
          nextState[rel] = { size: r.size, mtime: r.mtime }
          stats.skippedUnchanged++
        }
        return
      }
      if (r && sk && lk === sk && rk === sk) { stats.skippedUnchanged++; return }
      if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
        stats.conflicts.push({ path: rp, reason: 'both-modified（远端与本地都改过，跳过不覆盖）' })
        return
      }
      if (r && !force && sk && rk !== sk && lk === sk) {
        stats.conflicts.push({ path: rp, reason: 'remote-modified（远端改过而本地未变；如需覆盖请用 force / 先 rw_sync）' })
        return
      }
      if (r && !force && sk && rk === sk && lk && lk !== sk) {
        // Normal case: local edited since sync, remote untouched → push.
      }
      if (dryRun) {
        stats.files++
        stats.pushed.push(rp)
        return
      }
      try {
        const buf = readFileSync(lp)
        await sftp.writeFile(rp, buf)
        // Align local mtime to whatever the remote server assigned, so the
        // L==R==S invariant holds for the next run.
        let r2 = null
        try { r2 = await sftp.stat(rp) } catch {}
        const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
        try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
        stats.files++
        stats.pushed.push(rp)
        nextState[rel] = { size: l.size, mtime: rmt }
      } catch { /* skip unwritable */ }
    })
  }

  await walk(localDir, remoteDir)
  if (stats.files >= maxFiles) stats.truncated = true
  for (const rel of Object.keys(state)) {
    if (state[rel] && !nextState[rel]) stats.staleLocal++
  }
  return { stats, nextState }
}

/** Load the sync-state snapshot from a mirror dir (or {}). */
export function loadSyncState(localDir, file = path.join(localDir, '.dsh-remote-sync-state.json')) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Persist the snapshot (atomic-ish: tmp + rename). */
export function saveSyncState(localDir, state, file = path.join(localDir, '.dsh-remote-sync-state.json')) {
  const temporary = file + '.tmp-' + randomUUID()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(state, null, 1))
    renameSync(temporary, file)
  } catch { /* best effort */ } finally {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

/** Push ONE local mirror file back to the remote (used by auto-push).
 * Same three-way guard as pushTree: never clobbers a remote change. Returns
 * { status: 'pushed'|'unchanged'|'conflict'|'skipped'|'missing' } and the
 * updated state delta ({rel: {size, mtime}} when pushed). */
export async function pushOneFile(sftp, localDir, remoteDir, rel, opts = {}) {
  const { maxFileBytes = 0, isIgnored = () => false, force = false, state = {}, protectExisting = false } = opts
  if (isIgnored(rel, false)) return { status: 'skipped' }
  const lp = path.join(localDir, rel.replace(/\//g, path.sep))
  const rp = joinRemotePath(remoteDir, rel)
  if (protectExisting) {
    let current = localDir
    for (const part of rel.split('/').slice(0, -1)) {
      current = path.join(current, part)
      if (!usableLocalName(part) || !localEntryMatches(current, true)) return { status: 'skipped' }
    }
    if (!usableLocalName(path.basename(lp)) || !localEntryMatches(lp, false)) return { status: 'skipped' }
  }
  let l
  try { l = statSync(lp) } catch { return { status: 'missing' } }
  if (maxFileBytes > 0 && l.size > maxFileBytes) return { status: 'skipped' }
  const lk = localKey(l)
  let r = null
  try { r = await sftp.stat(rp) } catch { /* absent → upload */ }
  const rk = remoteKey(r)
  const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
  if (protectExisting && r && !force && !sk) {
    if (!await sameFile(sftp, rp, lp, r, l)) return { status: 'conflict', reason: 'no sync baseline' }
    alignMtime(lp, r)
    return { status: 'unchanged', state: { [rel]: { size: r.size, mtime: r.mtime } } }
  }
  if (r && sk && lk === sk && rk === sk) return { status: 'unchanged' }
  if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
    return { status: 'conflict', reason: 'both-modified' }
  }
  if (r && !force && sk && rk !== sk && lk === sk) {
    return { status: 'conflict', reason: 'remote-modified' }
  }
  try {
    await sftp.writeFile(rp, readFileSync(lp))
    let r2 = null
    try { r2 = await sftp.stat(rp) } catch {}
    const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
    try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
    return { status: 'pushed', state: { [rel]: { size: l.size, mtime: rmt } } }
  } catch (e) {
    return { status: 'skipped', error: String((e && e.message) || e) }
  }
}
