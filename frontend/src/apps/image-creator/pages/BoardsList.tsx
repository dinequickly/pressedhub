// Image Creator — boards list. Grid of cards, one per board the user owns.
// "+ New board" creates an empty board and routes to it. Rename / delete
// inline from the card menu.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuPlus, LuImage, LuPenLine, LuTrash2, LuStickyNote,
} from "react-icons/lu";
import { EmptyState, Modal, Page } from "../../../components/Page";
import { useApi, refresh } from "../../../lib/swr";
import { api, type VibeBoard } from "../../../lib/api";

export function BoardsListPage() {
  const nav = useNavigate();
  const { data, isLoading } = useApi<{ data: VibeBoard[] }>("/vibe-boards");
  const [busy, setBusy] = useState(false);

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
      <div className="p-6">
        {isLoading ? (
          <div className="text-sm text-ink-500">Loading…</div>
        ) : (data?.data ?? []).length === 0 ? (
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {(data?.data ?? []).map((b) => <BoardCard key={b.id} board={b} />)}
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
  const imageCount = items.filter((i) => i.type === "image").length;

  return (
    <div className="card p-4 flex flex-col">
      <button
        className="text-left flex-1"
        onClick={() => nav(`/apps/image-creator/boards/${board.id}`)}
      >
        <Thumbnail board={board} />
        <div className="font-medium truncate mt-3">{board.name}</div>
        <div className="text-[11px] text-ink-500 mt-0.5">
          {items.length} item{items.length === 1 ? "" : "s"} · {imageCount} generated · updated {timeAgo(board.updated_at)}
        </div>
      </button>
      <div className="flex gap-2 mt-3 pt-3 border-t border-neutral-100">
        <button className="btn-ghost" onClick={() => setRenaming(true)}>
          <LuPenLine className="size-3.5" /> Rename
        </button>
        <button
          className="btn-ghost ml-auto text-rose-600 hover:bg-rose-50"
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
  const items = board.state.items ?? [];
  const images = items.filter((i) => i.type === "image" || i.type === "reference").slice(0, 4);
  if (images.length === 0) {
    return (
      <div className="aspect-[16/10] rounded-lg bg-gradient-to-br from-fuchsia-50 to-amber-50 grid place-items-center text-fuchsia-300">
        <LuStickyNote className="size-6" />
      </div>
    );
  }
  return (
    <div className="aspect-[16/10] rounded-lg overflow-hidden grid grid-cols-2 grid-rows-2 gap-0.5 bg-neutral-100">
      {images.map((it) => (
        <div key={it.id} className="bg-neutral-200" />
      ))}
    </div>
  );
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
