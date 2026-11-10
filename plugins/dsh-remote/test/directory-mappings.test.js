import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ssh2 from 'ssh2'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import { mountClient } from './harness/render.js'
import shell from '../lib/remote-shell-child.cjs'

test('picker mkdir creates one directory on the selected server and reports SFTP failures', { timeout: 15000 }, async t => {
  const selected = await startFakeSsh({ fs: { '/projects/readme': 'selected', '/C:/readme': 'drive root' } })
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

test('the workspace picker lists SSH config aliases and saves only the selected host', { timeout: 5000 }, async t => {
  const ssh = await startFakeSsh({ fs: { '/projects/app/readme.txt': 'fixture' } })
  t.after(() => ssh.close())
  const host = await createHost()
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
  const contents = `Host vscode-dev vscode-other\n  HostName 127.0.0.1\n  User fixture\n  Port ${ssh.port}\n  IdentityFile "${keyFile}"\n`
  writeFileSync(sshConfig, contents)

  let reportListing
  const listing = new Promise(resolve => { reportListing = resolve })
  const ui = mountClient({ fetch: async (url, opts) => {
    const route = url.split('?')[0]
    const result = await host.call(route, { method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : {} })
    if (route === '/dsh-remote/ls') reportListing(result)
    return { ok: result.status === 200, status: result.status, json: async () => result.json }
  } })
  t.after(() => ui.dispose())
  const picker = ui.component('sidebar.workspaces.directoryFlow')
  const render = () => ui.settleComponent(picker, { open: true, onPicked() {}, onCancel() {} })
  const select = tree => ui.elements(tree).find(node => node.type === 'select')
  const options = tree => ui.elements(select(tree)).filter(node => node.type === 'option').map(node => node.props.value)
  let tree = await render()
  ui.button(tree, /^远程$/).el.props.onClick()
  tree = await render()
  assert.deepEqual(options(tree), ['', 'ssh:vscode-dev', 'ssh:vscode-other'])
  assert.deepEqual(host.readMachines(), [])

  await select(tree).props.onChange({ target: { value: 'ssh:vscode-dev' } })
  tree = await render()
  const [saved, ...others] = host.readMachines()
  assert.equal(saved.host, 'vscode-dev')
  assert.equal(saved.useSshConfig, true)
  assert.deepEqual(others, [])
  assert.equal(host.readRegistry().currentId, saved.id)
  assert.equal(select(tree).props.value, 'machine:' + saved.id)
  assert.deepEqual(options(tree), ['', 'machine:' + saved.id, 'ssh:vscode-other'])
  assert.equal(readFileSync(sshConfig, 'utf8'), contents)
  const listed = await listing
  assert.equal(listed.status, 200, listed.raw)
  assert(listed.json.items.some(entry => entry.name === 'projects'))
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
  } finally {
    await host?.dispose()
    await promptFiber?.dispose()
    await ssh.close()
  }
})
