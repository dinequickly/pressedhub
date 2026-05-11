// /skills — List skills. "New skill" opens the builder route. The four
// prebuilt Anthropic skills (xlsx, pptx, docx, pdf) are seeded into the DB
// by migration 20260101000019 — they're always present.

import { useNavigate } from "react-router-dom";
import { LuSparkles, LuPlus } from "react-icons/lu";
import { type Skill } from "../lib/api";
import { useApi } from "../lib/swr";
import { EmptyState, Page } from "../components/Page";

export function SkillsPage() {
  const { data } = useApi<{ data: Skill[] }>("/skills");
  const nav = useNavigate();

  return (
    <Page
      title="Skills"
      subtitle="Reusable playbooks your agents can pull in when a job matches the brief."
      actions={
        <button className="btn-primary" onClick={() => nav("/skills/new")}>
          <LuPlus className="size-4" /> New skill
        </button>
      }
    >
      <div className="p-6">
        {!data?.data?.length ? (
          <EmptyState title="No skills yet" />
        ) : (
          <div className="card divide-y divide-neutral-100">
            {data.data.map((s) => (
              <button
                key={s.id}
                onClick={() => nav(`/skills/${s.id}`)}
                className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-neutral-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
              >
                <div className="size-9 rounded-lg bg-indigo-50 text-indigo-500 grid place-items-center shrink-0">
                  <LuSparkles className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium truncate">{s.name}</div>
                    <SkillTypeBadge type={s.type} />
                  </div>
                  <div className="text-xs text-ink-500 truncate">
                    {s.description || <span className="text-ink-300">No description</span>}
                  </div>
                </div>
                {s.type === "anthropic" && (
                  <div className="text-[11px] font-medium text-ink-400 shrink-0">
                    Managed
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

function SkillTypeBadge({ type }: { type: Skill["type"] }) {
  const label = type === "anthropic" ? "Managed" : "Custom";
  const cls = type === "anthropic"
    ? "bg-neutral-100 text-ink-600"
    : "bg-violet-50 text-violet-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}
