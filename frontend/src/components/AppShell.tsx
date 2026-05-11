// Sidebar + main content layout. Sidebar styled per image-2 vibes:
// uppercase muted section labels, soft hover, brand-tint icons, run counts.

import { NavLink, useLocation } from "react-router-dom";
import { type ReactNode } from "react";
import {
  LuFolderOpen, LuBrain, LuMoon, LuBot, LuBox, LuActivity, LuLayoutGrid,
  LuSparkles, LuLogOut, LuUsers, LuMessageCircle,
} from "react-icons/lu";
import { useAuth } from "../lib/auth";
import { juicePfp } from "../lib/pfp";

type Item = { to: string; label: string; icon: typeof LuFolderOpen; tint: string };

const SECTIONS: Array<{ heading: string; items: Item[] }> = [
  {
    heading: "Talk",
    items: [
      { to: "/chat", label: "Chat", icon: LuMessageCircle, tint: "text-violet-500" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { to: "/knowledge", label: "Knowledge", icon: LuFolderOpen, tint: "text-violet-500" },
      { to: "/memory", label: "Memory", icon: LuBrain, tint: "text-emerald-500" },
      { to: "/dreams", label: "Dreams", icon: LuMoon, tint: "text-fuchsia-500" },
    ],
  },
  {
    heading: "Agents",
    items: [
      { to: "/agents", label: "Agents", icon: LuBot, tint: "text-violet-500" },
      { to: "/roster", label: "Roster", icon: LuUsers, tint: "text-fuchsia-500" },
      { to: "/environments", label: "Environments", icon: LuBox, tint: "text-sky-500" },
      { to: "/runs", label: "Runs", icon: LuActivity, tint: "text-amber-500" },
    ],
  },
  {
    heading: "Build",
    items: [
      { to: "/apps", label: "Apps", icon: LuLayoutGrid, tint: "text-rose-500" },
      { to: "/skills", label: "Skills", icon: LuSparkles, tint: "text-indigo-500" },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  const pfp = juicePfp(profile?.id);
  const location = useLocation();
  const breadcrumb = location.pathname.split("/").filter(Boolean)[0] ?? "knowledge";

  return (
    <div className="h-full flex">
      <aside className="w-64 shrink-0 bg-neutral-50 border-r border-neutral-200 flex flex-col">
        <div className="px-4 py-4 flex items-center gap-2.5">
          <div className="size-10 rounded-lg bg-black grid place-items-center text-white">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" className="size-7" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M38.02 24.593c-4.94-.561-6.433 1.134-10.4 3.652-3.556 2.263-7.02 2.034-7.02 2.034 1.794-5.643 6.055-6.104 10.143-7.022 3.07-.691 6.014-2.849 6.832-4.13.16-.258.113-.594-.112-.797-1.116-1.007-4.622-3.187-8.853-1.83-6.693 2.134-9.337 12.196-9.337 12.196s-1.82-7.228 5.878-12.43c5.619-3.796 3.877-10.805 3.282-12.685 7.703 3.918 11.68 12.636 9.588 21.021M1.594 20.08c-.009-2.99.712-5.938 2.098-8.587 1.35 1.332 6.216 3.038 11.135-.567 4.55-3.347 4.277-7.702 3.984-9.296.426-.027.846-.036 1.269-.036 2.236-.004 4.455.399 6.548 1.188-11.914 5.8-9.948 17.897-9.696 19.41.262 1.561.729 4.11.729 4.11-3.965-9.218-11.286-10.143-13.796-10.178-.224-.003-.438.093-.586.262-.147.168-.213.393-.18.615 1.027 6.929 5.637 8.013 10.297 9.19 4.733 1.195 4.473 4.005 4.473 4.005-.78 0-2.444-.625-4.317-1.248-4.897-1.785-8.8-1.219-10.178-.916-1.179-2.485-1.787-5.202-1.78-7.952m36.84-7.755C34.45 2.867 23.946-2.033 14.14.99 4.332 4.013-1.59 13.976.443 24.035 2.476 34.095 11.8 40.978 22.012 39.957 32.223 38.935 40 30.342 40 20.08c.003-2.664-.53-5.301-1.567-7.755" />
            </svg>
          </div>
          <div className="text-sm font-semibold tracking-tight">Hub</div>
        </div>
        <nav className="flex-1 overflow-y-auto pb-2">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="mb-2">
              <div className="section-heading">{section.heading}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      "mx-2 px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 text-sm transition-colors",
                      isActive
                        ? "bg-white shadow-soft text-ink-900 font-medium"
                        : "text-ink-700 hover:bg-white/70",
                    ].join(" ")
                  }
                >
                  <item.icon className={`size-4 ${item.tint}`} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-neutral-200 p-3">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              [
                "rounded-lg p-2 flex items-center gap-2.5 transition-colors",
                isActive ? "bg-white shadow-soft" : "hover:bg-white/70",
              ].join(" ")
            }
          >
            <img
              src={pfp}
              alt=""
              className="size-7 rounded-full object-cover bg-neutral-100"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{profile?.name ?? "—"}</div>
              <div className="text-[11px] text-ink-500 truncate">
                {profile?.role}{profile?.role === "admin" ? " · admin" : ""}
              </div>
            </div>
          </NavLink>
          <button
            onClick={signOut}
            className="mt-1 w-full text-left rounded-lg p-2 flex items-center gap-2.5 text-sm text-ink-500 hover:bg-white/70"
          >
            <LuLogOut className="size-4" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <div className="border-b border-neutral-200 px-6 py-3 text-xs text-ink-500 uppercase tracking-wider">
          {breadcrumb}
        </div>
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
