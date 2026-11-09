import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import shell from '../lib/remote-shell-child.cjs'

test('explicit mappings route existing checkouts and preserve the mirror workflow', async () => {
  const ssh = await startFakeSsh({ cwd: '/projects', fs: {
    '/projects/alpha/changed.txt': 'linux version',
    '/projects/alpha/same.txt': 'same bytes',
    '/projects/beta/log.txt': 'beta log',
  } })
  const server = machine({ id: 'server', host: '127.0.0.1', port: ssh.port, username: 'root', password: 'fixture' })
  const otherServer = machine({ id: 'other', host: '127.0.0.2', port: 22, username: 'root' })
  let host
  try {
    host = await createHost({ machines: [server, otherServer] })
    const local = path.join(host.home, 'existing-checkout')
    const other = path.join(host.home, 'another-checkout')
    mkdirSync(local)
    mkdirSync(other)
    mkdirSync(path.join(local, '.git'))
    writeFileSync(path.join(local, 'changed.txt'), 'windows version')
    writeFileSync(path.join(local, 'same.txt'), 'same bytes')
    writeFileSync(path.join(local, 'new.txt'), 'new local file')

    const save = (body) => host.call('/dsh-remote/mappings', { body: { action: 'save', machineId: server.id, ...body } })
    const invalid = await save({ localPath: local, remotePath: '/missing' })
    assert.equal(invalid.status, 400)
    const create = await save({ localPath: local, remotePath: '/projects/alpha' })
    assert.equal(create.status, 200, create.raw)
    const alpha = create.json.mapping
    const beta = (await save({ localPath: other, remotePath: '/projects/beta' })).json.mapping
    assert.equal((await host.call('/dsh-remote/mappings', { method: 'GET' })).json.mappings.length, 2)
    assert.equal((await save({ localPath: local, remotePath: '/projects/alpha' })).json.mapping.id, alpha.id)
    const conflict = await save({ localPath: local, remotePath: '/projects/beta' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.conflict.id, alpha.id)
    assert.equal(conflict.json.replaceable, true)
    assert.equal(existsSync(path.join(local, '.dsh-remote-meta.json')), false)
    assert.equal(existsSync(path.join(local, '.dsh-remote-sync-state.json')), false)
    assert.equal(readFileSync(path.join(local, 'changed.txt'), 'utf8'), 'windows version')

    const resolve = (folder) => host.call('/dsh-remote/resolve-mirror?local=' + encodeURIComponent(folder), { method: 'GET' })
    assert.equal((await resolve(local)).json.remotePath, '/projects/alpha')
    assert.equal((await resolve(other)).json.remotePath, '/projects/beta')
    assert.equal(shell.resolveTarget({ cwd: local, machines: host.registryFile }).target.remotePath, '/projects/alpha')

    const exec = { agent: { id: 'session', session: { header: { cwd: local } } }, signal: new AbortController().signal }
    const run = (tool, args) => host.tool(tool).execute(args, exec)
    assert.equal(host.tools.size, 21)
    const preview = await run('rw_push', { dryRun: true })
    assert.match(preview.text, /conflict/)
    const pushed = await run('rw_push', {})
    assert.match(pushed.text, /conflict/)
    const read = (filename) => host.call('/dsh-remote/read?local=' + encodeURIComponent(local) + '&path=' + encodeURIComponent(filename), { method: 'GET' })
    assert.equal((await read('/projects/alpha/new.txt')).json.content, 'new local file')
    assert.equal((await read('/projects/alpha/changed.txt')).json.content, 'linux version')
    assert.match((await run('rw_sync', {})).text, /conflict/)
    assert.equal(readFileSync(path.join(local, 'changed.txt'), 'utf8'), 'windows version')
    assert.equal(existsSync(path.join(local, '.dsh-remote-sync-state.json')), false)
    assert.match((await run('rw_exec', { command: 'echo mapped' })).text, /mapped/)
    assert(ssh.execLog.some(command => command.includes("'/projects/alpha'") && command.includes('echo mapped')))

    const edit = await save({ ...alpha, remotePath: '/projects/beta' })
    assert.equal(edit.status, 200)
    assert.equal((await resolve(local)).json.remotePath, '/projects/beta')
    const stale = await host.call('/dsh-remote/mappings', { body: { action: 'remove', id: alpha.id, revision: alpha.revision } })
    assert.equal(stale.status, 409)
    const removed = await host.call('/dsh-remote/mappings', { body: { ...edit.json.mapping, action: 'remove' } })
    assert.equal(removed.status, 200)
    assert.equal((await resolve(local)).json.mode, 'local')
    assert(existsSync(path.join(local, '.git')))
    assert(existsSync(path.join(local, 'changed.txt')))
    assert.equal((await resolve(other)).json.remotePath, beta.remotePath)
    assert.equal(host.routes.has('/dsh-remote/web-attach'), false)
    assert.equal(host.routes.has('/dsh-remote/update-check'), false)
    assert.equal(host.routes.has('/dsh-remote/telemetry'), false)
    assert.equal(host.routes.has('/dsh-remote/forwards'), true)
    assert.equal(host.routes.has('/dsh-remote/audit'), true)

    await host.call('/dsh-remote/current', { body: { id: server.id } })
    const mirror = await host.call('/dsh-remote/mirror', { body: { machineId: server.id, path: '/projects/alpha' } })
    assert.equal(mirror.status, 200, mirror.raw)
    assert(existsSync(path.join(mirror.json.localMirror, '.dsh-remote-meta.json')))
    assert.equal((await resolve(mirror.json.localMirror)).json.remotePath, '/projects/alpha')
  } finally {
    await host?.dispose()
    await ssh.close()
  }
})
