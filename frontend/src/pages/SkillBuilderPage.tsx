// /skills/new and /skills/:id — Two-pane builder. Left: chat that drafts
// SKILL.md via /skills/draft. Right: tabs for the SKILL.md WYSIWYG editor
// and a one-shot Test run. Save calls the existing /skills POST/PATCH which
// already syncs to Anthropic.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  LuArrowLeft, LuSend, LuSparkles, LuFileText, LuPlay, LuLoader,
} from "react-icons/lu";
import { api, type Skill } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { Page, StatusPill } from "../components/Page";
import { MarkdownEditor } from "../components/MarkdownEditor";

type ChatMsg = { role: "user" | "assistant"; content: string };

const TRY_PROMPTS = [
  "Build me a skill that formats quarterly board updates",
  "A skill that turns customer interviews into research-brief PDFs",
  "Make a skill that reviews PRs against our coding style",
  "A skill that drafts Slack updates in our company tone",
];

export function SkillBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data: existing } = useApi<Skill>(id ? `/skills/${id}` : null);

  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: "I can draft a skill from a description, then iterate with you. What should it do?" },
  ]);
  const [input, setInput] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [contentMd, setContentMd] = useState("");
  const [name, setName] = useState("New skill");
  const [description, setDescription] = useState("");
  const [tab, setTab] = useState<"skill" | "test">("skill");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isAnthropic = existing?.type === "anthropic";

  // When loading an existing skill, hydrate state once. Older skills (drafted
  // before we split description out of the body) may still have YAML
  // frontmatter at the top of content_md — strip it for clean rendering.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!existing || hydrated.current) return;
    hydrated.current = true;
    setName(existing.name);
    const fm = existing.content_md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    let body = existing.content_md;
    let frontmatterDesc = "";
    if (fm) {
      body = existing.content_md.slice(fm[0].length).trimStart();
      const dl = fm[1].match(/^description:\s*(.+?)\s*$/m);
      if (dl) frontmatterDesc = dl[1].replace(/^["']|["']$/g, "").trim();
    }
    setDescription(existing.description || frontmatterDesc);
    setContentMd(body);
    setMessages([{
      role: "assistant",
      content: `Loaded "${existing.name}". Tell me what to change.`,
    }]);
  }, [existing]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || drafting) return;
    setInput("");
    setErr(null);
    const next: ChatMsg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setDrafting(true);
    try {
      const res = await api.post<{
        assistant_message: string;
        content_md: string;
        description: string;
      }>("/skills/draft", { messages: next, current_md: contentMd });
      setContentMd(res.content_md);
      setMessages([...next, { role: "assistant", content: res.assistant_message }]);
      // Best-effort: pull a title out of the first H1 in the markdown.
      const m = res.content_md.match(/^#\s+(.+)$/m);
      if (m && (name === "New skill" || name === "")) setName(m[1].trim());
      // Mirror the frontmatter description into the description input so the
      // user sees the same one-liner that gets saved with the skill.
      if (res.description) setDescription(res.description);
    } catch (e) {
      setErr((e as Error).message);
      setMessages([...next, { role: "assistant", content: "Sorry — I hit an error. Try again?" }]);
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    if (!name || !contentMd) {
      setErr("Need a name and a SKILL.md before saving.");
      return;
    }
    setSaving(true); setErr(null);
    try {
      const body = { type: "custom" as const, name, description, content_md: contentMd };
      if (existing) await api.patch(`/skills/${existing.id}`, body);
      else await api.post("/skills", body);
      refresh("/skills");
      nav("/skills");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (isAnthropic && existing) {
    return <AnthropicSkillView skill={existing} onBack={() => nav("/skills")} />;
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <button className="btn-ghost size-8 p-0 grid place-items-center" onClick={() => nav("/skills")}>
            <LuArrowLeft className="size-4" />
          </button>
          <input
            className="text-xl font-semibold tracking-tight bg-transparent outline-none border-b border-transparent focus:border-neutral-300 px-0.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </span>
      }
      actions={
        <button className="btn-primary" disabled={saving || !contentMd} onClick={save}>
          {saving ? "Saving…" : existing ? "Save" : "Create"}
        </button>
      }
    >
      <div className="grid grid-cols-12 h-full min-h-0">
        <ConversationPane
          messages={messages}
          input={input}
          drafting={drafting}
          onInput={setInput}
          onSend={() => send(input)}
          onPick={(p) => send(p)}
          err={err}
        />
        <div className="col-span-8 flex flex-col min-h-0">
          <div className="px-5 pt-4 border-b border-neutral-200 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Tab active={tab === "skill"} onClick={() => setTab("skill")} icon={<LuFileText className="size-4" />}>
                SKILL.md
              </Tab>
              <Tab active={tab === "test"} onClick={() => setTab("test")} icon={<LuPlay className="size-4" />} disabled={!contentMd}>
                Test run
              </Tab>
            </div>
          </div>

          {tab === "skill"
            ? (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="max-w-3xl mx-auto w-full px-8 pt-6 pb-2">
                  <label className="label block mb-1">Description</label>
                  <input
                    className="input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="One sentence the agent reads to decide when to use this skill"
                  />
                </div>
                <div className="px-8 py-4 max-w-3xl mx-auto w-full">
                  <label className="label block mb-2">SKILL.md</label>
                  <MarkdownEditor
                    value={contentMd}
                    onChange={setContentMd}
                    placeholder="Start writing your skill, or describe it in the chat to draft one."
                  />
                </div>
              </div>
            )
            : <TestRunPane contentMd={contentMd} />}
        </div>
      </div>
    </Page>
  );
}

function ConversationPane({
  messages, input, drafting, onInput, onSend, onPick, err,
}: {
  messages: ChatMsg[];
  input: string;
  drafting: boolean;
  onInput: (s: string) => void;
  onSend: () => void;
  onPick: (s: string) => void;
  err: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, drafting]);

  return (
    <div className="col-span-4 border-r border-neutral-200 flex flex-col min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-neutral-200">
        <div className="font-medium text-sm">Conversation</div>
        <div className="text-xs text-ink-500">Describe what the skill should do, then refine.</div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.map((m, i) => <Bubble key={i} m={m} />)}
        {drafting && (
          <div className="flex items-start gap-2 text-sm text-ink-500">
            <LuSparkles className="size-4 mt-1 text-violet-500" />
            <div className="flex items-center gap-2">
              <LuLoader className="size-3.5 animate-spin" /> drafting…
            </div>
          </div>
        )}
        {err && <div className="text-rose-600 text-xs">{err}</div>}
      </div>
      {messages.length <= 1 && (
        <div className="px-5 pb-3">
          <div className="label mb-2">Try one</div>
          <div className="flex flex-col gap-1.5">
            {TRY_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => onPick(p)}
                className="text-left text-xs text-ink-700 px-3 py-1.5 rounded-full border border-neutral-200 hover:border-violet-300 hover:bg-violet-50/30 truncate"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="p-3 border-t border-neutral-200">
        <div className="flex items-end gap-2">
          <textarea
            className="input resize-none min-h-[44px] max-h-32"
            rows={1}
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder='e.g. "make the tone more casual" or describe a new skill'
          />
          <button className="btn-primary size-10 p-0 grid place-items-center" disabled={!input.trim() || drafting} onClick={onSend}>
            <LuSend className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMsg }) {
  const isUser = m.role === "user";
  return (
    <div className={`flex gap-2 ${isUser ? "justify-end" : ""}`}>
      {!isUser && (
        <div className="size-7 rounded-lg bg-violet-50 grid place-items-center shrink-0 text-violet-500">
          <LuSparkles className="size-4" />
        </div>
      )}
      <div className={[
        "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
        isUser ? "bg-amber-50 text-ink-800" : "bg-neutral-100 text-ink-800",
      ].join(" ")}>
        {m.content}
      </div>
    </div>
  );
}

function AnthropicSkillView({ skill, onBack }: { skill: Skill; onBack: () => void }) {
  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <button className="btn-ghost size-8 p-0 grid place-items-center" onClick={onBack}>
            <LuArrowLeft className="size-4" />
          </button>
          <span className="text-xl font-semibold tracking-tight">{skill.name}</span>
          <StatusPill status="anthropic" />
        </span>
      }
    >
      <div className="p-8 max-w-2xl">
        <p className="text-sm text-ink-500 mb-6">
          Prebuilt skill maintained by Anthropic. Reference it by id when configuring an
          agent — the SKILL.md isn&apos;t editable here.
        </p>
        <div className="card p-5 space-y-4">
          <div>
            <div className="label mb-1">Description</div>
            <div className="text-sm">{skill.description || <span className="text-ink-500">—</span>}</div>
          </div>
          <div>
            <div className="label mb-1">Skill id</div>
            <div className="font-mono text-xs">{skill.anthropic_skill_id}</div>
          </div>
          <div>
            <div className="label mb-1">Version</div>
            <div className="font-mono text-xs">{skill.version}</div>
          </div>
        </div>
      </div>
    </Page>
  );
}

function Tab({
  active, icon, children, onClick, disabled,
}: {
  active: boolean; icon: React.ReactNode; children: React.ReactNode;
  onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px",
        active
          ? "border-ink-900 text-ink-900"
          : "border-transparent text-ink-500 hover:text-ink-700",
        disabled ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}

function TestRunPane({ contentMd }: { contentMd: string }) {
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!prompt.trim() || !contentMd) return;
    setRunning(true); setErr(null); setOutput(null);
    try {
      const res = await api.post<{ output: string }>("/skills/test-run", {
        content_md: contentMd, prompt: prompt.trim(),
      });
      setOutput(res.output);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6 max-w-3xl mx-auto w-full space-y-4">
      <div className="text-sm text-ink-500">
        Sends a one-shot prompt to Claude with this SKILL.md as the system prompt.
        It does not create an Anthropic skill or session.
      </div>
      <textarea
        className="input resize-none"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Try a prompt that should trigger this skill…"
      />
      <div>
        <button className="btn-primary" disabled={!prompt.trim() || running} onClick={run}>
          {running ? <><LuLoader className="size-4 animate-spin" /> Running</> : <><LuPlay className="size-4" /> Run</>}
        </button>
      </div>
      {err && <div className="text-rose-600 text-sm">{err}</div>}
      {output !== null && (
        <div className="card p-4 text-sm whitespace-pre-wrap">{output}</div>
      )}
    </div>
  );
}
