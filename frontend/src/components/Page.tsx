// Shared page chrome: header with title + action slot, scrollable content area.

import type { ReactNode } from "react";

export function Page({
  title, subtitle, actions, children,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-white">
      <div className="px-6 pt-6 pb-5 border-b border-neutral-100 bg-white flex items-start justify-between gap-4">
        <div className="min-w-0">
          {typeof title === "string"
            ? <h1 className="text-[1.45rem] font-semibold tracking-tight text-ink-950">{title}</h1>
            : <div className="text-[1.45rem] font-semibold tracking-tight text-ink-950">{title}</div>}
          {subtitle && <p className="text-sm text-ink-500 mt-1 max-w-2xl leading-relaxed">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function EmptyState({
  title, body, action,
}: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="p-10 text-center">
      <div className="mx-auto size-10 rounded-xl bg-neutral-100 text-neutral-500 grid place-items-center mb-3">
        ○
      </div>
      <div className="font-medium text-ink-900">{title}</div>
      {body && <div className="text-sm text-ink-500 mt-1 max-w-md mx-auto leading-relaxed">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    connected: "bg-emerald-50 text-emerald-600",
    expired: "bg-amber-50 text-amber-600",
    never: "bg-neutral-100 text-ink-500",
    idle: "bg-neutral-100 text-ink-500",
    running: "bg-sky-50 text-sky-600",
    rescheduling: "bg-amber-50 text-amber-600",
    terminated: "bg-rose-50 text-rose-600",
    completed: "bg-emerald-50 text-emerald-600",
    pending: "bg-amber-50 text-amber-600",
    approved: "bg-emerald-50 text-emerald-600",
    rejected: "bg-rose-50 text-rose-600",
    failed: "bg-rose-50 text-rose-600",
    canceled: "bg-neutral-100 text-ink-500",
    deployed: "bg-emerald-50 text-emerald-600",
    draft: "bg-neutral-100 text-ink-500",
    uploaded: "bg-neutral-100 text-ink-500",
    extracted: "bg-violet-50 text-violet-600",
    chunked: "bg-sky-50 text-sky-600",
    embedded: "bg-emerald-50 text-emerald-600",
  };
  const cls = map[status] ?? "bg-neutral-100 text-ink-500";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

export function Modal({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 grid place-items-center p-4 bg-ink-900/30" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-card border border-neutral-200 w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="px-5 py-4 border-b border-neutral-200">
            {typeof title === "string" ? <h2 className="text-base font-semibold">{title}</h2> : title}
          </div>
        )}
        <div className="overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-neutral-200 bg-neutral-50">{footer}</div>}
      </div>
    </div>
  );
}
