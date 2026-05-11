// Auth context. Wraps the app, exposes the current Supabase session +
// derived `Profile`, and a `signIn`/`signUp`/`signOut` API.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabase";
import { api, setApiJwt, type Profile } from "./api";

// Wipe Supabase + Hub state from localStorage / sessionStorage and reload to
// the login page. Used as the escape hatch when an orphan session traps the
// user (eg. JWT survives a `supabase db reset`, or stale state from a prior
// dev iteration). Exposed via the "Reset local state" link on the login page
// and the "Stuck? Reset & sign in fresh" button on the loading screen.
export async function hardReset(): Promise<void> {
  try { await supabase.auth.signOut(); } catch { /* ignore */ }
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-") || k.startsWith("supabase") || k.startsWith("hub")) {
        localStorage.removeItem(k);
      }
    }
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith("sb-") || k.startsWith("supabase") || k.startsWith("hub")) {
        sessionStorage.removeItem(k);
      }
    }
  } catch { /* DOMException, ignore */ }
  window.location.replace("/login");
}

type AuthState = {
  loading: boolean;
  jwt: string | null;
  profile: Profile | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [jwt, setJwt] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  // `initial=true` is the first load after page mount. Only then do we treat a
  // 401/404 as an orphan session worth nuking — once a profile is already in
  // hand, transient failures (token refresh races, function cold starts) must
  // not bounce the user back to /login.
  async function loadProfile(initial = false) {
    try {
      const me = await api.get<Profile>("/profiles/me");
      setProfile(me);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (initial && (status === 401 || status === 404)) {
        console.warn("[auth] orphan session on initial load, hard-resetting:", (e as Error).message);
        await hardReset();
        return;
      }
      console.warn("[auth] loadProfile failed (keeping existing profile):", e);
    }
  }

  useEffect(() => {
    let mounted = true;
    let done = false;

    // Hard 5-second timeout. If anything below hangs, we still drop the
    // loading screen so the user can see the login form / error state.
    const timeout = setTimeout(() => {
      if (!done && mounted) {
        console.warn("[auth] initial getSession() took >5s, releasing the loading gate");
        setLoading(false);
      }
    }, 5000);

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) console.warn("[auth] getSession error:", error);
        if (!mounted) return;
        const token = data.session?.access_token ?? null;
        setJwt(token);
        setApiJwt(token);
        if (data.session) {
          try {
            await loadProfile(true);
          } catch (e) {
            console.warn("[auth] initial loadProfile failed:", e);
          }
        }
      } catch (e) {
        console.warn("[auth] getSession threw:", e);
      } finally {
        done = true;
        if (mounted) setLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[auth] state change:", event, !!session);
      const token = session?.access_token ?? null;
      setJwt(token);
      setApiJwt(token);
      try {
        if (session) await loadProfile();
        else setProfile(null);
      } catch (e) {
        console.warn("[auth] onAuthStateChange loadProfile failed:", e);
      }
    });

    return () => {
      mounted = false;
      clearTimeout(timeout);
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    loading, jwt, profile,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    signUp: async (email, password) => {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    },
    signOut: async () => { await supabase.auth.signOut(); },
    refreshProfile: loadProfile,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
