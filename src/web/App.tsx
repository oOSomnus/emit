import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "./state.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { ChatView } from "./views/ChatView.tsx";
import { MailView } from "./views/MailView.tsx";
import { ApprovalsView } from "./views/ApprovalsView.tsx";
import { EmployeesView } from "./views/EmployeesView.tsx";
import { WorkView } from "./views/WorkView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { Onboarding } from "./views/Onboarding.tsx";
import { Icon, IconButton } from "./views/ui.tsx";
import type { View } from "./state.tsx";

const VIEW_TITLES: Record<View, string> = {
  chat: "会话",
  mail: "邮件",
  approvals: "审批",
  work: "工作",
  employees: "员工",
  settings: "设置",
};

export function App(): ReactNode {
  const { state, dispatch } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (state.notice === undefined) return;
    const timer = setTimeout(() => dispatch({ type: "notice", text: "" }), 6_000);
    return () => clearTimeout(timer);
  }, [state.notice, dispatch]);

  const closeNav = useCallback((restoreFocus: boolean) => {
    setNavOpen(false);
    if (restoreFocus) menuButton.current?.focus();
  }, []);

  // The narrow-screen navigation is modal: Escape closes it and focus returns
  // to the control that opened it.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNav(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, closeNav]);

  if (!state.ready) {
    return <div className="boot">正在读取本地数据…</div>;
  }
  if (state.app === undefined || !state.app.onboarded) {
    return <Onboarding />;
  }

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      <Sidebar onNavigate={() => closeNav(false)} />
      <button
        type="button"
        className="sidebar-scrim"
        aria-label="关闭导航"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => closeNav(true)}
      />
      <section className="main">
        <div className="mobile-bar">
          <IconButton
            ref={menuButton}
            icon={navOpen ? "close" : "menu"}
            label={navOpen ? "关闭导航" : "打开导航"}
            onClick={() => (navOpen ? closeNav(true) : setNavOpen(true))}
          />
          <span className="title">{VIEW_TITLES[state.view]}</span>
          {state.connected ? null : <Icon name="alert" />}
        </div>
        {state.error !== undefined ? (
          <div className="banner error">
            <span>{state.error}</span>
            <button type="button" onClick={() => dispatch({ type: "error", message: undefined })}>
              关闭
            </button>
          </div>
        ) : null}
        {state.connected ? null : <div className="banner warn">与本地服务的连接已断开，正在重连…</div>}
        {state.view === "chat" ? <ChatView /> : null}
        {state.view === "mail" ? <MailView /> : null}
        {state.view === "approvals" ? <ApprovalsView /> : null}
        {state.view === "employees" ? <EmployeesView /> : null}
        {state.view === "work" ? <WorkView /> : null}
        {state.view === "settings" ? <SettingsView /> : null}
      </section>
      {state.notice !== undefined && state.notice.text.length > 0 ? (
        <div className="toast" key={state.notice.id}>
          {state.notice.text}
        </div>
      ) : null}
    </div>
  );
}
