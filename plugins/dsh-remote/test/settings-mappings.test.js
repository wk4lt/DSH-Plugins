import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountClient } from './harness/render.js'

const machine = { id: 'dev', name: '开发机', host: 'dev', username: 'me', port: 22 }
const mappings = [
  { id: 'a', revision: '1', machineId: 'dev', localPath: 'D:\\code\\api', remotePath: '/home/me/api' },
  { id: 'b', revision: '2', machineId: 'dev', localPath: 'D:\\code\\web', remotePath: '/home/me/web' },
]
const response = data => ({ ok: true, status: 200, json: async () => data })

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

test('remote picker opens the chosen local checkout when mapping is enabled', async () => {
  const requests = []
  const picked = []
  const ui = mountClient({ fetch: async (url, opts) => {
    const route = url.split('?')[0]
    if (route.endsWith('/machines')) return response({ machines: [machine], currentId: 'dev' })
    if (route.endsWith('/current')) return response({ ok: true })
    if (route.endsWith('/ls')) return response({ path: '/', items: [], platform: 'posix' })
    if (route.endsWith('/mappings')) {
      requests.push(JSON.parse(opts.body))
      return response({ ok: true, mapping: mappings[0] })
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
    tree = await render()
    ui.button(tree, /^设为远程工作区$/).el.props.onClick()
    await ui.tick()
    assert.deepEqual(requests, [{ machineId: 'dev', remotePath: mappings[0].remotePath, localPath: mappings[0].localPath, action: 'save' }])
    assert.deepEqual(picked, [[mappings[0].localPath, mappings[0].remotePath]])
  } finally {
    ui.dispose()
  }
})
