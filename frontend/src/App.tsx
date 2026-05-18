import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, hardReset, useAuth } from "./lib/auth";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { MemoryPage } from "./pages/MemoryPage";
import { DreamsPage } from "./pages/DreamsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
import { RunsPage } from "./pages/RunsPage";
import { RosterPage } from "./pages/RosterPage";
import { ChatPage } from "./pages/ChatPage";
import { AppsPage } from "./pages/AppsPage";
import { AppHost } from "./apps/framework";
import { SkillsPage } from "./pages/SkillsPage";
import { SkillBuilderPage } from "./pages/SkillBuilderPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SheetsPage } from "./pages/SheetsPage";
import { AnimationsPage } from "./pages/AnimationsPage";

function ProtectedRoutes() {
  const { loading, profile, jwt } = useAuth();
  // Show loading whenever we either haven't finished initial auth setup, OR
  // we have a JWT but the profile fetch is still in flight. The latter case
  // happens after the 5s initial-getSession timeout: the gate releases, then
  // a TOKEN_REFRESHED event arrives, JWT lands, and loadProfile is racing.
  // Without this, ProtectedRoutes would briefly see {jwt, !profile} and
  // redirect the user to /login before loadProfile resolves.
  if (loading || (jwt && !profile)) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 flex-col gap-3">
        <div>Loading…</div>
        <div className="text-[11px] font-mono">jwt: {jwt ? "✓" : "—"} · profile: {profile ? "✓" : "—"}</div>
        <button
          onClick={() => hardReset()}
          className="text-xs text-ink-500 hover:text-ink-900 underline"
        >
          Stuck? Reset & sign in fresh
        </button>
      </div>
    );
  }
  if (!profile) {
    return <Navigate to="/login" replace />;
  }
  return (
    <Routes>
      {/* Apps run full-screen with their own chrome — no hub sidebar. */}
      <Route path="/apps/:slug/*" element={<AppHost />} />
      {/* Everything else is wrapped in AppShell. */}
      <Route
        path="*"
        element={
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:sessionId" element={<ChatPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/sheets/:fileId" element={<SheetsPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/memory/:storeId" element={<MemoryPage />} />
              <Route path="/dreams" element={<DreamsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/environments" element={<EnvironmentsPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:sessionId" element={<RunsPage />} />
              <Route path="/roster" element={<RosterPage />} />
              <Route path="/apps" element={<AppsPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/skills/new" element={<SkillBuilderPage />} />
              <Route path="/skills/:id" element={<SkillBuilderPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/animations" element={<AnimationsPage />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </AppShell>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<ProtectedRoutes />} />
      </Routes>
    </AuthProvider>
  );
}
