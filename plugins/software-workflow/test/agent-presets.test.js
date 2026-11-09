import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgents, parseAgentFile } from '../agent-files.js';
import { compileAgent } from '../agent-presets.js';
import { apply as applyPolicy } from '../mcp-policy.js';

test('the shipped matrix is preserved on both platforms, with Debug patches enabled', async () => {
  const agents = await loadAgents({ home: join(tmpdir(), 'dsh-absent-agent-home') });
  for (const agent of agents) for (const platform of ['win32', 'linux']) {
    const preset = compileAgent(agent, platform);
    const find = id => preset.plugins.find(row => row.id === id);
    assert.equal(preset.id, agent.id);
    assert.equal(preset.name, agent.name);
    assert.equal(preset.description, agent.description);
    assert.equal(preset.order, agent.order);
    assert.deepEqual(find('persona').config, { prefix: agent.body });
    assert.equal(find('tool-fs').config.write, ['Design', 'Develop'].includes(agent.name));
    assert.equal(find('tool-fs').config.edit, agent.name !== 'Test');
    assert.equal(find('tool-fs').config.applyPatch, ['Develop', 'Debug'].includes(agent.name));
    assert.equal(!!find(`tool-${platform === 'win32' ? 'pwsh' : 'bash'}`), agent.name !== 'Design');
    assert.equal(find(`tool-${platform === 'win32' ? 'bash' : 'pwsh'}`), undefined);
    assert.equal(find('mcp-policy'), undefined);
  }
});

test('explicit shells, search disabled, readImage, and project sources compile to native configuration', () => {
  const agent = parseAgentFile('---\nname: Review\ndescription: Project agent\nshell: bash\ntools: {search: false, readImage: true, write: false}\n---\nBody\n', '/project/.dsh/agents/review.md', { kind: 'project' });
  const preset = compileAgent(agent, 'win32');
  assert.equal(preset.plugins.find(row => row.id === 'tool-fs-search'), undefined);
  assert(preset.plugins.some(row => row.id === 'tool-bash'));
  assert.equal(preset.plugins.find(row => row.id === 'tool-fs').config.readImage, true);
  assert(preset.name.includes(agent.source.file));
});

test('MCP client rows omit tools and the scoped policy combines fully qualified allowlists', () => {
  const agent = parseAgentFile(`---
name: Checks
description: Run checks
mcp:
  - serverName: checks
    transport: streamable-http
    url: http://127.0.0.1:1234/mcp
    tools: [mcp__checks__run, mcp__checks__run]
  - serverName: lint
    transport: stdio
    command: node
    args: [server.js]
    tools: [mcp__lint__check]
---
Instructions
`, '/agents/checks.md');
  const preset = compileAgent(agent);
  assert.equal(Object.hasOwn(preset.plugins.find(row => row.id === 'mcp-checks').config, 'tools'), false);
  const policy = preset.plugins.find(row => row.id === 'mcp-policy');
  assert.deepEqual(policy.config.mcpTools, ['mcp__checks__run', 'mcp__lint__check']);
  let guard;
  applyPolicy({ tools: { guard: callback => { guard = callback; } } }, policy.config);
  assert.equal(guard({ name: 'mcp__checks__run' }), undefined);
  assert.equal(guard({ name: 'write' }), undefined);
  assert.match(guard({ name: 'mcp__checks__delete' }), /allowlist/);
  agent.mcp[0].tools = []; agent.mcp[1].tools = [];
  applyPolicy({ tools: { guard: callback => { guard = callback; } } }, compileAgent(agent).plugins.find(row => row.id === 'mcp-policy').config);
  assert.match(guard({ name: 'mcp__checks__run' }), /allowlist/);
});
