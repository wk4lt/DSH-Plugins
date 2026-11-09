export const inject = ['tools'];

const qualifiedTool = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

export function apply(ctx, { mcpTools = [] } = {}) {
  if (!Array.isArray(mcpTools) || mcpTools.some(name => typeof name !== 'string' || !qualifiedTool.test(name))) {
    throw new TypeError('mcpTools must be an array of fully qualified MCP tool names');
  }

  const allowed = new Set(mcpTools);
  ctx.tools.guard(({ name }) => {
    if ((name.startsWith('mcp__') || resourceTools.has(name)) && !allowed.has(name)) {
      return `MCP tool "${name}" is outside this workflow mode's allowlist.`;
    }
  });
}
