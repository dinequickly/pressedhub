import { NavLink, useLocation } from "react-router-dom";
import { type ReactNode, useState } from "react";
import {
  LuFolderOpen, LuBrain, LuMoon, LuBot, LuBox, LuActivity, LuLayoutGrid,
  LuSparkles, LuLogOut, LuUsers, LuMessageCircle, LuPanelLeft,
} from "react-icons/lu";
import { useAuth } from "../lib/auth";
import type { Session, WorkspaceSettings } from "../lib/api";
import { relativeTime } from "../lib/format";
import { juicePfp } from "../lib/pfp";
import { useApi } from "../lib/swr";

type Item = { to: string; label: string; icon: typeof LuFolderOpen };

const SECTIONS: Array<{ heading: string; items: Item[] }> = [
  {
    heading: "Talk",
    items: [{ to: "/chat", label: "Chat", icon: LuMessageCircle }],
  },
  {
    heading: "Workspace",
    items: [
      { to: "/knowledge", label: "Knowledge", icon: LuFolderOpen },
      { to: "/memory", label: "Memory", icon: LuBrain },
      { to: "/dreams", label: "Dreams", icon: LuMoon },
    ],
  },
  {
    heading: "Agents",
    items: [
      { to: "/agents", label: "Agents", icon: LuBot },
      { to: "/roster", label: "Roster", icon: LuUsers },
      { to: "/environments", label: "Environments", icon: LuBox },
      { to: "/runs", label: "Runs", icon: LuActivity },
    ],
  },
  {
    heading: "Build",
    items: [
      { to: "/apps", label: "Apps", icon: LuLayoutGrid },
      { to: "/skills", label: "Skills", icon: LuSparkles },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const pfp = juicePfp(profile?.id);
  const location = useLocation();
  const [expanded, setExpanded] = useState(true);

  const isChatMode = location.pathname === "/chat" || location.pathname.startsWith("/chat/");

  const { data: sessionData } = useApi<{ data: Session[] }>(
    isChatMode ? "/sessions" : null,
    { refreshInterval: isChatMode ? 5000 : 0 },
  );
  const chatSessions = sessionData?.data ?? [];

  const { data: wsSettings } = useApi<WorkspaceSettings>("/profiles/workspace-settings");
  const hiddenPages = wsSettings?.hidden_nav_pages ?? [];

  const visibleSections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !hiddenPages.includes(item.to.replace("/", ""))),
  })).filter((section) => section.items.length > 0);
  const activeChatSessionId = location.pathname.startsWith("/chat/")
    ? location.pathname.split("/")[2] ?? null
    : chatSessions[0]?.id ?? null;

  return (
    <div className="h-full flex" style={{ background: "var(--background)" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: expanded ? "15rem" : "3.5rem",
          transition: "width 200ms ease",
          background: "var(--sidebar)",
          borderRight: "1px solid var(--sidebar-border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Logo + toggle */}
        <div style={{ padding: "0.75rem", display: "flex", alignItems: "center", gap: "0.625rem" }}>
          <div style={{
            width: "2rem", height: "2rem", borderRadius: "0.5rem",
            background: "var(--background)", border: "1px solid var(--border)",
            display: "grid", placeItems: "center", flexShrink: 0,
            color: "var(--foreground)",
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" style={{ width: "1.125rem", height: "1.125rem" }} fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M38.02 24.593c-4.94-.561-6.433 1.134-10.4 3.652-3.556 2.263-7.02 2.034-7.02 2.034 1.794-5.643 6.055-6.104 10.143-7.022 3.07-.691 6.014-2.849 6.832-4.13.16-.258.113-.594-.112-.797-1.116-1.007-4.622-3.187-8.853-1.83-6.693 2.134-9.337 12.196-9.337 12.196s-1.82-7.228 5.878-12.43c5.619-3.796 3.877-10.805 3.282-12.685 7.703 3.918 11.68 12.636 9.588 21.021M1.594 20.08c-.009-2.99.712-5.938 2.098-8.587 1.35 1.332 6.216 3.038 11.135-.567 4.55-3.347 4.277-7.702 3.984-9.296.426-.027.846-.036 1.269-.036 2.236-.004 4.455.399 6.548 1.188-11.914 5.8-9.948 17.897-9.696 19.41.262 1.561.729 4.11.729 4.11-3.965-9.218-11.286-10.143-13.796-10.178-.224-.003-.438.093-.586.262-.147.168-.213.393-.18.615 1.027 6.929 5.637 8.013 10.297 9.19 4.733 1.195 4.473 4.005 4.473 4.005-.78 0-2.444-.625-4.317-1.248-4.897-1.785-8.8-1.219-10.178-.916-1.179-2.485-1.787-5.202-1.78-7.952m36.84-7.755C34.45 2.867 23.946-2.033 14.14.99 4.332 4.013-1.59 13.976.443 24.035 2.476 34.095 11.8 40.978 22.012 39.957 32.223 38.935 40 30.342 40 20.08c.003-2.664-.53-5.301-1.567-7.755" />
            </svg>
          </div>
          {expanded && (
            <span style={{ fontSize: "0.875rem", fontWeight: 600, letterSpacing: "-0.01em", color: "var(--sidebar-foreground)", whiteSpace: "nowrap" }}>
              Hub
            </span>
          )}
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center",
              width: "1.5rem", height: "1.5rem", borderRadius: "0.375rem",
              color: "var(--sidebar-foreground)", opacity: 0.5, cursor: "pointer",
              background: "none", border: "none",
            }}
            title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          >
            <LuPanelLeft style={{ width: "0.875rem", height: "0.875rem" }} />
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingBottom: "0.5rem" }}>
          {visibleSections.map((section) => (
            <div key={section.heading} style={{ marginBottom: "0.25rem" }}>
              {expanded && (
                <div style={{
                  fontSize: "0.6875rem", fontWeight: 500, color: "var(--sidebar-foreground)",
                  opacity: 0.5, textTransform: "uppercase", letterSpacing: "0.07em",
                  padding: "0.75rem 0.75rem 0.25rem",
                }}>
                  {section.heading}
                </div>
              )}
              {section.items.map((item) => {
                const isActive = location.pathname === item.to ||
                  (item.to !== "/" && location.pathname.startsWith(item.to + "/")) ||
                  (item.to === "/chat" && location.pathname === "/chat");
                return (
                  <div key={item.to}>
                    <NavLink
                      to={item.to}
                      title={!expanded ? item.label : undefined}
                      style={({ isActive: navActive }) => ({
                        display: "flex",
                        alignItems: "center",
                        gap: "0.625rem",
                        padding: expanded ? "0.375rem 0.625rem" : "0.375rem",
                        margin: "0.125rem 0.5rem",
                        borderRadius: "0.5rem",
                        fontSize: "0.875rem",
                        textDecoration: "none",
                        color: "var(--sidebar-foreground)",
                        justifyContent: expanded ? "flex-start" : "center",
                        background: (navActive || isActive) ? "var(--sidebar-accent)" : "transparent",
                        fontWeight: (navActive || isActive) ? 500 : 400,
                        transition: "background 150ms",
                      })}
                      onMouseEnter={e => {
                        const el = e.currentTarget as HTMLElement;
                        if (!el.style.background || el.style.background === "transparent") {
                          el.style.background = "var(--sidebar-accent)";
                        }
                      }}
                      onMouseLeave={e => {
                        const el = e.currentTarget as HTMLElement;
                        if (!isActive && !location.pathname.startsWith(item.to + "/")) {
                          el.style.background = "transparent";
                        }
                      }}
                    >
                      <item.icon style={{ width: "1rem", height: "1rem", flexShrink: 0, opacity: 0.8 }} />
                      {expanded && <span style={{ whiteSpace: "nowrap" }}>{item.label}</span>}
                    </NavLink>

                    {/* Chat sub-list */}
                    {item.to === "/chat" && isChatMode && expanded && chatSessions.length > 0 && (
                      <div style={{ marginLeft: "0.75rem", maxHeight: "18rem", overflowY: "auto" }}>
                        {chatSessions.map((session) => {
                          const isCurrent = activeChatSessionId === session.id;
                          return (
                            <NavLink
                              key={session.id}
                              to={`/chat/${session.id}`}
                              style={() => ({
                                display: "flex",
                                alignItems: "baseline",
                                justifyContent: "space-between",
                                gap: "0.5rem",
                                borderRadius: "0.5rem",
                                padding: "0.375rem 0.75rem",
                                textDecoration: "none",
                                background: isCurrent ? "var(--sidebar-accent)" : "transparent",
                                color: "var(--sidebar-foreground)",
                              })}
                            >
                              <span style={{ fontSize: "0.75rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, opacity: session.title ? 1 : 0.5 }}>
                                {session.title ?? "New chat"}
                              </span>
                              <span style={{ fontSize: "0.625rem", opacity: 0.4, flexShrink: 0 }}>
                                {relativeTime(session.started_at)}
                              </span>
                            </NavLink>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ borderTop: "1px solid var(--sidebar-border)", padding: "0.5rem" }}>
          <NavLink
            to="/profile"
            style={({ isActive }) => ({
              display: "flex", alignItems: "center", gap: "0.625rem",
              padding: "0.375rem 0.5rem", borderRadius: "0.5rem",
              textDecoration: "none", color: "var(--sidebar-foreground)",
              justifyContent: expanded ? "flex-start" : "center",
              background: isActive ? "var(--sidebar-accent)" : "transparent",
            })}
          >
            <img src={pfp} alt="" style={{ width: "1.5rem", height: "1.5rem", borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
            {expanded && (
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: "0.8125rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {profile?.name ?? "—"}
                </div>
                <div style={{ fontSize: "0.6875rem", opacity: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {profile?.role}
                </div>
              </div>
            )}
          </NavLink>
          <button
            onClick={signOut}
            title="Sign out"
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: "0.625rem",
              padding: "0.375rem 0.5rem", borderRadius: "0.5rem", marginTop: "0.125rem",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--sidebar-foreground)", opacity: 0.6, fontSize: "0.875rem",
              justifyContent: expanded ? "flex-start" : "center",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.background = "var(--sidebar-accent)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0.6"; (e.currentTarget as HTMLElement).style.background = "none"; }}
          >
            <LuLogOut style={{ width: "1rem", height: "1rem", flexShrink: 0 }} />
            {expanded && <span style={{ whiteSpace: "nowrap" }}>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflow: "hidden" }}>{children}</div>
      </main>
    </div>
  );
}
