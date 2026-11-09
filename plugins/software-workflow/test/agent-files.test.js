import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadAgents, parseAgentFile } from '../agent-files.js';

const md = (fields = '', body = 'Instructions with literal ${NOT_EXPANDED}.\n') => `---\nname: Review\ndescription: Review project changes.\n${fields}\n---\n${body}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-files-test-'));
  t.after(async () => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('Markdown keeps the body literal, uses filename identity, and applies documented defaults', () => {
  const agent = parseAgentFile(md(), '/agents/my-review.md', { env: {} });
  assert.equal(agent.id, 'my-review');
  assert.equal(agent.body, 'Instructions with literal ${NOT_EXPANDED}.\n');
  assert.equal(agent.order, 100);
  assert.equal(agent.workflow, false);
  assert.equal(agent.hidden, false);
  assert.deepEqual(agent.tools, { write: true, edit: true, applyPatch: false, readImage: false, search: true });
  assert.equal(agent.shell, 'auto');
  assert.deepEqual(agent.mcp, []);
  assert.equal(parseAgentFile(md('id: stable-id'), '/agents/renamed.md').id, 'stable-id');
});

test('environment expansion covers metadata, command, args, env, cwd, URLs, and headers, not body', () => {
  const agent = parseAgentFile(md(`id: \${AGENT_ID}
mcp:
  - serverName: checks
    transport: streamable-http
    url: \${URL}
    headers: {Authorization: "Bearer \${TOKEN}"}
    tools: [mcp__checks__run]
  - serverName: lint
    transport: stdio
    command: \${COMMAND}
    args: ['\${ARG}']
    env: {TOKEN: '\${TOKEN}'}
    cwd: \${CWD}`), '/agents/review.md', {
    env: { AGENT_ID: 'expanded-id', URL: 'http://127.0.0.1:1234/mcp', TOKEN: 'private', COMMAND: 'node', ARG: 'server.js', CWD: '/project' },
  });
  assert.equal(agent.id, 'expanded-id');
  assert.equal(agent.mcp[0].headers.Authorization, 'Bearer private');
  assert.deepEqual(agent.mcp[1].args, ['server.js']);
  assert.deepEqual(agent.mcp[1].env, { TOKEN: 'private' });
  assert.equal(agent.mcp[1].cwd, '/project');
  assert(agent.body.includes('${NOT_EXPANDED}'));
});

test('parse and validation errors identify the file, line, and field without expanding missing variables', () => {
  assert.throws(() => parseAgentFile(md('mcp:\n  - serverName: checks\n    transport: streamable-http\n    url: ${MISSING_URL}'), '/agents/broken.md', { env: {} }),
    /broken\.md:7: mcp\.0\.url: Missing environment variable MISSING_URL/);
  assert.throws(() => parseAgentFile(md('tools:\n  write: nope'), '/agents/broken.md'), /broken\.md:5: tools\.write:/);
  assert.throws(() => parseAgentFile('---\nname: [oops\n---\nBody', '/agents/broken.md'), /broken\.md:\d+:/);
  assert.throws(() => parseAgentFile(md('', ''), '/agents/empty.md'), /body: Agent instructions are required/);
  for (const id of ['standard', 'ptc', 'minimal', 'cordis', 'none']) {
    assert.throws(() => parseAgentFile(md(`id: ${id}`), '/agents/collision.md'), /id: Reserved built-in preset id/);
  }
  assert.throws(() => parseAgentFile(md('shell: !!js process.exit()'), '/agents/unsafe.md'), /unsafe\.md:4:/);
  assert.throws(() => parseAgentFile(md('workflow: true\nworkflow: false'), '/agents/duplicate.md'), /duplicate\.md:5:/);
});

test('unknown and unsupported fields warn with a path, then are ignored', () => {
  const warnings = [];
  const agent = parseAgentFile(md(`mode: subagent
permissions: [{write: allow}]
model: ignored
tools:
  applyPach: true
mcp:
  - serverName: checks
    transport: stdio
    command: node
    tyop: true`), '/agents/warnings.md', { warn: line => warnings.push(line) });
  assert.equal(agent.tools.applyPatch, false);
  assert.equal(agent.mode, undefined);
  assert.equal(warnings.length, 5);
  assert(warnings.some(line => /tools\.applyPach: unsupported field ignored/.test(line)));
  assert(warnings.some(line => /mcp\.0\.tyop: unsupported field ignored/.test(line)));
});

test('MCP validates namespaces, required transport fields, duplicate server names, and allowlist names', () => {
  const server = 'mcp:\n  - serverName: checks\n    transport: stdio\n    command: node\n';
  assert.throws(() => parseAgentFile(md(server + '    tools: [run]'), '/agents/test.md'), /mcp\.0\.tools\.0:/);
  assert.throws(() => parseAgentFile(md(server + '    tools: [mcp__another__run]'), '/agents/test.md'), /Tool must belong to this serverName/);
  assert.throws(() => parseAgentFile(md(server + '  - serverName: checks\n    transport: stdio\n    command: node'), '/agents/test.md'), /Duplicate serverName/);
  assert.throws(() => parseAgentFile(md('mcp:\n  - serverName: checks\n    transport: stdio'), '/agents/test.md'), /command: Required/);
});

test('loading is deterministic and isolated: later sources override; invalid files do not remove good presets', async t => {
  const root = await fixture(t), builtin = join(root, 'builtin'), home = join(root, 'home'), project = join(root, 'project');
  for (const directory of [builtin, join(home, 'agents'), join(project, '.dsh/agents')]) await mkdir(directory, { recursive: true });
  await writeFile(join(builtin, 'same.md'), md('id: same', 'Builtin\n'));
  await writeFile(join(home, 'agents/renamed.md'), md('id: same', 'Global\n'));
  await writeFile(join(home, 'agents/broken.md'), md('tools: {write: typo}'));
  await writeFile(join(home, 'agents/standard.md'), md());
  await writeFile(join(home, 'agents/missing.md'), md('name: ${MISSING}').replace('name: Review\n', ''));
  await writeFile(join(project, '.dsh/agents/same.md'), md('id: same', 'Project\n'));
  const warnings = [], errors = [];
  const options = { builtInDir: builtin, home, projectRoot: project };
  const logging = { env: {}, warn: value => warnings.push(value), error: value => errors.push(value) };
  const disabled = await loadAgents(options, logging);
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].body, 'Global\n');
  const enabled = await loadAgents({ ...options, enableProjectAgents: true }, logging);
  assert.equal(enabled[0].body, 'Project\n');
  assert.equal(enabled[0].source.kind, 'project');
  assert(warnings.some(line => line.includes('overrides') && line.includes('renamed.md')));
  assert(errors.some(line => line.includes('broken.md')));
  assert(errors.some(line => line.includes('standard.md')));
  assert(errors.some(line => line.includes('missing.md') && line.includes('MISSING')));
});

test('all four shipped files preserve existing preset identities', async t => {
  const home = await fixture(t);
  const agents = await loadAgents({ home });
  assert.deepEqual(agents.map(agent => agent.id), ['wk4lt-workflow-design', 'wk4lt-workflow-develop', 'wk4lt-workflow-test', 'wk4lt-workflow-debug']);
  assert.deepEqual(agents.map(agent => agent.name), ['Design', 'Develop', 'Test', 'Debug']);
  assert(agents.every(agent => agent.workflow));
  assert.equal(agents[3].tools.write, false);
  assert.equal(agents[3].tools.applyPatch, true);
});
