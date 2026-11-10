import { symbols } from '@deepseek-ai/cordis';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import { z } from './vendor/agent-dependencies.js';
import { loadAgents } from './agent-files.js';
import { compileAgent } from './agent-presets.js';

export const inject = ['agents', 'agentPresets', 'sessionProjections'];
export const selectionKey = 'wk4ltSoftwareWorkflow';
export const selectionPath = '/api/wk4lt-software-workflow/selection';
export const modesPath = '/dsh-software-workflow/modes';
export const modesApiPath = '/api/dsh-software-workflow/modes';
const selectionSchema = z.object({ sessionId: z.string().min(1), mode: z.string().min(1) });
const configSchema = z.object({ enableProjectAgents: z.boolean().default(false), projectRoot: z.string().min(1).optional() });

export function createSelectionProjection(workflowIds) {
  return {
    key: selectionKey,
    stateVersion: 3,
    stateSchema: z.object({ preset: z.string().nullable(), previousPreset: z.string().nullable() }),
    init: header => ({ preset: header.agentPreset ?? null, previousPreset: null }),
    apply(state, event) {
      if (event.type !== 'agent-preset/selected') return state;
      const preset = event.data.agentPreset;
      return {
        preset,
        previousPreset: !workflowIds.has(preset) ? null
          : !workflowIds.has(state.preset) ? state.preset : state.previousPreset,
      };
    },
    wire: { viewSchema: z.string(), view: state => workflowIds.has(state.preset) ? state.preset : 'none' },
  };
}

// DSH 0.2.2 has no hidden-preset API. Keep definitions resolvable for history,
// and filter only hidden files here. Workflow menu placement is client-side so
// a failed mode-list fetch still leaves those presets in the native picker.
export function hideAgentPresets(registry, hiddenIds) {
  const descriptor = Object.getOwnPropertyDescriptor(registry, 'list');
  const original = registry.list;
  async function list(...args) {
    return (await original.apply(this, args)).filter(row => !hiddenIds.has(row.id));
  }
  registry.list = list;
  return () => {
    if (registry.list !== list) return;
    if (descriptor) Object.defineProperty(registry, 'list', descriptor);
    else delete registry.list;
  };
}

export async function registerAgents(ctx, agents) {
  const loaded = [];
  for (const agent of agents) {
    try {
      // Use the native preset plugin: it owns registration and disposal. This
      // also keeps the caller's Loader base URL for resolving child plugins.
      await ctx.plugin(AgentPreset, compileAgent(agent));
      loaded.push(agent);
    } catch {
      ctx.logger.error(`${agent.source.file}:1: could not register preset ${agent.id}; see preset diagnostics`);
    }
  }
  const workflowIds = new Set(loaded.filter(agent => agent.workflow).map(agent => agent.id));
  const hiddenIds = new Set(loaded.filter(agent => agent.hidden).map(agent => agent.id));
  const selection = await ctx.sessionProjections.register(createSelectionProjection(workflowIds));
  ctx.effect(() => hideAgentPresets(ctx.agentPresets[symbols.original] ?? ctx.agentPresets, hiddenIds));

  const listModes = () => loaded.filter(agent => agent.workflow && !agent.hidden).map(agent => ({
    id: agent.id,
    label: agent.source.kind === 'project' ? `${agent.name} [${agent.source.file}]` : agent.name,
    order: agent.order,
  }));
  // The Fetch registry also serves desktop IPC. HTTP routes outside /api need
  // an exact webServer seat, protected by the same Connection authentication.
  ctx.inject(['connection', 'webServer'], scope => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact', path: modesPath,
      handler(request, response) {
        const rejection = scope.connection.requestRejection(request);
        if (rejection !== undefined) {
          response.writeHead(rejection); response.end(); return;
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }); response.end(); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(listModes()));
      },
    }));
  });
  // Profiles that provide agentPresets can load files without a web gateway.
  ctx.inject(['connection'], ctx => {
  ctx.effect(() => ctx.connection.fetch.register({
    path: modesApiPath, methods: ['GET'], requestBody: 'buffered',
    fetch: () => Response.json(listModes()),
  }));

  ctx.effect(() => ctx.connection.fetch.register({
    path: selectionPath, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let input;
      try {
        const raw = await request.text();
        if (raw.length > 4096) return Response.json({ error: 'Selection request is too large.' }, { status: 413 });
        input = selectionSchema.safeParse(JSON.parse(raw));
      } catch {
        return Response.json({ error: 'Invalid selection request.' }, { status: 400 });
      }
      if (!input.success) return Response.json({ error: 'Choose a valid workflow and session.' }, { status: 400 });
      const { sessionId } = input.data;
      // Accept old four-mode clients during an upgrade; new clients use preset IDs.
      const mode = workflowIds.has(input.data.mode) ? input.data.mode
        : workflowIds.has(`wk4lt-workflow-${input.data.mode}`) ? `wk4lt-workflow-${input.data.mode}` : input.data.mode;
      if (mode !== 'none' && (!workflowIds.has(mode) || hiddenIds.has(mode))) {
        return Response.json({ error: 'This workflow is unavailable.' }, { status: 400 });
      }
      const agent = ctx.agents.get(sessionId);
      if (!agent) return Response.json({ error: 'This session is no longer available.' }, { status: 404 });
      const state = selection.stateOf(agent.session);
      const defaultId = ctx.agentPresets.defaultId;
      const fallback = workflowIds.has(defaultId) || hiddenIds.has(defaultId) ? 'standard' : defaultId;
      const target = mode !== 'none' ? mode : workflowIds.has(state.preset)
        ? state.previousPreset ?? fallback : state.preset ?? fallback;
      try {
        // The host queues switches, enforces the turn boundary and commits the
        // preset event only after replacing the prompt/tool composition.
        await ctx.agentPresets.select(agent, target);
        const current = ctx.agentPresets.presetForSession(agent.session);
        return Response.json({ mode: workflowIds.has(current) ? current : 'none' });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Could not select the workflow.' }, { status: 409 });
      }
    },
  }));
  });
  return loaded;
}

export async function apply(ctx, config = {}) {
  for (const key of Object.keys(config)) if (!(key in configSchema.shape)) ctx.logger.warn(`software-workflow config.${key}: unsupported field ignored`);
  const options = configSchema.parse(config);
  const agents = await loadAgents(options, {
    warn: message => ctx.logger.warn(message), error: message => ctx.logger.error(message),
  });
  await registerAgents(ctx, agents);
}
