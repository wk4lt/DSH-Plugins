import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { Service } from '@deepseek-ai/cordis';
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { loadAgents, parseAgentFile } from '../agent-files.js';
import { registerAgents, createSelectionProjection, hideAgentPresets, selectionPath, modesPath, modesApiPath } from '../index.js';

const builtins = await loadAgents({ home: join(tmpdir(), 'dsh-absent-agent-home') });
const id = mode => `wk4lt-workflow-${mode}`;
const workflowIds = new Set(builtins.map(agent => agent.id));
const projection = createSelectionProjection(workflowIds);

async function host(agents = builtins) {
  const session = (id, agentPreset) => Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, agentPreset,
  });
  const sessions = new Map([
    ['standard-session', session('standard-session', 'standard')],
    ['creative-session', session('creative-session', 'cordis')],
  ]);
  const boundaries = new Map(), mounted = new Map(), rejected = new Set(), routes = new Map(), webRoutes = new Map();
  const definitions = new Map([['standard', { id: 'standard' }], ['cordis', { id: 'cordis' }]]);
  const disposers = [];
  let definition;
  const stateOf = session => session.snapshotEvents().reduce(
    (state, event) => definition.apply(state, event), definition.init(session.header));
  const ctx = {
    agents: { get: id => sessions.has(id) ? { id, session: sessions.get(id) } : undefined },
    logger: { error: message => { throw new Error(message); } },
    agentPresets: {
      defaultId: 'standard',
      register: async config => { definitions.set(config.id, config); return () => definitions.delete(config.id); },
      list: async () => [...definitions.values()],
      presetForSession: session => stateOf(session).preset,
      async select(agent, target) {
        const boundary = boundaries.get(agent.id);
        if (boundary && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) throw new Error('Session already started.');
        if (rejected.has(target) || !definitions.has(target)) throw new Error('Preset is unavailable.');
        mounted.set(agent.id, definitions.get(target));
        agent.session.append('agent-preset/selected', { agentPreset: target });
        return target;
      },
    },
    sessionProjections: { register: async value => { definition = value; return { stateOf }; } },
    webServer: { register: value => { webRoutes.set(value.path, value); return () => webRoutes.delete(value.path); } },
    connection: { requestRejection: request => request.rejection, fetch: { register: value => {
      assert(value.path.startsWith('/api/'));
      assert.equal(value.requestBody, 'buffered');
      routes.set(value.path, value); return () => routes.delete(value.path);
    } } },
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose); },
    inject: (names, fn) => { if (names.every(name => name in ctx)) return fn(ctx); },
    async plugin(Plugin, config) {
      assert.deepEqual(Plugin.inject, ['agentPresets']);
      for await (const dispose of new Plugin(ctx, config)[Service.init]()) disposers.push(dispose);
    },
    get systemPrompt() { throw new Error('Instructions must belong to the preset scope'); },
    get tools() { throw new Error('Tools must belong to the preset scope'); },
  };
  await registerAgents(ctx, agents);
  return {
    sessions, boundaries, stateOf, definitions, mounted, rejected, webRoutes, registry: ctx.agentPresets,
    dispose: () => disposers.reverse().forEach(dispose => dispose()),
    modes: async () => (await routes.get(modesApiPath).fetch()).json(),
    select: (sessionId, mode) => routes.get(selectionPath).fetch(new Request('http://localhost' + selectionPath, {
      method: 'POST', body: JSON.stringify({ sessionId, mode }),
    })),
  };
}

test('native preset lifecycle registers file definitions and disposes them on unload', async () => {
  const h = await host();
  assert.equal(h.definitions.size, 6);
  assert.deepEqual((await h.modes()).map(row => row.id), [...workflowIds]);
  h.dispose();
  assert.equal(h.definitions.size, 2);
});

test('the exact HTTP modes route uses native authentication and allows GET only', async () => {
  const h = await host(), route = h.webRoutes.get(modesPath);
  assert.equal(route.kind, 'exact');
  const request = input => {
    let status, body, headers;
    route.handler(input, { writeHead: (code, values) => { status = code; headers = values; }, end: value => { body = value; } });
    return { status, body, headers };
  };
  assert.equal(request({ method: 'GET', rejection: 401 }).status, 401);
  assert.equal(request({ method: 'GET', rejection: 403 }).status, 403);
  assert.equal(request({ method: 'POST' }).status, 405);
  const allowed = request({ method: 'GET' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(allowed.body).map(row => row.id), [...workflowIds]);
});

test('every workflow replaces the preset, survives event replay, and None restores Standard or Creator', async () => {
  const h = await host();
  for (const [sessionId, original] of [['standard-session', 'standard'], ['creative-session', 'cordis']]) {
    for (const mode of ['design', 'develop', 'test', 'debug']) {
      const response = await h.select(sessionId, id(mode));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).mode, id(mode));
      assert.deepEqual(h.stateOf(h.sessions.get(sessionId)), { preset: id(mode), previousPreset: original });
      assert.equal(h.mounted.get(sessionId).id, id(mode));
      const saved = h.sessions.get(sessionId);
      const restored = Session.create(saved.id, saved.snapshotEvents(), saved.header);
      assert.deepEqual(h.stateOf(restored), h.stateOf(saved));
      assert.equal(projection.wire.view(h.stateOf(restored)), id(mode));
    }
    assert.equal((await h.select(sessionId, 'none')).status, 200);
    assert.equal(h.mounted.get(sessionId).id, original);
  }
});

test('ordinary selections exit workflows and become the next restore target', async () => {
  const h = await host(), session = h.sessions.get('standard-session');
  await h.select(session.id, id('test'));
  await h.registry.select({ id: session.id, session }, 'cordis');
  assert.equal(projection.wire.view(h.stateOf(session)), 'none');
  await h.select(session.id, id('debug'));
  await h.select(session.id, 'none');
  assert.equal(h.stateOf(session).preset, 'cordis');
});

test('custom, ordinary and hidden files route correctly; project sources are visible', async () => {
  const make = (file, fields, kind = 'global') => parseAgentFile(`---\nname: Custom\ndescription: Review changes\n${fields}\n---\nReview\n`, file, { kind });
  const custom = make('/project/.dsh/agents/review.md', 'workflow: true', 'project');
  const hidden = make('/agents/secret.md', 'workflow: true\nhidden: true');
  const ordinary = make('/agents/ordinary.md', 'workflow: false');
  const h = await host([...builtins, custom, hidden, ordinary]);
  assert((await h.modes()).find(row => row.id === 'review').label.includes(custom.source.file));
  assert(!(await h.modes()).some(row => ['secret', 'ordinary'].includes(row.id)));
  assert(!(await h.registry.list()).some(row => row.id === 'secret'));
  assert(h.definitions.has('secret'));
  assert.equal((await h.select('standard-session', 'review')).status, 200);
  assert.equal(h.stateOf(h.sessions.get('standard-session')).preset, 'review');
  assert.equal((await h.select('standard-session', 'secret')).status, 400);
  assert.equal((await h.select('standard-session', 'ordinary')).status, 400);
});

test('missing, started, invalid and broken presets do not change the active choice', async () => {
  const h = await host();
  assert.equal((await h.select('missing', id('design'))).status, 404);
  assert.equal((await h.select('standard-session', 'unknown')).status, 400);
  for (const boundary of [{ openTurnStartSeq: 0, lastTurn: 0 }, { openTurnStartSeq: null, lastTurn: 1 }]) {
    h.boundaries.set('standard-session', boundary);
    assert.equal((await h.select('standard-session', id('design'))).status, 409);
  }
  assert.equal(h.sessions.get('standard-session').snapshotEvents().length, 0);
  h.boundaries.delete('standard-session');
  await h.select('standard-session', id('design'));
  h.rejected.add(id('test'));
  assert.equal((await h.select('standard-session', id('test'))).status, 409);
  assert.equal(h.stateOf(h.sessions.get('standard-session')).preset, id('design'));
});

test('hidden roster filtering restores the previous descriptor and preserves third-party presets', async () => {
  class Registry { async list() { return [{ id: 'hidden' }, { id: 'third-party' }]; } }
  const registry = new Registry(), original = registry.list;
  const dispose = hideAgentPresets(registry, new Set(['hidden']));
  assert.deepEqual(await registry.list(), [{ id: 'third-party' }]);
  dispose();
  assert.equal(registry.list, original);
  assert.equal(Object.hasOwn(registry, 'list'), false);
});

function client({ fetchSelection, list = builtins.map(agent => ({ id: agent.id, label: agent.name, order: agent.order })), failList = false, delayedSeat = false } = {}) {
  let loaded, nativeReady = !delayedSeat, changed, seatDeclaration;
  const registrations = new Map(), requests = [];
  function NativeSeat({ useAgentPresetSeat }) { return React.createElement('span', { 'data-seat': useAgentPresetSeat(value => value) }); }
  const nativeInject = () => ({});
  const fetch = async (url, options) => {
    if (url === modesApiPath) return { ok: !failList, json: async () => list };
    requests.push({ url, ...JSON.parse(options.body) });
    return fetchSelection ? fetchSelection(url, options) : { ok: true, json: async () => ({ mode: JSON.parse(options.body).mode }) };
  };
  new Function('window', 'fetch', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))({
    __ModuleLoader__: { load: value => { loaded = value; } },
  }, fetch);
  const mod = loaded.factory(name => { assert.equal(name, 'react'); return React; });
  mod.apply({
    slots: {
      inject: (_name, fn) => fn(),
      entriesOfSlot: () => nativeReady ? [{ options: { priority: 0 }, locale: 'settings.agentPreset', inject: nativeInject, component: NativeSeat }] : [],
      subscribe: (_name, callback) => { changed = callback; return () => {}; },
      register: (decl, component) => {
        registrations.set(decl.name, { decl, component });
        if (decl.name === 'conversation.hero.agentPreset') seatDeclaration = decl;
        return () => registrations.delete(decl.name);
      },
    },
    get remote() { throw new Error('cannot get property "remote" without inject'); },
  });
  const sessions = { one: { blank: true, projectionValues: { agentPreset: 'standard' } } };
  return {
    sessions, requests, registrations,
    get seatDeclaration() { return seatDeclaration; },
    mountNative() { nativeReady = true; changed(); },
    async renderSeat(current = 'standard') {
      let view;
      await act(async () => { view = create(React.createElement(registrations.get('conversation.hero.agentPreset').component, {
        useAgentPresetSeat: select => select({ current, options: [{ id: 'standard' }, ...list.map(row => ({ id: row.id }))] }),
      })); });
      return view.root.findByType('span').props['data-seat'];
    },
    async render() {
      const Component = registrations.get('conversation.hero.options').component;
      const props = () => ({ sessionId: 'one', useSessions: select => select({ byId: sessions }), ...registrations.get('conversation.hero.options').decl.inject('one') });
      let view;
      await act(async () => { view = create(React.createElement(Component, props())); });
      return { view, update: () => act(() => view.update(React.createElement(Component, props()))) };
    },
  };
}

test('the right-side English picker loads arbitrary workflow IDs and the native menu excludes them', async () => {
  const ui = client({ list: [{ id: 'my-review', label: 'Review', order: 1 }] });
  const { view, update } = await ui.render();
  const registration = ui.registrations.get('conversation.hero.options').decl;
  assert.equal(registration.order, 1000);
  assert.equal(view.root.findByType('div').props.style.marginLeft, 'auto');
  assert.deepEqual(view.root.findAllByType('option').map(option => option.children.join('')), ['Workflow · None', 'Review']);
  await act(async () => { await view.root.findByType('select').props.onChange({ target: { value: 'my-review' } }); });
  assert.equal(view.root.findByType('select').props.value, 'my-review');
  assert.deepEqual(ui.requests, [{ url: selectionPath, sessionId: 'one', mode: 'my-review' }]);
  const seat = await ui.renderSeat('my-review');
  assert.equal(seat.current, 'Agent preset');
  assert.deepEqual(seat.options, [{ id: 'standard' }]);
  assert.equal(ui.seatDeclaration.priority, -1);
  assert.equal(ui.seatDeclaration.locale, 'settings.agentPreset');
  ui.sessions.one.blank = false;
  update();
  assert.equal(view.toJSON(), null);
});

test('failed or empty mode fetch hides the workflow picker and leaves native presets usable', async () => {
  for (const options of [{ failList: true }, { list: [] }]) {
    const ui = client(options), { view } = await ui.render();
    assert.equal(view.toJSON(), null);
    const seat = await ui.renderSeat(id('test'));
    assert.equal(seat.current, id('test'));
    if (options.failList) assert(seat.options.some(row => row.id === id('test')));
  }
});

test('a refused selection restores the saved choice and reports the error', async () => {
  let settle;
  const ui = client({ fetchSelection: () => new Promise(resolve => { settle = resolve; }) });
  const { view } = await ui.render();
  let pending;
  act(() => { pending = view.root.findByType('select').props.onChange({ target: { value: id('test') } }); });
  assert.equal(view.root.findByType('select').props.disabled, true);
  await act(async () => { settle({ ok: false, json: async () => ({ error: 'Selection refused.' }) }); await pending; });
  assert.equal(view.root.findByType('select').props.value, 'none');
  assert.equal(view.root.findByProps({ role: 'alert' }).children.join(''), 'Selection refused.');
});

test('native chip registration can follow its slot declaration', async () => {
  const ui = client({ delayedSeat: true });
  ui.mountNative();
  assert.equal((await ui.renderSeat(id('test'))).current, 'Agent preset');
});
