import { useState } from "react";
import { Navigate } from "react-router-dom";
import { hardReset, useAuth } from "../lib/auth";
import { api } from "../lib/api";

export function LoginPage() {
  const { profile, signIn, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (profile) return <Navigate to="/knowledge" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setErr(null);
    try {
      if (mode === "signin") await signIn(email, password);
      else {
        await signUp(email, password);
        await signIn(email, password);
      }
      // Best-effort: claim admin if no admin exists yet.
      try { await api.post("/profiles/bootstrap-admin"); } catch { /* fine */ }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-full grid place-items-center bg-gradient-to-br from-violet-50 via-white to-fuchsia-50">
      <div className="card w-full max-w-sm p-6">
        <div className="size-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 grid place-items-center text-white font-semibold mb-4">
          H
        </div>
        <div className="text-lg font-semibold tracking-tight">
          {mode === "signin" ? "Welcome back" : "Create your account"}
        </div>
        <div className="text-sm text-ink-500 mt-0.5">
          The first user becomes admin automatically.
        </div>
        <form onSubmit={submit} className="mt-5 space-y-3">
          <div>
            <label className="label block mb-1">Email</label>
            <input
              className="input"
              type="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="label block mb-1">Password</label>
            <input
              className="input"
              type="password" required minLength={6}
              value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {err && <div className="text-rose-600 text-sm">{err}</div>}
          <button type="submit" disabled={submitting} className="btn-primary w-full justify-center">
            {submitting ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="text-xs text-ink-500 hover:text-ink-700 w-full text-center"
          >
            {mode === "signin" ? "Need an account? Sign up." : "Have an account? Sign in."}
          </button>
        </form>
        <button
          type="button"
          onClick={() => hardReset()}
          className="mt-3 text-[11px] text-ink-300 hover:text-ink-500 w-full text-center"
        >
          Reset local state
        </button>
      </div>
    </div>
  );
}
