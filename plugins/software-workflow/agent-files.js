import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument, visit } from 'yaml';
import { z } from 'zod';

export const builtInDirectory = fileURLToPath(new URL('./agents/', import.meta.url));
export const reservedIds = new Set(['standard', 'ptc', 'minimal', 'cordis', 'none']);
export const qualifiedTool = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const nonempty = z.string().refine(value => value.trim().length > 0, 'Must be a nonempty string');
const toolSchema = z.object({
  write: z.boolean().default(true), edit: z.boolean().default(true),
  applyPatch: z.boolean().default(false), readImage: z.boolean().default(false),
  search: z.boolean().default(true),
});
const reconnectSchema = z.object({
  enabled: z.boolean().optional(), initialDelayMs: z.number().int().positive().optional(),
  maxDelayMs: z.number().int().positive().optional(), maxAttempts: z.number().int().positive().optional(),
});
const mcpSchema = z.object({
  serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  transport: z.enum(['stdio', 'streamable-http']),
  command: nonempty.optional(), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(),
  url: z.string().url().refine(value => /^https?:\/\//.test(value), 'Must be an HTTP(S) URL').optional(),
  headers: z.record(z.string(), z.string()).optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
  failOnStartupError: z.boolean().optional(), maxInstructionBytes: z.number().int().positive().optional(),
  reconnect: reconnectSchema.optional(),
  tools: z.array(z.string().regex(qualifiedTool)).default([]),
}).superRefine((server, ctx) => {
  const required = server.transport === 'stdio' ? 'command' : 'url';
  if (!server[required]) ctx.addIssue({ code: 'custom', path: [required], message: `Required for ${server.transport}` });
  server.tools.forEach((tool, index) => {
    if (!tool.startsWith(`mcp__${server.serverName}__`)) ctx.addIssue({
      code: 'custom', path: ['tools', index], message: 'Tool must belong to this serverName',
    });
  });
});
const agentSchema = z.object({
  id: nonempty, name: nonempty, description: nonempty,
  order: z.number().finite().default(100), workflow: z.boolean().default(false), hidden: z.boolean().default(false),
  tools: toolSchema.prefault({}), shell: z.enum(['none', 'auto', 'bash', 'pwsh']).default('auto'),
  mcp: z.array(mcpSchema).default([]),
}).superRefine((agent, ctx) => {
  if (reservedIds.has(agent.id)) ctx.addIssue({ code: 'custom', path: ['id'], message: 'Reserved built-in preset id' });
  const names = new Set();
  agent.mcp.forEach((server, index) => {
    if (names.has(server.serverName)) ctx.addIssue({ code: 'custom', path: ['mcp', index, 'serverName'], message: 'Duplicate serverName in this preset' });
    names.add(server.serverName);
  });
});
const rootKeys = new Set(Object.keys(agentSchema.shape));
const toolKeys = new Set(Object.keys(toolSchema.shape));
const mcpKeys = new Set(Object.keys(mcpSchema.shape));
const reconnectKeys = new Set(Object.keys(reconnectSchema.shape));

export class AgentFileError extends Error {
  constructor(file, line, field, message) {
    super(`${file}:${line}: ${field ? `${field}: ` : ''}${message}`);
    this.name = 'AgentFileError';
  }
}

export function parseAgentFile(text, file, { env = process.env, warn = () => {}, kind = 'global' } = {}) {
  const source = text.replace(/^\uFEFF/, '');
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) throw new AgentFileError(file, 1, '', 'Expected YAML frontmatter starting with ---');
  const rest = source.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new AgentFileError(file, 1, '', 'Missing closing --- for frontmatter');
  const yamlText = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  const counter = new LineCounter();
  const document = parseDocument(yamlText, { lineCounter: counter, uniqueKeys: true });
  const lineAt = path => {
    let node;
    try { node = path.length ? document.getIn(path, true) : document.contents; } catch { /* Invalid parent node. */ }
    return counter.linePos(node?.range?.[0] ?? 0).line + 1;
  };
  const problem = (path, message) => new AgentFileError(file, lineAt(path), path.join('.'), message);
  const parserProblem = document.errors[0] || document.warnings[0];
  if (parserProblem) throw new AgentFileError(file, (parserProblem.linePos?.[0]?.line || 1) + 1, '', parserProblem.message.split('\n')[0]);
  visit(document, (_key, node) => {
    if (node?.tag && !/^tag:yaml.org,2002:(?:str|int|float|bool|null|map|seq)$/.test(node.tag)) {
      throw new AgentFileError(file, counter.linePos(node.range?.[0] ?? 0).line + 1, '', 'Custom YAML tags and !!js are not supported');
    }
  });
  let data;
  try { data = document.toJS({ maxAliasCount: 50 }); } catch { throw problem([], 'Invalid or excessive YAML aliases'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem([], 'Frontmatter must be a mapping');
  const stripUnknown = (value, keys, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (keys.has(key)) return true;
      warn(`${file}:${lineAt([...path, key])}: ${[...path, key].join('.')}: unsupported field ignored`);
      return false;
    }));
  };
  data = stripUnknown(data, rootKeys, []);
  if (data.tools !== undefined) data.tools = stripUnknown(data.tools, toolKeys, ['tools']);
  if (Array.isArray(data.mcp)) data.mcp = data.mcp.map((server, i) => {
    const cleaned = stripUnknown(server, mcpKeys, ['mcp', i]);
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) return cleaned;
    if (cleaned.reconnect !== undefined) cleaned.reconnect = stripUnknown(cleaned.reconnect, reconnectKeys, ['mcp', i, 'reconnect']);
    const incompatible = cleaned.transport === 'stdio' ? ['url', 'headers']
      : cleaned.transport === 'streamable-http' ? ['command', 'args', 'env', 'cwd'] : [];
    for (const key of incompatible) if (key in cleaned) {
      warn(`${file}:${lineAt(['mcp', i, key])}: mcp.${i}.${key}: ignored for ${cleaned.transport}`);
      delete cleaned[key];
    }
    return cleaned;
  });
  const expand = (value, path = []) => {
    if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable) => {
      if (env[variable] === undefined) throw problem(path, `Missing environment variable ${variable}`);
      return env[variable];
    });
    if (Array.isArray(value)) return value.map((item, i) => expand(item, [...path, i]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, [...path, key])]));
    return value;
  };
  data = expand(data);
  if (data.id === undefined) data.id = basename(file, '.md');
  const parsed = agentSchema.safeParse(data);
  if (!parsed.success) throw problem(parsed.error.issues[0].path, parsed.error.issues[0].message);
  if (!body.trim()) throw new AgentFileError(file, yamlText.split('\n').length + 2, 'body', 'Agent instructions are required');
  return { ...parsed.data, body, source: { file: resolve(file), kind } };
}

export async function loadAgents({
  builtInDir = builtInDirectory,
  home = process.env.DSH_HOME || join(homedir(), '.dsh'),
  enableProjectAgents = false, projectRoot = process.cwd(),
} = {}, { env = process.env, warn = () => {}, error = () => {} } = {}) {
  const merged = new Map();
  const directories = [[builtInDir, 'builtin'], [join(home, 'agents'), 'global']];
  if (enableProjectAgents) directories.push([join(resolve(projectRoot), '.dsh', 'agents'), 'project']);
  for (const [directory, kind] of directories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (cause) {
      if (cause.code !== 'ENOENT') error(`${directory}:1: could not read agent directory (${cause.code || cause.name})`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = join(directory, entry.name);
      try {
        const agent = parseAgentFile(await readFile(file, 'utf8'), file, { env, warn, kind });
        if (merged.has(agent.id)) warn(`${file}:1: preset ${agent.id} overrides ${merged.get(agent.id).source.file}`);
        merged.set(agent.id, agent);
      } catch (cause) {
        error(cause instanceof AgentFileError ? cause.message : `${file}:1: could not load agent file (${cause.code || cause.name})`);
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'));
}
