// Explicit mappings live in DSH's data directory, outside user checkouts.
const { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const mappingFile = root => path.join(root, 'directory-mappings.json')

function readMappings(root) {
  try {
    const records = JSON.parse(readFileSync(mappingFile(root), 'utf8'))
    if (!Array.isArray(records)) throw new Error('Invalid directory mappings file')
    return records
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function localDirectory(value) {
  const local = typeof value === 'string' ? value.trim() : ''
  if (!path.isAbsolute(local)) throw new Error('Choose an absolute local directory')
  const canonical = realpathSync(local)
  if (!statSync(canonical).isDirectory()) throw new Error('The local path must be a directory')
  return canonical
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function overlaps(left, right) {
  return contains(left, right) || contains(right, left)
}

function writeMappings(root, records) {
  mkdirSync(root, { recursive: true })
  const destination = mappingFile(root)
  const temporary = destination + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(records, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function saveMapping(root, { id, revision, localPath, remotePath, machineId }) {
  const local = localDirectory(localPath)
  // A checkout can be inside a link to DSH_HOME, so compare physical roots.
  let managedRoot = path.resolve(root)
  try { managedRoot = realpathSync(managedRoot) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (overlaps(managedRoot, local)) throw new Error('Choose a directory outside DSH-managed mirrors')

  const records = readMappings(root)
  const previous = records.find(record => record.id === id)
  if (id && (!previous || previous.revision !== revision)) {
    return { stale: true }
  }
  const conflict = records.find(record => record.id !== id && overlaps(record.localPath, local))
  if (conflict) {
    const replaceable = path.relative(conflict.localPath, local) === ''
    if (!id && replaceable && conflict.machineId === machineId && conflict.remotePath === remotePath) {
      return { mapping: conflict }
    }
    return { conflict, replaceable }
  }
  if (previous && previous.localPath === local && previous.remotePath === remotePath && previous.machineId === machineId) {
    return { mapping: previous }
  }
  const mapping = { id: previous?.id || randomUUID(), revision: randomUUID(), localPath: local, remotePath, machineId }
  writeMappings(root, [...records.filter(record => record.id !== id), mapping])
  return { mapping }
}

function removeMapping(root, id, revision) {
  const records = readMappings(root)
  const target = records.find(record => record.id === id)
  if (!target || target.revision !== revision) return false
  writeMappings(root, records.filter(record => record.id !== id))
  return true
}

function mappingForLocal(root, cwd) {
  if (!cwd) return undefined
  try {
    const local = localDirectory(cwd)
    return readMappings(root).find(record => contains(record.localPath, local))
  } catch {
    return undefined
  }
}

module.exports = { readMappings, localDirectory, saveMapping, removeMapping, mappingForLocal }
