import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountClient } from './harness/render.js'

const machine = { id: 'dev', name: '开发机', host: 'dev', username: 'me', port: 22 }
const mappings = [
  { id: 'a', revision: '1', machineId: 'dev', localPath: 'D:\\code\\api', remotePath: '/home/me/api' },
  { id: 'b', revision: '2', machineId: 'dev', localPath: 'D:\\code\\web', remotePath: '/home/me/web' },
]
const response = data => ({ ok: true, status: 200, json: async () => data })

test('manual refresh reports progress, completion, and failure and can be retried', async () => {
  let gate = null
  let fail = false
  let machines = [machine]
  const ui = mountClient({ fetch: async (url) => {
    if (gate) await gate
    if (fail) throw new Error('fixture refresh failed')
    if (url.endsWith('/machines')) return response({ machines })
    if (url.endsWith('/mappings')) return response({ mappings: [] })
    if (url.endsWith('/ssh-config')) return response({ entries: [] })
    throw new Error('unexpected request: ' + url)
  } })
  try {
    let tree = await ui.settle()
    let release
    gate = new Promise(resolve => { release = resolve })
    const pending = ui.button(tree, /^刷新$/).el.props.onClick()
    tree = await ui.settle()
    assert.equal(ui.button(tree, /^刷新中…$/).disabled, true)
    machines = [{ ...machine, name: '刷新后的开发机' }]
    gate = null
    release()
    await pending
    tree = await ui.settle()
    assert.match(ui.text(tree), /已刷新服务器和目录映射/)
    assert.match(ui.text(tree), /刷新后的开发机/)
    assert.equal(ui.button(tree, /^刷新$/).disabled, false)

    fail = true
    await ui.button(tree, /^刷新$/).el.props.onClick()
    tree = await ui.settle()
    assert.match(ui.text(tree), /fixture refresh failed/)
    assert(!ui.text(tree).includes('已刷新服务器和目录映射'))
    assert.equal(ui.button(tree, /^刷新$/).disabled, false)

    fail = false
    await ui.button(tree, /^刷新$/).el.props.onClick()
    tree = await ui.settle()
    assert(!ui.text(tree).includes('fixture refresh failed'))
    assert.match(ui.text(tree), /已刷新服务器和目录映射/)
  } finally {
    ui.dispose()
  }
})

test('settings has only the two requested sections with grouped mappings and editor dialogs', async () => {
  const ui = mountClient({ fetch: async (url) => {
    if (url.endsWith('/machines')) return response({ machines: [machine] })
    if (url.endsWith('/mappings')) return response({ mappings })
    if (url.endsWith('/ssh-config')) return response({ entries: [] })
    throw new Error('unexpected request: ' + url)
  } })
  try {
    let tree = await ui.settle()
    assert.deepEqual(ui.elements(tree).filter(node => node.type === 'section').map(node => node.props['aria-label']), ['远程服务器', '目录映射'])
    assert.match(ui.text(tree), /开发机 · 2/)
    for (const mapping of mappings) assert(ui.text(tree).includes(mapping.localPath + ' ↔ ' + mapping.remotePath))
    assert(!ui.text(tree).includes('端口转发'))
    ui.buttons(tree).find(button => button.label === '编辑').el.props.onClick()
    tree = await ui.settle()
    const serverEditor = ui.components(tree).find(node => node.type.name === 'SettingsEditor')
    assert.equal(serverEditor.props.title, '编辑机器')
    serverEditor.props.close()
    tree = await ui.settle()
    tree = await ui.click(tree, /^新增映射$/)
    const mappingEditor = ui.components(tree).find(node => node.type.name === 'SettingsEditor')
    assert.equal(mappingEditor.props.title, '新增映射')
    assert.equal(ui.elements(mappingEditor.props.children).find(node => node.type === 'select').props.value, 'dev')
  } finally {
    ui.dispose()
  }
})

test('an empty server list can add its first machine, edit it, and open mapping creation', async () => {
  let machines = []
  const saved = []
  const ui = mountClient({ fetch: async (url, opts) => {
    if (url.endsWith('/machines') && opts.method === 'POST') {
      const payload = JSON.parse(opts.body)
      saved.push(payload)
      machines = [{ ...payload, id: payload.id || 'new-server', password: undefined, passwordSet: !!payload.password }]
      return response({ machines, machine: machines[0] })
    }
    if (url.endsWith('/machines')) return response({ machines })
    if (url.endsWith('/mappings')) return response({ mappings: [] })
    if (url.endsWith('/ssh-config')) return response({ entries: [] })
    throw new Error('unexpected request: ' + url)
  } })
  const editor = tree => ui.components(tree).find(node => node.type.name === 'SettingsEditor')
  const changeField = (form, label, value) => {
    const row = ui.elements(form.props.children).find(node => node.type === 'label' && ui.text(node.props.children[0]) === label)
    assert(row, 'missing field: ' + label)
    ui.inputs(row)[0].onChange({ target: { value } })
  }
  try {
    let tree = await ui.settle()
    tree = await ui.click(tree, /^添加新机器$/)
    let form = editor(tree)
    assert.equal(form.props.title, '添加新机器')
    assert.equal(ui.button(form.props.footer, /^保存$/).disabled, true)
    changeField(form, '名称', '新服务器')
    changeField(form, '主机', '192.0.2.10')
    changeField(form, '密码', 'fixture-password')
    tree = await ui.settle()
    form = editor(tree)
    assert.equal(ui.button(form.props.footer, /^保存$/).disabled, false)
    await ui.button(form.props.footer, /^保存$/).el.props.onClick()
    tree = await ui.settle()
    assert.equal(editor(tree), undefined)
    assert.match(ui.text(tree), /新服务器/)
    assert.equal(saved[0].action, 'add')
    assert.equal(saved[0].port, 22)
    assert.equal(saved[0].username, 'root')
    assert.equal(saved[0].host, '192.0.2.10')

    tree = await ui.click(tree, /^编辑$/)
    form = editor(tree)
    assert.equal(form.props.title, '编辑机器')
    changeField(form, '名称', '已更新的服务器')
    tree = await ui.settle()
    await ui.button(editor(tree).props.footer, /^保存$/).el.props.onClick()
    tree = await ui.settle()
    assert.equal(saved[1].action, 'update')
    assert.equal(saved[1].id, 'new-server')
    assert.match(ui.text(tree), /已更新的服务器/)

    tree = await ui.click(tree, /^新增映射$/)
    form = editor(tree)
    assert.equal(form.props.title, '新增映射')
    assert.equal(ui.elements(form.props.children).find(node => node.type === 'select').props.value, 'new-server')
  } finally {
    ui.dispose()
  }
})

test('settings delete saved connections after confirmation and identify SSH config entries', async () => {
  const deleted = []
  let machines = [{ ...machine, useSshConfig: true }]
  let fail = true
  const ui = mountClient({ fetch: async (url, opts) => {
    if (url.endsWith('/machines') && opts.method === 'POST') {
      deleted.push(JSON.parse(opts.body))
      if (fail) return { ok: false, status: 500, json: async () => ({ error: 'fixture delete failed' }) }
      machines = []
      return response({ machines, currentId: null })
    }
    if (url.endsWith('/machines')) return response({ machines })
    if (url.endsWith('/mappings')) return response({ mappings })
    if (url.endsWith('/ssh-config')) return response({ entries: [
      { alias: machine.host, user: 'me', port: 22 }, { alias: 'ssh-only', user: 'me', port: 22 },
    ] })
    throw new Error('unexpected request: ' + url)
  } })
  try {
    const remove = async (tree, answer) => {
      const pending = ui.button(tree, /^删除$/).el.props.onClick()
      const confirming = await ui.settle()
      const dialog = ui.components(confirming).find(node => node.type.name === 'ConfirmDialog')
      assert.match(dialog.props.message, /开发机.*me@dev:22/)
      assert.match(dialog.props.message, /2 条关联目录映射/)
      assert.equal(ui.button(confirming, /^删除$/).disabled, true)
      dialog.props.onAnswer(answer)
      await pending
      return ui.settle()
    }
    let tree = await ui.settle()
    assert.match(ui.text(tree), /ssh-only.*来自 SSH 配置/)
    tree = await remove(tree, false)
    assert.deepEqual(deleted, [])
    tree = await remove(tree, true)
    assert.match(ui.text(tree), /fixture delete failed/)
    assert.equal(ui.button(tree, /^删除$/).disabled, false)
    fail = false
    tree = await remove(tree, true)
    assert.deepEqual(deleted, [{ action: 'delete', id: 'dev' }, { action: 'delete', id: 'dev' }])
    assert.match(ui.text(tree), /已移除「开发机」的保存连接/)
    assert.match(ui.text(tree), /devme@dev:22来自 SSH 配置/)
    assert.match(ui.text(tree), /服务器已移除 · 2/)
    assert(!ui.buttons(tree).some(button => button.label === '删除'))
  } finally {
    ui.dispose()
  }
})

test('remote picker can cancel or confirm changing the target of a mapped checkout', async () => {
  const requests = []
  const picked = []
  const previous = { ...mappings[0], revision: 'previous', remotePath: '/home/me/old' }
  let finishBindings
  const bindings = new Promise(resolve => { finishBindings = resolve })
  const ui = mountClient({ fetch: async (url, opts) => {
    const route = url.split('?')[0]
    if (route.endsWith('/machines')) return response({ machines: [machine], currentId: 'dev' })
    if (route.endsWith('/ssh-config')) return response({ entries: [] })
    if (route.endsWith('/current')) return response({ ok: true })
    if (route.endsWith('/bindings')) return bindings
    if (route.endsWith('/ls')) return response({ path: '/', items: [], platform: 'posix' })
    if (route.endsWith('/mappings')) {
      const request = JSON.parse(opts.body)
      requests.push(request)
      if (!request.id) return {
        ok: false, status: 409, json: async () => ({ conflict: previous, replaceable: true }),
      }
      return response({ ok: true, mapping: mappings[0] })
    }
    if (route.endsWith('/mirror')) {
      requests.push(JSON.parse(opts.body))
      return response({ ok: true, path: mappings[0].remotePath, localMirror: 'D:\\dsh\\remote-workspaces\\dev\\api-mapped' })
    }
    throw new Error('unexpected request: ' + url)
  } })
  try {
    const picker = ui.component('sidebar.workspaces.directoryFlow')
    const props = { open: true, onPicked: (...args) => picked.push(args), onCancel: () => {} }
    const render = () => ui.settleComponent(picker, props)
    let tree = await render()
    ui.button(tree, /^远程$/).el.props.onClick()
    tree = await render()
    const checkbox = ui.inputs(tree, 'checkbox').find(input => input.checked === false)
    assert(checkbox)
    checkbox.onChange({ target: { checked: true } })
    tree = await render()
    const localField = ui.components(tree).find(node => node.type.name === 'LocalMappingDirectory')
    assert(localField)
    localField.props.onChange(mappings[0].localPath)
    const remoteField = ui.inputs(tree).find(input => input.placeholder?.includes('远程路径'))
    remoteField.onChange({ target: { value: mappings[0].remotePath } })
    const remap = async accepted => {
      const pending = ui.button(await render(), /^设为远程工作区$/).el.props.onClick()
      await ui.tick()
      const waiting = await render()
      assert.equal(ui.button(waiting, /^正在保存映射…$/).disabled, true)
      const dialog = ui.components(waiting).find(node => node.type.name === 'ConfirmDialog')
      assert.equal(dialog.props.abovePicker, true)
      dialog.props.onAnswer(accepted)
      await pending
    }
    await remap(false)
    assert.deepEqual(picked, [])
    await remap(true)
    const save = { machineId: 'dev', remotePath: mappings[0].remotePath, localPath: mappings[0].localPath, action: 'save' }
    assert.deepEqual(requests, [
      save,
      save,
      { ...save, id: previous.id, revision: previous.revision },
      { machineId: 'dev', path: mappings[0].remotePath, mappingId: 'a', mappingRevision: '1', registerWorkspace: true },
    ])
    assert.deepEqual(picked, [['D:\\dsh\\remote-workspaces\\dev\\api-mapped', mappings[0].remotePath]])
  } finally {
    finishBindings(response({ mirrors: [] }))
    ui.dispose()
  }
})

test('remote paths are typed or selected through Browse', async () => {
  const listings = []
  const homeRequests = []
  const submitted = []
  const picked = []
  let timedOut = true
  const ui = mountClient({ fetch: async (url, opts) => {
    const request = new URL(url, 'http://localhost')
    if (request.pathname.endsWith('/machines')) {
      return response({ machines: [{ ...machine, recentWorkspaces: ['/recent-project'] }], currentId: 'dev' })
    }
    if (request.pathname.endsWith('/ssh-config')) return response({ entries: [] })
    if (request.pathname.endsWith('/current')) return response({ ok: true })
    if (request.pathname.endsWith('/home')) {
      homeRequests.push(JSON.parse(opts.body))
      return response({ home: '/home/fixture user' })
    }
    if (request.pathname.endsWith('/bindings')) return response({ mirrors: [] })
    if (request.pathname.endsWith('/ls')) {
      const path = request.searchParams.get('path')
      listings.push(path)
      return response({ path: path || '/', items: [], platform: 'posix' })
    }
    if (request.pathname.endsWith('/mirror')) {
      assert(opts.signal)
      if (timedOut) throw new DOMException('request timed out', 'TimeoutError')
      const { path } = JSON.parse(opts.body)
      submitted.push(path)
      return response({ path, localMirror: '/workspace' })
    }
    throw new Error('unexpected request: ' + url)
  } })
  try {
    const picker = ui.component('sidebar.workspaces.directoryFlow')
    const props = { open: true, onPicked: (...args) => picked.push(args), onCancel() {} }
    const render = () => ui.settleComponent(picker, props)
    const input = tree => ui.inputs(tree).find(field => field.placeholder === '输入远程路径')
    let tree = await render()
    ui.button(tree, /^远程$/).el.props.onClick()
    tree = await render()
    assert.doesNotMatch(ui.text(tree), /最近:|~ 主目录|recent-project/)
    assert.equal(input(tree).autoComplete, 'off')

    input(tree).onChange({ target: { value: '/projects/alpha' } })
    ui.timers.flush(1000)
    await ui.tick()
    tree = await render()
    assert.deepEqual(listings, [])
    input(tree).onKeyDown({ key: 'Enter', preventDefault() {} })
    await ui.tick()
    tree = await render()
    assert.match(ui.text(tree), /打开远程工作区超时/)
    assert.equal(ui.button(tree, /^设为远程工作区$/).disabled, false)
    timedOut = false
    input(tree).onKeyDown({ key: 'Enter', preventDefault() {} })
    await ui.tick()
    assert.deepEqual(submitted, ['/projects/alpha'])
    assert.deepEqual(picked, [['/workspace', '/projects/alpha']])

    ui.button(await render(), /^浏览…$/).el.props.onClick()
    await ui.tick()
    tree = await render()
    assert.deepEqual(listings, ['/projects/alpha'])
    ui.button(tree, /^选用此路径$/).el.props.onClick()
    assert.equal(input(await render()).value, '/projects/alpha')

    ui.button(await render(), /^从主目录浏览$/).el.props.onClick()
    await ui.tick()
    tree = await render()
    assert.deepEqual(homeRequests, [{ machineId: 'dev' }])
    assert.deepEqual(listings, ['/projects/alpha', '/home/fixture user'])
    ui.button(tree, /^选用此路径$/).el.props.onClick()
    assert.equal(input(await render()).value, '/home/fixture user')
  } finally {
    ui.dispose()
  }
})
