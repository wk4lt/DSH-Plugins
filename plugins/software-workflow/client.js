window.__ModuleLoader__.load({
  id: '@wk4lt/dsh-software-workflow',
  factory(require) {
    const { createElement: h } = require('react');
    const namespace = 'wk4lt.software-workflow';
    const modes = ['Design', 'Develop', 'Test', 'Debug'];
    const groupStyle = {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
      padding: '4px 0', fontSize: 12,
    };
    const buttonStyle = {
      font: 'inherit', color: 'inherit', cursor: 'pointer', borderRadius: 6,
      padding: '2px 8px', background: 'transparent', border: '1px solid currentColor',
    };

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, {
          en: { label: 'New workflow session' },
          zh: { label: '新建工作流会话' },
        }));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'wk4lt-software-workflow',
          locale: namespace,
          order: 10,
        }, ({ t }) => h('div', { role: 'group', 'aria-label': t('label'), style: groupStyle },
          h('span', null, t('label')),
          ...modes.map(mode => h('button', {
            key: mode,
            type: 'button',
            style: buttonStyle,
            onClick: () => ctx.uiWorkspace.startSession(undefined, {
              agentPreset: `wk4lt-workflow-${mode.toLowerCase()}`,
            }),
          }, mode)),
        )));
      },
    };
  },
});
