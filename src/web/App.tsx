import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "./state.tsx";
import { useI18n } from "./i18n.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { ChatView } from "./views/ChatView.tsx";
import { MailView } from "./views/MailView.tsx";
import { ApprovalsView } from "./views/ApprovalsView.tsx";
import { EmployeesView } from "./views/EmployeesView.tsx";
import { WorkView } from "./views/WorkView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { WorkContextsView } from "./views/WorkContextsView.tsx";
import { Onboarding } from "./views/Onboarding.tsx";
import { Icon, IconButton } from "./views/ui.tsx";

export function App(): ReactNode {
  const { state, dispatch } = useApp();
  const { messages, text } = useI18n();
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);

  // The notice expires on its own id: switching languages redraws the text but
  // never restarts the countdown.
  const noticeId = state.notice?.id;
  useEffect(() => {
    if (noticeId === undefined) return;
    const timer = setTimeout(() => dispatch({ type: "notice", text: "" }), 6_000);
    return () => clearTimeout(timer);
  }, [noticeId, dispatch]);

  const closeNav = useCallback((restoreFocus: boolean) => {
    setNavOpen(false);
    if (restoreFocus) menuButton.current?.focus();
  }, []);

  // The narrow-screen navigation is modal: Escape closes it and focus returns
  // to the control that opened it. A popover that already handled Escape (the
  // workspace menu) marks the event, and that press must not close the drawer.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeNav(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, closeNav]);

  // Validation errors on the first-run form are app-level errors too: render
  // the same banner above the setup page, not only inside the workspace shell.
  const errorBanner =
    state.error !== undefined ? (
      <div className="banner error">
        <span>{text(state.error)}</span>
        <button type="button" onClick={() => dispatch({ type: "error", message: undefined })}>
          {messages.app.dismiss}
        </button>
      </div>
    ) : null;

  if (!state.ready) {
    return <div className="boot">{messages.app.boot}</div>;
  }
  if (state.app === undefined || !state.app.onboarded) {
    return (
      <>
        {errorBanner}
        <Onboarding />
      </>
    );
  }

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      <Sidebar onNavigate={() => closeNav(false)} navOpen={navOpen} />
      <button
        type="button"
        className="sidebar-scrim"
        aria-label={messages.app.navClose}
        tabIndex={navOpen ? 0 : -1}
        onClick={() => closeNav(true)}
      />
      <section className="main">
        <div className="mobile-bar">
          <IconButton
            ref={menuButton}
            icon={navOpen ? "close" : "menu"}
            label={navOpen ? messages.app.navClose : messages.app.navOpen}
            onClick={() => (navOpen ? closeNav(true) : setNavOpen(true))}
          />
          <span className="title">{messages.app.view[state.view]}</span>
          {state.connected ? null : <Icon name="alert" />}
        </div>
        {errorBanner}
        {state.connected ? null : <div className="banner warn">{messages.app.reconnect}</div>}
        {state.view === "chat" ? <ChatView key={state.activeRoomId} /> : null}
        {state.view === "mail" ? <MailView /> : null}
        {state.view === "approvals" ? <ApprovalsView /> : null}
        {state.view === "employees" ? <EmployeesView /> : null}
        {state.view === "work" ? <WorkView /> : null}
        {state.view === "work-contexts" ? <WorkContextsView /> : null}
        {state.view === "settings" ? <SettingsView /> : null}
      </section>
      {state.notice !== undefined && text(state.notice.text).length > 0 ? (
        <div className="toast" key={state.notice.id}>
          {text(state.notice.text)}
        </div>
      ) : null}
    </div>
  );
}
