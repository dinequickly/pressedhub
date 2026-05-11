// Sidebar + main content layout. Sidebar styled per image-2 vibes:
// uppercase muted section labels, soft hover, brand-tint icons, run counts.

import { NavLink, useLocation } from "react-router-dom";
import { type ReactNode } from "react";
import {
  LuFolderOpen, LuBrain, LuMoon, LuBot, LuBox, LuActivity, LuLayoutGrid,
  LuSparkles, LuLogOut, LuUsers, LuMessageCircle,
} from "react-icons/lu";
import { useAuth } from "../lib/auth";
import type { Session } from "../lib/api";
import { relativeTime } from "../lib/format";
import { juicePfp } from "../lib/pfp";
import { useApi } from "../lib/swr";

type Item = { to: string; label: string; icon: typeof LuFolderOpen };

const SECTIONS: Array<{ heading: string; items: Item[] }> = [
  {
    heading: "Talk",
    items: [
      { to: "/chat", label: "Chat", icon: LuMessageCircle },
    ],
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
const isChatMode = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
  const { data: sessionData } = useApi<{ data: Session[] }>(
    isChatMode ? "/sessions" : null,
    { refreshInterval: isChatMode ? 5000 : 0 },
  );
  const chatSessions = sessionData?.data ?? [];
  const activeChatSessionId = location.pathname.startsWith("/chat/")
    ? location.pathname.split("/")[2] ?? null
    : chatSessions[0]?.id ?? null;

  const revealClass = "max-w-0 opacity-0 -translate-x-1 pointer-events-none group-hover/sidebar:max-w-[12rem] group-hover/sidebar:opacity-100 group-hover/sidebar:translate-x-0 group-hover/sidebar:pointer-events-auto group-focus-within/sidebar:max-w-[12rem] group-focus-within/sidebar:opacity-100 group-focus-within/sidebar:translate-x-0 group-focus-within/sidebar:pointer-events-auto";
  const justifyClass = "justify-center px-2 group-hover/sidebar:justify-start group-hover/sidebar:px-2.5 group-focus-within/sidebar:justify-start group-focus-within/sidebar:px-2.5";
  const asideWidthClass = "w-[3.75rem] hover:w-64 focus-within:w-64";

  return (
    <div className="h-full flex">
      <aside
        className={[
          "group/sidebar shrink-0 bg-white border-r border-neutral-100 flex flex-col transition-[width] duration-200 ease-out",
          asideWidthClass,
        ].join(" ")}
      >
        <div className="px-2 py-4 group-hover/sidebar:px-4 group-focus-within/sidebar:px-4 transition-all duration-200">
          <div className="flex items-center gap-2.5 transition-all duration-200 justify-center group-hover/sidebar:justify-start group-focus-within/sidebar:justify-start">
            <div className="size-9 rounded-lg bg-white border border-neutral-200 shadow-sm grid place-items-center text-neutral-800 shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" className="size-6" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M38.02 24.593c-4.94-.561-6.433 1.134-10.4 3.652-3.556 2.263-7.02 2.034-7.02 2.034 1.794-5.643 6.055-6.104 10.143-7.022 3.07-.691 6.014-2.849 6.832-4.13.16-.258.113-.594-.112-.797-1.116-1.007-4.622-3.187-8.853-1.83-6.693 2.134-9.337 12.196-9.337 12.196s-1.82-7.228 5.878-12.43c5.619-3.796 3.877-10.805 3.282-12.685 7.703 3.918 11.68 12.636 9.588 21.021M1.594 20.08c-.009-2.99.712-5.938 2.098-8.587 1.35 1.332 6.216 3.038 11.135-.567 4.55-3.347 4.277-7.702 3.984-9.296.426-.027.846-.036 1.269-.036 2.236-.004 4.455.399 6.548 1.188-11.914 5.8-9.948 17.897-9.696 19.41.262 1.561.729 4.11.729 4.11-3.965-9.218-11.286-10.143-13.796-10.178-.224-.003-.438.093-.586.262-.147.168-.213.393-.18.615 1.027 6.929 5.637 8.013 10.297 9.19 4.733 1.195 4.473 4.005 4.473 4.005-.78 0-2.444-.625-4.317-1.248-4.897-1.785-8.8-1.219-10.178-.916-1.179-2.485-1.787-5.202-1.78-7.952m36.84-7.755C34.45 2.867 23.946-2.033 14.14.99 4.332 4.013-1.59 13.976.443 24.035 2.476 34.095 11.8 40.978 22.012 39.957 32.223 38.935 40 30.342 40 20.08c.003-2.664-.53-5.301-1.567-7.755" />
              </svg>
            </div>
            <div className={`overflow-hidden whitespace-nowrap text-sm font-semibold tracking-tight transition-all duration-200 ${revealClass}`}>
              Hub
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto pb-2">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="mb-2">
              <div className={`section-heading overflow-hidden whitespace-nowrap transition-all duration-200 ${revealClass}`}>
                {section.heading}
              </div>
              {section.items.map((item) => (
                <div key={item.to}>
                  <NavLink
                    to={item.to}
                    title={item.label}
                    className={({ isActive }) =>
                      [
                        "mx-2 py-1.5 rounded-lg flex items-center gap-2.5 text-sm transition-all duration-200",
                        justifyClass,
                        isActive
                          ? "bg-white shadow-soft text-ink-900 font-medium"
                          : "text-ink-700 hover:bg-white/70",
                      ].join(" ")
                    }
                  >
                    <item.icon className="size-4 shrink-0 text-neutral-500" />
                    <span className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${revealClass}`}>
                      {item.label}
                    </span>
                  </NavLink>
                  {item.to === "/chat" && isChatMode && (
                    <div className={`mt-1 ml-3 overflow-hidden transition-all duration-200 ${revealClass}`}>
                      {!chatSessions.length ? (
                        <div className="px-3 py-1.5 text-[11px] text-ink-400">
                          No chats yet
                        </div>
                      ) : (
                        <div className="max-h-[18.5rem] space-y-0.5 overflow-y-auto">
                          {chatSessions.filter((s) => s.title).map((session) => {
                            const isCurrent = activeChatSessionId === session.id;
                            return (
                              <NavLink
                                key={session.id}
                                to={`/chat/${session.id}`}
                                className={() =>
                                  [
                                    "flex items-baseline justify-between gap-2 rounded-xl pl-3 pr-2 py-1.5 transition-all duration-200",
                                    isCurrent
                                      ? "bg-neutral-100 text-ink-900"
                                      : "text-ink-600 hover:bg-white/70 hover:text-ink-900",
                                  ].join(" ")
                                }
                              >
                                <span className="truncate text-[13px] font-medium min-w-0">
                                  {session.title}
                                </span>
                                <span className="shrink-0 text-[10px] text-ink-400">
                                  {relativeTime(session.started_at)}
                                </span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-neutral-100 p-3">
          <NavLink
            to="/profile"
            title="Profile"
            className={({ isActive }) =>
              [
                "rounded-lg p-2 flex items-center gap-2.5 transition-all duration-200",
                "justify-center group-hover/sidebar:justify-start group-focus-within/sidebar:justify-start",
                isActive ? "bg-white shadow-soft" : "hover:bg-white/70",
              ].join(" ")
            }
          >
            <img
              src={pfp}
              alt=""
              className="size-7 rounded-full object-cover bg-neutral-100"
            />
            <div className={`flex-1 min-w-0 overflow-hidden transition-all duration-200 ${revealClass}`}>
              <div className="text-sm font-medium truncate">{profile?.name ?? "—"}</div>
              <div className="text-[11px] text-ink-500 truncate">
                {profile?.role}{profile?.role === "admin" ? " · admin" : ""}
              </div>
            </div>
          </NavLink>
          <button
            onClick={signOut}
            title="Sign out"
            className="mt-1 w-full rounded-lg p-2 flex items-center gap-2.5 text-sm text-ink-500 hover:bg-white/70 transition-all duration-200 justify-center text-center group-hover/sidebar:justify-start group-hover/sidebar:text-left group-focus-within/sidebar:justify-start group-focus-within/sidebar:text-left"
          >
            <LuLogOut className="size-4 shrink-0" />
            <span className={`overflow-hidden whitespace-nowrap transition-all duration-200 ${revealClass}`}>
              Sign out
            </span>
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
