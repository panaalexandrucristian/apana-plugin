// opencode-auto, sidebar line (OpenCode 2.3.2): shows in the sidebar of a session whether it hands itself off. Only the JSX lives here, so that the
// text is decided by `sidebarLabel` in tui.mjs (plain JavaScript, tested with Node). OpenCode compiles this file; Node cannot load it.
export function registerSidebar(context: any, label: (info: unknown) => string | null) {
  return context.ui.slot({
    append: "sidebar.content",
    render: (props: { sessionID: string }) => {
      const line = () => label(context.data.session.get(props.sessionID));
      return <>{line() ? <text fg={context.theme.text.base}>{line()}</text> : null}</>;
    },
  });
}
