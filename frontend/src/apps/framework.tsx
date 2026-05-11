// App framework — shared hooks and the host component that mounts a
// registered App at /apps/<slug>/*.
//
// What's here:
//   - <AppHost />      Looks up the slug from the URL, renders the App's
//                      Routes inside an AppContext provider. Surfaces a
//                      "setup needed" banner if declared agents are missing.
//   - useAppManifest() Returns the current App's manifest. Apps use this so
//                      they don't have to hard-code their own slug/name.
//   - useAppAgents()   Resolves the manifest's `agents: string[]` (names) to
//                      live Agent rows. Returns { resolved, missing, loading }.
//   - startAppSession() Convenience: kick off a session against one of the
//                      App's agents with the given prompt + resources.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { LuArrowLeft, LuTriangleAlert } from "react-icons/lu";
import { useApi } from "../lib/swr";
import { api, type Agent, type Environment, type Session } from "../lib/api";
import type { AppManifest } from "./registry";
import { findApp } from "./registry";

const AppContext = createContext<AppManifest | null>(null);

export function useAppManifest(): AppManifest {
  const m = useContext(AppContext);
  if (!m) {
    throw new Error("useAppManifest() called outside an App. Wrap in <AppHost />.");
  }
  return m;
}

export function AppHost() {
  const { slug } = useParams<{ slug: string }>();
  const manifest = slug ? findApp(slug) : undefined;
  if (!manifest) return <Navigate to="/apps" replace />;
  const { Routes } = manifest;
  return (
    <AppContext.Provider value={manifest}>
      <div className="h-full bg-zinc-50 text-gray-900 flex flex-col">
        <Routes />
        <BackToHubPill />
      </div>
    </AppContext.Provider>
  );
}

// Tiny floating button — bottom-left so it doesn't fight the App's own
// header. Hub returns to /apps.
function BackToHubPill() {
  return (
    <Link
      to="/apps"
      className="fixed top-3 left-3 z-50 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/90 backdrop-blur border border-gray-200 text-gray-500 hover:text-gray-900 hover:border-gray-300 text-xs font-medium transition-colors shadow-sm"
    >
      <LuArrowLeft className="size-3.5" />
      Hub
    </Link>
  );
}

// Resolve declared agent names to live rows. Apps that depend on agents
// should call this and gracefully handle the loading + missing states; the
// launcher uses the same data to show a setup warning on the tile.
export function useAppAgents(manifest: AppManifest): {
  resolved: Record<string, Agent | undefined>;
  missing: string[];
  loading: boolean;
} {
  const { data, isLoading } = useApi<{ data: Agent[] }>("/agents");
  return useMemo(() => {
    const all = data?.data ?? [];
    const resolved: Record<string, Agent | undefined> = {};
    for (const name of manifest.agents) {
      resolved[name] = all.find((a) => a.name === name);
    }
    const missing = manifest.agents.filter((n) => !resolved[n]);
    return { resolved, missing, loading: !!isLoading };
  }, [data, isLoading, manifest.agents]);
}

export type StartAppSessionInput = {
  /** Name of the agent (must be one of the App's declared `agents`). */
  agent: string;
  /** Initial user.message. */
  prompt: string;
  /** Optional explicit environment. If omitted, the framework picks one. */
  environmentId?: string;
  /** Local KB file ids to attach as session resources. */
  kbFileIds?: string[];
  /** Local vault connection ids to attach. */
  vaultConnectionIds?: string[];
  /** Local memory store ids to attach. */
  memoryStoreIds?: string[];
  /** Optional outcome rubric. */
  outcome?: { description: string; rubric_md: string; max_iterations?: number };
  /** Override the session title. Defaults to the trimmed prompt. */
  title?: string;
};

// Kick off a Managed Agent session for one of this App's declared agents.
// Returns the created Session row; caller decides whether to navigate to
// /runs/<id> or render the run inline.
export async function startAppSession(
  manifest: AppManifest,
  input: StartAppSessionInput,
): Promise<Session> {
  if (!manifest.agents.includes(input.agent)) {
    throw new Error(
      `App "${manifest.slug}" did not declare agent "${input.agent}". ` +
      `Add it to the manifest's agents array.`,
    );
  }
  const [{ data: agents }, { data: envs }] = await Promise.all([
    api.get<{ data: Agent[] }>("/agents"),
    api.get<{ data: Environment[] }>("/environments"),
  ]);
  const agent = agents.find((a) => a.name === input.agent);
  if (!agent) {
    throw new Error(
      `Agent "${input.agent}" required by App "${manifest.slug}" was not found. ` +
      `Create it under /agents.`,
    );
  }
  const environment = input.environmentId
    ? envs.find((e) => e.id === input.environmentId)
    : envs[0];
  if (!environment) {
    throw new Error("No environment available. Create one under /environments.");
  }
  return await api.post<Session>("/sessions", {
    agent_id: agent.id,
    environment_id: environment.id,
    title: input.title ?? deriveTitle(input.prompt),
    initial_message: input.prompt,
    kb_file_ids: input.kbFileIds ?? [],
    vault_connection_ids: input.vaultConnectionIds ?? [],
    memory_store_ids: input.memoryStoreIds ?? [],
    outcome: input.outcome,
  });
}

function deriveTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

// Tiny helper component apps can drop in to render a setup banner when one
// or more declared agents aren't created yet.
export function MissingAgentsBanner({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 flex items-start gap-2">
      <LuTriangleAlert className="size-4 mt-0.5" />
      <div>
        <div className="font-medium">Setup needed</div>
        <div className="text-xs mt-0.5">
          This app expects the following agent{missing.length === 1 ? "" : "s"}, which {missing.length === 1 ? "isn't" : "aren't"} created yet:{" "}
          {missing.map((n) => <code key={n} className="px-1 rounded bg-amber-100 mx-0.5">{n}</code>)}
        </div>
        <div className="text-xs mt-1">Create them under <a href="/agents" className="underline">/agents</a>.</div>
      </div>
    </div>
  );
}

export type ReactChildren = ReactNode;
