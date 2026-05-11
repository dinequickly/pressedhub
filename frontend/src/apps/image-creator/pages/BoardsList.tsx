// Image Creator — boards list. Grid of cards, one per board the user owns.
// "+ New board" creates an empty board and routes to it. Rename / delete
// inline from the card menu.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuPlus, LuImage, LuImages, LuPenLine, LuTrash2, LuStickyNote, LuClock3,
} from "react-icons/lu";
import { EmptyState, Modal, Page } from "../../../components/Page";
import { useApi, refresh } from "../../../lib/swr";
import {
  api,
  type VibeBoard,
  type VibeBoardImageItem,
  type VibeBoardItem,
  type VibeBoardPromptItem,
  type VibeBoardReferenceItem,
} from "../../../lib/api";
import { FN_URL } from "../../../lib/supabase";
import { loadThumb } from "../lib/thumbCache";

export function BoardsListPage() {
  const nav = useNavigate();
  const { data, isLoading } = useApi<{ data: VibeBoard[] }>("/vibe-boards");
  const [busy, setBusy] = useState(false);
  const boards = data?.data ?? [];
  const summary = boards.reduce((acc, board) => {
    const counts = getBoardCounts(board.state.items ?? []);
    acc.items += counts.items;
    acc.generated += counts.generated;
    return acc;
  }, { items: 0, generated: 0 });

  async function createBoard() {
    setBusy(true);
    try {
      const created = await api.post<VibeBoard>("/vibe-boards", {});
      refresh("/vibe-boards");
      nav(`/apps/image-creator/boards/${created.id}`);
    } finally { setBusy(false); }
  }

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <LuImage className="size-5 text-fuchsia-500" />
          Image Creator
        </span>
      }
      subtitle="Vibe boards for marketing imagery. Each board is a canvas you and the Director agent work on together."
      actions={
        <button className="btn-primary" onClick={createBoard} disabled={busy}>
          <LuPlus className="size-4" /> New board
        </button>
      }
    >
      <div className="p-6 space-y-4">
        {!isLoading && boards.length > 0 && (
          <div className="card px-4 py-3 flex flex-wrap items-center gap-2 text-sm text-ink-700">
            <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-gray-600">
              <LuImages className="size-3.5" />
              Boards overview
            </span>
            <span>{boards.length} board{boards.length === 1 ? "" : "s"}</span>
            <span className="text-ink-300">•</span>
            <span>{summary.items} canvas item{summary.items === 1 ? "" : "s"}</span>
            <span className="text-ink-300">•</span>
            <span>{summary.generated} generated image{summary.generated === 1 ? "" : "s"}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-500">
              <LuClock3 className="size-3.5" />
              Most recently updated first
            </span>
          </div>
        )}
        {isLoading ? (
          <div className="text-sm text-ink-500">Loading…</div>
        ) : boards.length === 0 ? (
          <EmptyState
            title="No boards yet"
            body="Spin up your first board to start collecting prompts, references, and generated variants."
            action={
              <button className="btn-primary" onClick={createBoard} disabled={busy}>
                <LuPlus className="size-4" /> Create your first board
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {boards.map((b) => <BoardCard key={b.id} board={b} />)}
          </div>
        )}
      </div>
    </Page>
  );
}

function BoardCard({ board }: { board: VibeBoard }) {
  const nav = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const items = board.state.items ?? [];
  const counts = getBoardCounts(items);

  return (
    <div className="card group overflow-hidden flex flex-col text-ink-900 border-neutral-200/95 shadow-[0_20px_44px_rgba(15,23,42,0.08)]">
      <button
        className="text-left flex-1"
        onClick={() => nav(`/apps/image-creator/boards/${board.id}`)}
      >
        <div className="p-4 pb-3 space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-[1.02rem] leading-tight text-ink-950 truncate">
                {board.name}
              </div>
              <div className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-500">
                <LuClock3 className="size-3.5" />
                Updated {timeAgo(board.updated_at)}
              </div>
            </div>
            <div className="shrink-0 rounded-full bg-fuchsia-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
              {counts.generated} generated
            </div>
          </div>
          <Thumbnail board={board} />
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 font-medium text-ink-700">
              {counts.items} item{counts.items === 1 ? "" : "s"}
            </span>
            <span className="rounded-full bg-fuchsia-50 px-2.5 py-1 font-medium text-fuchsia-700">
              {counts.visuals} visual{counts.visuals === 1 ? "" : "s"}
            </span>
            {counts.prompts > 0 && (
              <span className="rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-700">
                {counts.prompts} prompt{counts.prompts === 1 ? "" : "s"}
              </span>
            )}
            {counts.notes > 0 && (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
                {counts.notes} note{counts.notes === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </button>
      <div className="flex gap-2 px-4 py-3 border-t border-neutral-200/90 bg-neutral-50/70">
        <button className="btn-ghost !text-ink-700 hover:!bg-white" onClick={() => setRenaming(true)}>
          <LuPenLine className="size-3.5" /> Rename
        </button>
        <button
          className="btn-ghost ml-auto !text-rose-600 hover:!bg-rose-50"
          onClick={() => setConfirmingDelete(true)}
        >
          <LuTrash2 className="size-3.5" /> Delete
        </button>
      </div>
      <RenameModal
        open={renaming}
        board={board}
        onClose={() => setRenaming(false)}
      />
      <DeleteModal
        open={confirmingDelete}
        board={board}
        onClose={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

function Thumbnail({ board }: { board: VibeBoard }) {
  const previews = useMemo(() => getBoardPreviewAssets(board).slice(0, 4), [board]);
  const sources = usePreviewSources(previews);
  const filled = previews.filter((preview) => !!sources[preview.key]);
  if (previews.length === 0) {
    return (
      <div className="aspect-[16/10] rounded-[1.1rem] bg-[radial-gradient(circle_at_top_left,_rgba(217,70,239,0.18),_rgba(255,255,255,0.98)_38%,_rgba(249,250,251,0.94))] border border-neutral-200 grid place-items-center text-center px-6">
        <div>
          <div className="mx-auto mb-2 size-10 rounded-2xl bg-white/90 border border-white shadow-[0_14px_28px_rgba(217,70,239,0.14)] grid place-items-center text-fuchsia-400">
            <LuStickyNote className="size-5" />
          </div>
          <div className="text-sm font-medium text-ink-800">No visuals yet</div>
          <div className="mt-1 text-xs leading-relaxed text-ink-500">
            Upload references or generate images to turn this board into a visual snapshot.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.18em] text-ink-500">
        <span>Latest visuals</span>
        <span>{filled.length}/{previews.length} loaded</span>
      </div>
      <div className="aspect-[16/10] rounded-[1.1rem] overflow-hidden grid grid-cols-2 grid-rows-2 gap-1.5 bg-neutral-200/80 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
        {Array.from({ length: 4 }, (_, index) => {
          const preview = previews[index];
          if (!preview) {
            return (
              <div
                key={`empty-${index}`}
                className="rounded-xl border border-dashed border-neutral-300 bg-white/70"
              />
            );
          }
          const src = sources[preview.key];
          return (
            <div
              key={preview.key}
              className="relative rounded-xl overflow-hidden bg-neutral-300"
            >
              {src ? (
                <img
                  src={src}
                  alt={preview.label}
                  className="size-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="size-full animate-pulse bg-[linear-gradient(135deg,_rgba(255,255,255,0.55),_rgba(229,231,235,0.95))]" />
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent px-2 py-1.5">
                <div className="truncate text-[10px] font-medium text-white/92">
                  {preview.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type BoardPreviewAsset = {
  key: string;
  label: string;
  mediaId?: string;
  src?: string;
  rank: number;
  order: number;
  priority: number;
};

function getBoardCounts(items: VibeBoardItem[]) {
  let visuals = 0;
  let prompts = 0;
  let notes = 0;
  let generated = 0;
  for (const item of items) {
    if (item.type === "prompt") {
      prompts++;
      generated += item.generations?.length ?? 0;
    } else if (item.type === "note") {
      notes++;
    }
    if (item.type === "image" || item.type === "reference") visuals++;
  }
  return {
    items: items.length,
    generated,
    prompts,
    notes,
    visuals: visuals + generated,
  };
}

function getBoardPreviewAssets(board: VibeBoard): BoardPreviewAsset[] {
  const items = board.state.items ?? [];
  const previews: BoardPreviewAsset[] = [];
  items.forEach((item, index) => {
    const order = items.length - index;
    if (item.type === "prompt") {
      previews.push(...getPromptPreviewAssets(item, order));
      return;
    }
    if (item.type === "image") {
      const preview = getImagePreviewAsset(item, order);
      if (preview) previews.push(preview);
      return;
    }
    if (item.type === "reference") {
      const preview = getReferencePreviewAsset(item, order);
      if (preview) previews.push(preview);
    }
  });
  const seen = new Set<string>();
  return previews
    .sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.order - a.order;
    })
    .filter((preview) => {
      const dedupeKey = preview.mediaId ? `media:${preview.mediaId}` : `src:${preview.src}`;
      if (!dedupeKey || seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
}

function getPromptPreviewAssets(item: VibeBoardPromptItem, order: number): BoardPreviewAsset[] {
  return (item.generations ?? []).map((generation, index) => ({
    key: generation.id,
    label: item.text.trim()
      ? `${item.text.trim().slice(0, 24)}${item.text.trim().length > 24 ? "…" : ""} · gen ${index + 1}`
      : `Generated image ${index + 1}`,
    mediaId: generation.media_asset_id,
    rank: Date.parse(generation.generated_at) || 0,
    order,
    priority: 3,
  }));
}

function getImagePreviewAsset(item: VibeBoardImageItem, order: number): BoardPreviewAsset | null {
  if (!item.media_asset_id && !item.url) return null;
  return {
    key: item.id,
    label: item.name || item.caption || item.prompt || "Board image",
    mediaId: item.media_asset_id,
    src: item.url,
    rank: 0,
    order,
    priority: 2,
  };
}

function getReferencePreviewAsset(item: VibeBoardReferenceItem, order: number): BoardPreviewAsset | null {
  if (!item.media_asset_id && !item.url) return null;
  return {
    key: item.id,
    label: item.caption || "Reference image",
    mediaId: item.media_asset_id,
    src: item.url,
    rank: 0,
    order,
    priority: 1,
  };
}

function usePreviewSources(previews: BoardPreviewAsset[]) {
  const [sources, setSources] = useState<Record<string, string>>({});
  const previewSignature = previews
    .map((preview) => [preview.key, preview.mediaId ?? "", preview.src ?? ""].join(":"))
    .join("|");

  useEffect(() => {
    let cancelled = false;
    const localObjectUrls: string[] = [];
    setSources({});

    previews.forEach((preview) => {
      void (async () => {
        const resolved = await resolvePreviewSource(preview, localObjectUrls);
        if (!resolved || cancelled) return;
        setSources((current) => ({ ...current, [preview.key]: resolved }));
      })();
    });

    return () => {
      cancelled = true;
      for (const url of localObjectUrls) URL.revokeObjectURL(url);
    };
  }, [previewSignature, previews]);

  return sources;
}

async function resolvePreviewSource(
  preview: BoardPreviewAsset,
  localObjectUrls: string[],
): Promise<string | null> {
  if (preview.src) {
    if (!preview.src.startsWith(`${FN_URL}/media/`)) return preview.src;
    try {
      const res = await api.getRaw(preview.src.slice(FN_URL.length));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      localObjectUrls.push(url);
      return url;
    } catch {
      return null;
    }
  }
  if (!preview.mediaId) return null;
  try {
    return await loadThumb(preview.mediaId);
  } catch {
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return await loadThumb(preview.mediaId);
    } catch {
      return null;
    }
  }
}

function RenameModal({
  open, board, onClose,
}: { open: boolean; board: VibeBoard; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title="Rename board"
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch(`/vibe-boards/${board.id}`, { name: name.trim() });
                refresh("/vibe-boards");
                onClose();
              } finally { setBusy(false); }
            }}
          >
            Save
          </button>
        </div>
      }
    >
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
    </Modal>
  );
}

function DeleteModal({
  open, board, onClose,
}: { open: boolean; board: VibeBoard; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title={`Delete "${board.name}"?`}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.del(`/vibe-boards/${board.id}`);
                refresh("/vibe-boards");
                onClose();
              } finally { setBusy(false); }
            }}
          >
            Delete
          </button>
        </div>
      }
    >
      <div className="text-sm text-ink-500">
        This deletes the board and its items. The Director conversation tied to
        this board is also unlinked. This can't be undone.
      </div>
    </Modal>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
