// /apps — Launcher. Each tile is a registered in-tree App. Tiles surface a
// "setup needed" badge when one of the App's declared agents hasn't been
// created yet. Click a tile → /apps/<slug>.

import { Link } from "react-router-dom";
import { LuTriangleAlert } from "react-icons/lu";
import { EmptyState, Page } from "../components/Page";
import { APPS, type AppManifest } from "../apps/registry";
import { useAppAgents } from "../apps/framework";

export function AppsPage() {
  return (
    <Page
      title="Apps"
      subtitle="Sub-applications inside the hub. Each app is built around one or more Managed Agents."
    >
      <div className="p-6">
        {APPS.length === 0 ? (
          <EmptyState
            title="No apps registered yet"
            body="Drop a directory into frontend/src/apps/<slug>/ and add a manifest entry to apps/registry.ts."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {APPS.map((m) => <AppTile key={m.slug} manifest={m} />)}
          </div>
        )}
      </div>
    </Page>
  );
}

function AppTile({ manifest }: { manifest: AppManifest }) {
  const { missing, loading } = useAppAgents(manifest);
  const Icon = manifest.icon;
  return (
    <Link
      to={`/apps/${manifest.slug}`}
      className="card p-4 flex flex-col hover:shadow-soft transition-shadow"
    >
      <div className="flex items-start gap-3">
        <div className={`size-10 rounded-xl bg-${manifest.tint}-50 text-${manifest.tint}-500 grid place-items-center`}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-medium truncate">{manifest.name}</div>
            {!loading && missing.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                <LuTriangleAlert className="size-3" /> setup
              </span>
            )}
          </div>
          <div className="text-xs text-ink-500 truncate">{manifest.tagline}</div>
        </div>
      </div>
      <p className="text-sm text-ink-500 mt-3 line-clamp-3">{manifest.description}</p>
      <div className="text-[11px] text-ink-500 mt-3">
        {manifest.agents.length === 0
          ? "No agents declared"
          : `Agents: ${manifest.agents.join(", ")}`}
      </div>
    </Link>
  );
}
