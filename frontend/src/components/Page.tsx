import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export function Page({
  title, subtitle, actions, children,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-6 pt-5 pb-4 border-b border-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          {typeof title === "string"
            ? <h1 className="text-[1.35rem] font-semibold tracking-tight">{title}</h1>
            : <div className="text-[1.35rem] font-semibold tracking-tight">{title}</div>}
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl leading-relaxed">{subtitle}</p>}
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
      <div className="mx-auto size-10 rounded-xl bg-muted text-muted-foreground grid place-items-center mb-3 text-lg">
        ○
      </div>
      <div className="font-medium">{title}</div>
      {body && <div className="text-sm text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  connected:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired:      "bg-amber-50 text-amber-700 border-amber-200",
  idle:         "bg-secondary text-secondary-foreground border-transparent",
  running:      "bg-sky-50 text-sky-700 border-sky-200",
  rescheduling: "bg-amber-50 text-amber-700 border-amber-200",
  terminated:   "bg-rose-50 text-rose-700 border-rose-200",
  completed:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending:      "bg-amber-50 text-amber-700 border-amber-200",
  approved:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected:     "bg-rose-50 text-rose-700 border-rose-200",
  failed:       "bg-rose-50 text-rose-700 border-rose-200",
  canceled:     "bg-secondary text-secondary-foreground border-transparent",
  deployed:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  draft:        "bg-secondary text-secondary-foreground border-transparent",
  uploaded:     "bg-secondary text-secondary-foreground border-transparent",
  extracted:    "bg-violet-50 text-violet-700 border-violet-200",
  chunked:      "bg-sky-50 text-sky-700 border-sky-200",
  embedded:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  never:        "bg-secondary text-secondary-foreground border-transparent",
};

export function StatusPill({ status }: { status: string }) {
  const cls = STATUS_CLASS[status] ?? "bg-secondary text-secondary-foreground border-transparent";
  return (
    <Badge
      variant="outline"
      className={cn("text-[11px] uppercase tracking-wide font-medium", cls)}
    >
      {status}
    </Badge>
  );
}

export function Modal({
  open, onClose, title, children, footer, containerClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  containerClassName?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "max-h-[85vh] overflow-hidden flex flex-col p-0 gap-0",
          containerClassName ?? "max-w-2xl",
        )}
      >
        {title && (
          <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
            {typeof title === "string"
              ? <DialogTitle>{title}</DialogTitle>
              : <div>{title}</div>}
          </DialogHeader>
        )}
        <div className="overflow-y-auto p-5 flex-1">{children}</div>
        {footer && (
          <DialogFooter className="px-5 py-3 border-t border-border bg-muted/50 shrink-0 flex items-center">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
