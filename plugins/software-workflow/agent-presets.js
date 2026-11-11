export function compileAgent(agent, platform = process.platform) {
  const { write, edit, applyPatch, readImage, search } = agent.tools;
  const plugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: agent.body } },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { write, edit, applyPatch, readImage } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  ];
  if (search) plugins.push({ id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } });
  // Runtime registration does not pass through Loader's !!js evaluator.
  const shell = agent.shell === 'auto' ? platform === 'win32' ? 'pwsh' : 'bash' : agent.shell;
  if (shell !== 'none') plugins.push({ id: `tool-${shell}`, name: `@deepseek-ai/dsh-tool-${shell}` });
  for (const server of agent.mcp) {
    const { tools, ...config } = server;
    plugins.push({ id: `mcp-${server.serverName}`, name: '@deepseek-ai/dsh-mcp-client', config });
  }
  if (agent.mcp.length) plugins.push({
    id: 'mcp-policy', name: '@wk4lt/dsh-software-workflow/mcp-policy',
    config: { mcpTools: [...new Set(agent.mcp.flatMap(server => server.tools))] },
  });
  return {
    id: agent.id,
    name: agent.source.kind === 'project' ? `${agent.name} [${agent.source.file}]` : agent.name,
    description: agent.description,
    order: agent.order,
    plugins,
  };
}
