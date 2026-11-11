import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ssh2 from 'ssh2'
import { baseSshArgs } from '../lib/openssh.js'
import { ensurePrivateSshConfig } from '../lib/private-ssh-config.cjs'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import shell from '../lib/remote-shell-child.cjs'

test('picker mkdir creates one directory on the selected server and reports SFTP failures', { timeout: 15000 }, async t => {
  const selected = await startFakeSsh({ cwd: '/home/fixture user', fs: {
    '/home/fixture user/project/readme': 'home', '/projects/readme': 'selected', '/C:/readme': 'drive root',
  } })
  t.after(() => selected.close())
  const other = await startFakeSsh({ fs: { '/projects/readme': 'other' } })
  t.after(() => other.close())
  const host = await createHost({
    machines: [
      machine(selected.machine({ id: 'selected' })),
      machine(other.machine({ id: 'other' })),
    ],
    currentId: 'other',
  })
  t.after(() => host.dispose())

  const mkdir = (name, overrides = {}) => host.call('/dsh-remote/fs', {
    body: { op: 'mkdir', machineId: 'selected', path: '/projects', name, ...overrides },
  })
  const list = path => host.call('/dsh-remote/ls?' + new URLSearchParams({ machineId: 'selected', path }), { method: 'GET' })
  const home = await host.call('/dsh-remote/home', { body: { machineId: 'selected' } })
  assert.equal(home.status, 200, home.raw)
  assert.equal(home.json.home, '/home/fixture user')
  assert((await list(home.json.home)).json.items.some(item => item.name === 'project'))
  assert.equal((await host.call('/dsh-remote/home', { body: { machineId: 'missing' } })).status, 404)
  assert.equal(host.readRegistry().currentId, 'other')
  const name = '进度 100%'
  const created = await mkdir(name)
  assert.equal(created.status, 200, created.raw)
  assert.equal(selected.fs.get('/projects/' + name)?.type, 'dir')
  assert.equal(other.fs.has('/projects/' + name), false)
  assert.equal(host.readRegistry().currentId, 'other')
  const parent = await list('/projects')
  assert.equal(parent.json.machine.id, 'selected')
  assert(parent.json.items.some(item => item.name === name && item.type === 'dir'))
  const child = await list('/projects/' + name)
  assert.equal(child.status, 200, child.raw)
  assert.equal(child.json.path, '/projects/' + name)
  assert.equal(child.json.missing, false)

  assert.equal((await mkdir(name)).status, 409)
  assert.equal((await mkdir('nested/child')).status, 400)
  assert.equal((await mkdir('child', { path: '' })).status, 400)
  assert.equal((await mkdir('child', { machineId: 'missing' })).status, 404)
  assert.equal((await mkdir('windows-child', { path: 'C:\\' })).status, 200)
  assert.equal(selected.fs.get('/C:/windows-child')?.type, 'dir')

  selected.fs.mkdir = () => { throw new Error('fixture rejected mkdir') }
  const denied = await mkdir('denied')
  assert.equal(denied.status, 500, denied.raw)
  assert.equal(denied.json.ok, false)
  assert.match(denied.json.error, /Failure/)
  assert.equal(selected.fs.has('/projects/denied'), false)
})

test('SSH aliases are imported explicitly and connections use saved settings', { timeout: 10000 }, async t => {
  const ssh = await startFakeSsh({ fs: { '/projects/app/readme.txt': 'fixture' } })
  t.after(() => ssh.close())
  const normal = machine(ssh.machine({ id: 'normal', username: 'fixture' }))
  const legacy = machine({ id: 'legacy', host: 'vscode-dev', username: 'fixture', useSshConfig: true, workspace: '/projects/app' })
  const host = await createHost({ machines: [normal, legacy] })
  t.after(() => host.dispose())
  const previous = process.env.DSH_REMOTE_SSH_CONFIG
  const sshConfig = path.join(host.home, 'ssh-config')
  process.env.DSH_REMOTE_SSH_CONFIG = sshConfig
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_REMOTE_SSH_CONFIG
    else process.env.DSH_REMOTE_SSH_CONFIG = previous
  })

  const importHost = { action: 'from-ssh-config', alias: 'vscode-dev' }
  assert.equal((await host.call('/dsh-remote/machines', { body: importHost })).status, 404)
  const keyFile = path.join(host.home, 'fixture-key')
  writeFileSync(keyFile, ssh2.utils.generateKeyPairSync('ed25519').private, { mode: 0o600 })
  const contents = [
    'Host 127.0.0.1', '  HostName 192.0.2.2', '  Port 1',
    'Host vscode-dev vscode-other', '  HostName 127.0.0.1', '  User fixture',
    '  Port ' + ssh.port, '  IdentityFile "' + keyFile + '"', '',
    'Host command-proxy', '  ProxyCommand arbitrary-config-command', '',
  ].join('\n')
  writeFileSync(sshConfig, contents)

  const listDir = id => host.call('/dsh-remote/ls', { method: 'GET', url: '/dsh-remote/ls?path=/projects&machineId=' + id })
  assert.equal((await listDir('legacy')).status, 409)
  assert.equal((await listDir('normal')).status, 200)
  const unsupported = await host.call('/dsh-remote/machines', { body: { ...importHost, alias: 'command-proxy' } })
  assert.equal(unsupported.status, 422)
  assert.equal(host.readMachines().length, 2)
  const probe = await host.call('/dsh-remote/test-connect', { body: { id: 'normal' } })
  assert.equal(probe.json.ok, true, probe.raw)
  const currentId = host.readRegistry().currentId
  const imported = await host.call('/dsh-remote/machines', { body: importHost })
  assert.equal(imported.status, 200, imported.raw)
  const saved = host.readMachines().find(item => item.id === 'legacy')
  assert.equal(saved.host, '127.0.0.1')
  assert.equal(saved.port, ssh.port)
  assert.equal(saved.username, 'fixture')
  assert.equal(saved.privateKeyPath, keyFile)
  assert.equal(saved.workspace, '/projects/app')
  assert.equal(saved.useSshConfig, undefined)
  assert.equal(host.readRegistry().currentId, currentId)
  assert.equal(readFileSync(sshConfig, 'utf8'), contents)

  const changed = contents.replace('HostName 127.0.0.1', 'HostName 192.0.2.3')
  writeFileSync(sshConfig, changed)
  const listing = await listDir('legacy')
  assert.equal(listing.status, 200, listing.raw)
  assert(listing.json.items.some(entry => entry.name === 'app'))
  const anchor = path.join(path.dirname(host.registryFile), 'legacy-host', 'app')
  mkdirSync(anchor, { recursive: true })
  writeFileSync(path.join(anchor, '.dsh-remote-meta.json'), JSON.stringify({
    machineId: legacy.id, alias: legacy.host, host: saved.host, port: saved.port, username: saved.username, remotePath: '/projects/app',
  }))
  const workspace = shell.resolveTarget({ cwd: anchor, machines: host.registryFile })
  assert.equal(workspace.machine.id, legacy.id)
  const sshConfigFile = ensurePrivateSshConfig(path.dirname(host.registryFile))
  const sharedArgs = ['-F', sshConfigFile, '-o', 'HostName=127.0.0.1', '-p', String(ssh.port), '-l', 'fixture', '-i', keyFile]
  assert.deepEqual(baseSshArgs({ ...saved, sshConfigFile }).slice(0, sharedArgs.length), sharedArgs)
  assert.deepEqual(shell.buildSshArgs(workspace.target, workspace.machine, sshConfigFile).slice(1, sharedArgs.length + 1), sharedArgs)
  const files = await host.tool('rw_list_dir').execute({}, { agent: { session: { header: { cwd: anchor } } } })
  assert.match(files.text, /readme\.txt/)
  const edited = await host.call('/dsh-remote/machines', { body: { action: 'update', id: 'legacy', host: saved.host, port: saved.port, username: saved.username } })
  assert.equal(edited.status, 200, edited.raw)
  assert.equal(readFileSync(sshConfig, 'utf8'), changed)
  const deleted = await host.call('/dsh-remote/machines', { body: { action: 'delete', id: 'legacy' } })
  assert.equal(deleted.status, 200, deleted.raw)
  assert.deepEqual(deleted.json.machines.map(item => item.id), ['normal'])
  assert.equal(readFileSync(sshConfig, 'utf8'), changed)
})

test('explicit mappings route existing checkouts and preserve the mirror workflow', async () => {
  const ssh = await startFakeSsh({ cwd: '/projects', fs: {
    '/projects/alpha/changed.txt': 'linux version',
    '/projects/alpha/same.txt': 'same bytes',
    '/projects/beta/log.txt': 'beta log',
  } })
  const server = machine({ id: 'server', host: '127.0.0.1', port: ssh.port, username: 'root', password: 'fixture' })
  const otherServer = machine({ id: 'other', host: '127.0.0.2', port: 22, username: 'root' })
  let host
  let promptFiber
  try {
    const promptHost = new Context()
    promptFiber = await promptHost.plugin(SystemPrompt, { includeRuntimeContext: false })
    const systemPrompt = promptHost.systemPrompt
    systemPrompt.context({
      name: 'working-directory:current',
      order: systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      text: ({ agent }) => 'Current working directory: ' + JSON.stringify(agent.session.header.cwd) + '.',
    })
    systemPrompt.section({ name: 'test-preset', order: 0, complete: true, text: 'Test preset' })
    const runtimeContext = async cwd => {
      const context = { agent: { session: { header: { cwd } } } }
      const assembly = await systemPrompt.assemble(context)
      return renderContextSnapshot(systemPrompt.refreshContext(assembly, context))
    }
    const sessions = new Map()
    host = await createHost({ machines: [server, otherServer], services: { systemPrompt, sessions: { get: id => sessions.get(id) } } })
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
    const openMapping = async mapping => {
      const result = await host.call('/dsh-remote/mirror', { body: {
        machineId: mapping.machineId, path: mapping.remotePath, mappingId: mapping.id, mappingRevision: mapping.revision,
      } })
      assert.equal(result.status, 200, result.raw)
      return result.json.localMirror
    }
    const anchor = await openMapping(alpha)
    assert.notEqual(anchor, local)
    const mappedContext = await runtimeContext(anchor)
    assert.match(mappedContext, /Workspace mode: remote over SSH/)
    assert(mappedContext.includes('SSH host: root@127.0.0.1 (port ' + ssh.port + ').'))
    assert.match(mappedContext, /Remote working directory: "\/projects\/alpha"/)
    assert(mappedContext.includes('Local mirror checkout: ' + JSON.stringify(alpha.localPath)))
    assert.match(mappedContext, /Inspect the current workspace with rw_list_dir/)
    assert.doesNotMatch(await runtimeContext(local), /remote over SSH/)
    assert.doesNotMatch(await runtimeContext(other), /remote over SSH|\/projects\/alpha/)
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
    assert.equal((await resolve(local)).json.mode, 'local')
    assert.equal((await resolve(anchor)).json.remotePath, '/projects/alpha')
    assert.equal(shell.resolveTarget({ cwd: local, machines: host.registryFile }).found, false)
    assert.equal(shell.resolveTarget({ cwd: anchor, machines: host.registryFile }).target.remotePath, '/projects/alpha')

    const session = { id: 'session', header: { cwd: anchor } }
    sessions.set(session.id, session)
    const exec = { agent: { id: 'session', session }, signal: new AbortController().signal }
    const run = (tool, args) => host.tool(tool).execute(args, exec)
    assert.match((await run('rw_local_read_file', { path: 'changed.txt' })).text, /windows version/)
    assert.match((await run('rw_read_file', { path: 'changed.txt' })).text, /linux version/)
    const transfer = direction => host.call('/dsh-remote/sync-workspace', { body: { sessionId: session.id, direction } })
    const preview = await run('rw_push', { dryRun: true })
    assert.match(preview.text, /conflict/)
    assert.match((await transfer('push')).json.text, /conflict/)
    const read = (filename) => host.call('/dsh-remote/read?sessionId=session&path=' + encodeURIComponent(filename), { method: 'GET' })
    assert.equal((await read('/projects/alpha/new.txt')).json.content, 'new local file')
    assert.equal((await read('/projects/alpha/changed.txt')).json.content, 'linux version')
    assert.match((await transfer('pull')).json.text, /conflict/)
    assert.equal(readFileSync(path.join(local, 'changed.txt'), 'utf8'), 'windows version')
    assert.equal(existsSync(path.join(local, '.dsh-remote-sync-state.json')), false)
    assert.match((await run('rw_exec', { command: 'echo mapped' })).text, /mapped/)
    assert(ssh.execLog.some(command => command.includes("'/projects/alpha'") && command.includes('echo mapped')))

    const edit = await save({ ...alpha, remotePath: '/projects/beta' })
    assert.equal(edit.status, 200)
    const betaAnchor = await openMapping(edit.json.mapping)
    assert.notEqual(betaAnchor, anchor)
    assert.equal((await resolve(betaAnchor)).json.remotePath, '/projects/beta')
    assert.equal((await resolve(anchor)).json.remotePath, '/projects/alpha')
    assert.match((await run('rw_list_dir', {})).text, /changed\.txt/)
    assert.match((await transfer('push')).json.error, /directory mapping changed/)
    const historical = path.join(host.home, 'sessions', 'project', 'old-session')
    mkdirSync(historical, { recursive: true })
    writeFileSync(path.join(historical, 'session.v4.jsonl.zstd'), zstdCompressSync(JSON.stringify({ cwd: anchor }) + '\n'))
    assert.equal((await host.call('/dsh-remote/resolve-mirror?sessionId=old-session', { method: 'GET' })).json.remotePath, '/projects/alpha')
    const stale = await host.call('/dsh-remote/mappings', { body: { action: 'remove', id: alpha.id, revision: alpha.revision } })
    assert.equal(stale.status, 409)
    const removed = await host.call('/dsh-remote/mappings', { body: { ...edit.json.mapping, action: 'remove' } })
    assert.equal(removed.status, 200)
    assert.equal((await resolve(local)).json.mode, 'local')
    assert(existsSync(path.join(local, '.git')))
    assert(existsSync(path.join(local, 'changed.txt')))
    assert.equal((await resolve(await openMapping(beta))).json.remotePath, beta.remotePath)
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
    const mirrorContext = await runtimeContext(mirror.json.localMirror)
    assert.match(mirrorContext, /Remote working directory: "\/projects\/alpha"/)
    assert(mirrorContext.includes('Local mirror: ' + JSON.stringify(mirror.json.localMirror)))
    const remoteList = await host.tool('rw_list_dir').execute({}, {
      agent: { session: { header: { cwd: mirror.json.localMirror } } },
    })
    assert.match(remoteList.text, /changed\.txt/)

    const changedServer = await host.call('/dsh-remote/machines', { body: {
      ...server, action: 'update', host: '127.0.0.3',
    } })
    assert.equal(changedServer.status, 200, changedServer.raw)
    await assert.rejects(run('rw_list_dir', {}), { code: 'REMOTE_BINDING_CHANGED' })
    assert.equal((await read('/projects/alpha/changed.txt')).status, 409)
    unlinkSync(path.join(anchor, '.dsh-remote-meta.json'))
    await assert.rejects(run('rw_list_dir', {}), { code: 'REMOTE_BINDING_MISSING' })
    assert.equal((await resolve(anchor)).status, 409)
    assert.match(shell.resolveTarget({ cwd: anchor, machines: host.registryFile }).error, /binding is missing/)

    const deleteServer = () => host.call('/dsh-remote/machines', { body: { action: 'delete', id: server.id } })
    const deletion = await deleteServer()
    assert.equal(deletion.status, 200, deletion.raw)
    assert.equal(deletion.json.currentId, null)
    assert.deepEqual(deletion.json.machines.map(machine => machine.id), [otherServer.id])
    assert.equal((await deleteServer()).status, 404)
    assert.deepEqual((await host.call('/dsh-remote/mappings', { method: 'GET' })).json.mappings, [beta])
    assert(existsSync(path.join(mirror.json.localMirror, '.dsh-remote-meta.json')))
    assert.equal(readFileSync(path.join(local, 'changed.txt'), 'utf8'), 'windows version')
    await assert.rejects(host.tool('rw_list_dir').execute({}, {
      agent: { session: { header: { cwd: mirror.json.localMirror } } },
    }), /saved SSH server for this workspace is unavailable/)
  } finally {
    await host?.dispose()
    await promptFiber?.dispose()
    await ssh.close()
  }
})
