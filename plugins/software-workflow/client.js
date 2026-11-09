window.__ModuleLoader__.load({
  id: '@wk4lt/dsh-software-workflow',
  factory(require) {
    const { createElement: h, useState, useEffect } = require('react');
    const selectionKey = 'wk4ltSoftwareWorkflow';
    let modesRequest;
    function useModes() {
      const [modes, setModes] = useState(null);
      useEffect(() => {
        let active = true;
        modesRequest ??= fetch('/api/dsh-software-workflow/modes', { signal: AbortSignal.timeout(8000) }).then(async response => {
          if (!response.ok) throw new Error('Workflow list is unavailable.');
          const list = await response.json();
          if (!Array.isArray(list) || !list.every(mode => typeof mode.id === 'string' && mode.id && mode.id !== 'none'
            && typeof mode.label === 'string' && Number.isFinite(mode.order))) throw new Error('Invalid workflow list.');
          return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        });
        modesRequest.then(value => { if (active) setModes(value); }, () => { if (active) setModes(null); });
        return () => { active = false; };
      }, []);
      return modes;
    }
    const selectStyle = {
      minHeight: 28, maxWidth: '100%', padding: '0 8px', border: 0,
      borderRadius: 'var(--dsw-radius-sm, 6px)', background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)', colorScheme: 'inherit',
      font: 'inherit', fontSize: 13, fontWeight: 500,
    };

    function WorkflowSelector({ sessionId, useSessions, selectMode }) {
      const available = useModes();
      const session = useSessions(state => state.byId[sessionId]);
      const [pending, setPending] = useState(false);
      const [override, setOverride] = useState(null);
      const [error, setError] = useState('');
      const recorded = session?.projectionValues?.[selectionKey] || 'none';
      useEffect(() => { setOverride(null); setError(''); }, [sessionId, recorded]);
      if (session?.blank !== true || !available?.length) return null;
      const modes = [{ id: 'none', label: 'None' }, ...available];

      const value = override?.sessionId === sessionId ? override.mode : recorded;
      const choose = async event => {
        const mode = event.target.value;
        if (pending || !modes.some(item => item.id === mode)) return;
        setPending(true);
        setOverride({ sessionId, mode });
        setError('');
        try {
          const committed = await selectMode(mode);
          setOverride({ sessionId, mode: committed });
        } catch (reason) {
          setOverride(null);
          setError(reason instanceof Error ? reason.message : 'Could not select the workflow mode.');
        } finally {
          setPending(false);
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, marginLeft: 'auto' } },
        h('select', {
          'aria-label': 'Workflow', value, onChange: choose, disabled: pending, style: selectStyle,
        }, !modes.some(mode => mode.id === value) ? h('option', { value, hidden: true, disabled: true }, 'Workflow · Unavailable') : null,
        ...modes.map(mode => h('option', { key: mode.id, value: mode.id },
          mode.id === value ? `Workflow · ${mode.label}` : mode.label))),
        error ? h('span', { role: 'alert', style: { fontSize: 12 } }, error) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.hero.agentPreset', () => {
          let dispose;
          const wrap = () => {
            if (dispose) return;
            const native = ctx.slots.entriesOfSlot('conversation.hero.agentPreset')[0];
            if (!native) return;
            function OrdinaryPresetSeat(props) {
              const modes = useModes();
              const state = props.useAgentPresetSeat(value => value);
              const workflowIds = new Set(modes?.map(mode => mode.id));
              const presented = modes?.length ? {
                ...state,
                current: workflowIds.has(state.current) ? 'Agent preset' : state.current,
                options: state.options.filter(option => !workflowIds.has(option.id)),
              } : state;
              return h(native.component, { ...props, useAgentPresetSeat: select => select(presented) });
            }
            dispose = ctx.slots.register({
              name: 'conversation.hero.agentPreset',
              priority: (native.options.priority || 0) - 1,
              locale: native.locale,
              inject: native.inject,
            }, OrdinaryPresetSeat);
          };
          // A slot can be declared before the native chip registers its entry.
          const unsubscribe = ctx.slots.subscribe('conversation.hero.agentPreset', wrap);
          wrap();
          return () => { unsubscribe(); dispose?.(); };
        });
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'wk4lt-software-workflow',
          order: 1000,
          inject: sessionId => ({
            async selectMode(mode) {
              const response = await fetch('/api/wk4lt-software-workflow/selection', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, mode }),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'Could not select the workflow mode.');
              return result.mode;
            },
          }),
        }, WorkflowSelector));
      },
    };
  },
});
