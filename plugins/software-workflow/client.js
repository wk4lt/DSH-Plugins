window.__ModuleLoader__.load({
  id: '@wk4lt/dsh-software-workflow',
  factory(require) {
    const { createElement: h, useState } = require('react');
    const namespace = 'wk4lt.software-workflow';
    const modes = [
      { id: 'wk4lt-workflow-design', label: 'Design' },
      { id: 'wk4lt-workflow-develop', label: 'Develop' },
      { id: 'wk4lt-workflow-test', label: 'Test' },
      { id: 'wk4lt-workflow-debug', label: 'Debug' },
    ];
    const selectStyle = {
      minHeight: 28,
      maxWidth: '100%',
      padding: '0 8px',
      border: 0,
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      colorScheme: 'inherit',
      font: 'inherit',
      fontSize: 13,
      fontWeight: 500,
    };

    function WorkflowSelector({ sessionId, useSessions, selectPreset, t }) {
      const session = useSessions(state => state.byId[sessionId]);
      const [pending, setPending] = useState('');
      const [error, setError] = useState('');
      if (session?.blank !== true) return null;

      const preset = session.projectionValues?.agentPreset;
      const value = pending || (modes.some(mode => mode.id === preset) ? preset : '');
      const choose = async event => {
        const id = event.target.value;
        if (pending || !modes.some(mode => mode.id === id)) return;
        setPending(id);
        setError('');
        try {
          await selectPreset(id);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : t('selectFailed'));
        } finally {
          setPending('');
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('select', {
          'aria-label': t('label'),
          value,
          onChange: choose,
          disabled: pending !== '',
          style: selectStyle,
        },
        h('option', { value: '', disabled: true }, t('label')),
        ...modes.map(mode => h('option', { key: mode.id, value: mode.id },
          mode.id === value ? `${t('label')} · ${mode.label}` : mode.label))),
        error ? h('span', { role: 'alert', style: { fontSize: 12 } }, error) : null);
    }

    return {
      inject: ['slots', 'locale', 'remote.agentPresets'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, {
          en: { label: 'Workflow', selectFailed: 'Could not select the workflow mode.' },
          zh: { label: '工作流', selectFailed: '无法选择工作流模式。' },
        }));
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'wk4lt-software-workflow',
          locale: namespace,
          inject: sessionId => ({
            async selectPreset(id) {
              const result = await ctx.remote.agentPresets.select(sessionId, id);
              if (!result.ok) throw new Error(result.error.message);
            },
          }),
        }, WorkflowSelector));
      },
    };
  },
});
