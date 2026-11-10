import { symbols } from '@deepseek-ai/cordis'

const SHELL_TOOLS = ['bash', 'pwsh', 'pty', 'terminal']
const LOCAL_PROJECT_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'apply_patch', ...SHELL_TOOLS,
])
const EXPLICIT_TRANSFERS = new Set(['rw_sync', 'rw_push'])
const SSH_CAPABILITIES = new Map([
  ['rw_list_dir', ['read', 'glob']],
  ['rw_read_file', ['read']],
  ['rw_stat', ['read']],
  ['rw_search', ['glob', 'grep']],
  ['rw_local_list_dir', ['read', 'glob']],
  ['rw_local_read_file', ['read']],
  ['rw_write_file', ['write']],
  ['rw_append', ['write']],
  ['rw_mkdir', ['write']],
  ['rw_remove', ['write']],
  ['rw_move', ['write']],
  ['rw_edit', ['edit']],
  ['rw_exec', SHELL_TOOLS],
  ['rw_download', ['read']],
  ['rw_upload', ['write']],
])

/**
 * Filter the admitted tool set shared by Native and PTC. The host builds its
 * final schemas from this set, including tools supplied by an agent preset.
 */
export function installWorkspaceToolRouting(ctx, { workspaceFor, localMode, bootstrap }) {
  const service = ctx.tools[symbols.original] ?? ctx.tools
  const original = service.resolve
  if (typeof original === 'function') {
    ctx.effect(() => {
      const descriptor = Object.getOwnPropertyDescriptor(service, 'resolve')
      async function resolve(context) {
        const selection = await original.call(this, context)
        try {
          const workspace = workspaceFor(context.agent)
          if (!workspace) return selection
          const admitted = selection.view(context.agent)
          const allowed = new Set()
          for (const name of admitted.keys()) {
            if (workspace === 'local') {
              if (!name.startsWith('rw_') || (localMode === 'all' && !name.startsWith('rw_local_'))
                || (localMode === 'bootstrap' && bootstrap.includes(name))) allowed.add(name)
              continue
            }
            if (LOCAL_PROJECT_TOOLS.has(name) || EXPLICIT_TRANSFERS.has(name)) continue
            const required = SSH_CAPABILITIES.get(name)
            if (!required || required.some(tool => admitted.has(tool))) allowed.add(name)
          }
          return {
            dispose: () => selection.dispose(),
            view: scope => new Map([...selection.view(scope)].filter(([name]) => allowed.has(name))),
          }
        } catch (error) {
          selection.dispose()
          throw error
        }
      }
      service.resolve = resolve
      return () => {
        if (service.resolve !== resolve) return
        if (descriptor) Object.defineProperty(service, 'resolve', descriptor)
        else delete service.resolve
      }
    })
  }
  // Guard programmatic invocations that bypass normal step admission.
  ctx.tools.guard?.(({ agent, name }) => {
    if (workspaceFor(agent) !== 'remote') return
    if (LOCAL_PROJECT_TOOLS.has(name)) return 'This session works over SSH. Use its remote workspace tools.'
    if (EXPLICIT_TRANSFERS.has(name)) return 'Use the remote workspace panel to pull or push files.'
  })
}
