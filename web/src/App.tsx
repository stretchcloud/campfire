import { useState, useEffect, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { connectSession, disconnectSession, setInviteToken, setInviteJoinInProgress } from "./ws.js";
import { api, getAuthToken, clearAuthToken } from "./api.js";
import { capturePageView } from "./analytics.js";
import { LoginPage } from "./components/LoginPage.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { HomePage } from "./components/HomePage.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { DiffPanel } from "./components/DiffPanel.js";
import { FilesPanel } from "./components/FilesPanel.js";
import { Playground } from "./components/Playground.js";
import { SessionLaunchProgress } from "./components/SessionLaunchProgress.js";
import { RecordingHub } from "./components/RecordingHub.js";
import { ProtocolMonitorPage } from "./components/ProtocolMonitorPage.js";
import { CommandsPage } from "./components/CommandsPage.js";
import { OnboardingWizard } from "./components/OnboardingWizard.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { UpdateOverlay } from "./components/UpdateOverlay.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { EnvManager } from "./components/EnvManager.js";
import { CronManager } from "./components/CronManager.js";
import { TerminalPage } from "./components/TerminalPage.js";
import { SessionReplay } from "./components/SessionReplay.js";
import { GalleryPage } from "./components/GalleryPage.js";
import { WebhookManager } from "./components/WebhookManager.js";
import { AdapterManager } from "./components/AdapterManager.js";
import { ClawHubBrowser } from "./components/ClawHubBrowser.js";
import { AgentsPage } from "./components/AgentsPage.js";
import { PublicReplayPage } from "./components/PublicReplayPage.js";
import { PromptsPage } from "./components/PromptsPage.js";
import { IntegrationsPage } from "./components/IntegrationsPage.js";
import { LinearSettingsPage } from "./components/LinearSettingsPage.js";
import { MemoryPanel } from "./components/MemoryPanel.js";
import { TaskRouterPage } from "./components/TaskRouterPage.js";
import { CollectiveMindPanel } from "./components/CollectiveMindPanel.js";
import { OrchestratorPage } from "./components/OrchestratorPage.js";
import { RacePage } from "./components/RacePage.js";
import { KanbanPage } from "./components/KanbanPage.js";
import { SkillsPage } from "./components/SkillsPage.js";

function useHash() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); },
    () => window.location.hash,
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    api.getAuthStatus().then((status) => {
      if (status.enabled && !status.isLoggedIn) {
        // Maybe we have a stored token — check it
        const token = getAuthToken();
        if (token) {
          // Token exists but server says not logged in — token is invalid
          clearAuthToken();
        }
        setAuthRequired(true);
      }
      setAuthChecked(true);
    }).catch(() => {
      // If we can't reach the server, just show the app
      setAuthChecked(true);
    });
  }, []);

  // Check if onboarding is needed
  useEffect(() => {
    api.getSettings().then((s) => {
      if (!s.onboardingCompleted) setShowOnboarding(true);
    }).catch(() => {});
  }, []);

  const darkMode = useStore((s) => s.darkMode);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const isSpectator = useStore((s) => {
    const sid = s.currentSessionId;
    if (!sid) return false;
    return (s.myRole.get(sid) ?? null) === "spectator";
  });
  const sidebarOpen = useStore((s) => {
    const sid = s.currentSessionId;
    if (sid && (s.myRole.get(sid) ?? null) === "spectator") return false;
    return s.sidebarOpen;
  });
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const homeResetKey = useStore((s) => s.homeResetKey);
  const activeTab = useStore((s) => s.activeTab);
  const updateOverlayActive = useStore((s) => s.updateOverlayActive);
  const hash = useHash();
  const isSettingsPage = hash === "#/settings";
  const isTerminalPage = hash === "#/terminal";
  const isEnvironmentsPage = hash === "#/environments";
  const isScheduledPage = hash === "#/scheduled";
  const isHubPage = hash === "#/hub";
  const isMonitorPage = hash === "#/monitor";
  const isCommandsPage = hash === "#/commands";
  const isGalleryPage = hash === "#/gallery" || hash.startsWith("#/gallery?");
  const gallerySessionId = isGalleryPage
    ? new URLSearchParams(hash.replace(/^#\/gallery\??/, "")).get("session") || undefined
    : undefined;
  const gallerySessionName = useStore((s) => {
    if (!gallerySessionId) return undefined;
    return s.sessionNames?.get(gallerySessionId) ||
      s.sdkSessions.find((sdk) => sdk.sessionId === gallerySessionId)?.name ||
      undefined;
  });
  const isWebhooksPage = hash === "#/webhooks";
  const isAdaptersPage = hash === "#/adapters";
  const isClawHubPage = hash === "#/clawhub";
  const isAgentsPage = hash === "#/agents";
  const isPromptsPage = hash === "#/prompts";
  const isIntegrationsPage = hash === "#/integrations";
  const isLinearSettingsPage = hash === "#/integrations/linear";
  const isMemoryPage = hash === "#/memory";
  const isRouterPage = hash === "#/router";
  const isCollectiveMindPage = hash === "#/collective";
  const isOrchestratorPage = hash === "#/orchestrator";
  const isRacesPage = hash === "#/races" || hash.startsWith("#/races/");
  const isKanbanPage = hash === "#/kanban";
  const isSkillsPage = hash === "#/skills";
  // Replay routes: #/replay/:filename or #/replay/session/:id
  const replayFileMatch = hash.match(/^#\/replay\/(?!session\/)(.+)$/);
  const replaySessionMatch = hash.match(/^#\/replay\/session\/(.+)$/);
  const isReplayPage = !!replayFileMatch || !!replaySessionMatch;
  // Public replay route: #/public-replay/:token
  const publicReplayMatch = hash.match(/^#\/public-replay\/(.+)$/);
  const isPublicReplayPage = !!publicReplayMatch;

  const isSessionView = !isSettingsPage && !isTerminalPage && !isEnvironmentsPage && !isScheduledPage && !isGalleryPage && !isWebhooksPage && !isAdaptersPage && !isClawHubPage && !isAgentsPage && !isPromptsPage && !isIntegrationsPage && !isLinearSettingsPage && !isMemoryPage && !isRouterPage && !isCollectiveMindPage && !isOrchestratorPage && !isRacesPage && !isKanbanPage && !isSkillsPage && !isReplayPage && !isPublicReplayPage && !isHubPage && !isMonitorPage && !isCommandsPage;

  useEffect(() => {
    capturePageView(hash || "#/");
  }, [hash]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Block connectAllSessions synchronously while an invite join hash is present,
  // so Sidebar's poll can't race and connect without the invite token.
  const isJoinHash = hash.startsWith("#/join/");
  if (isJoinHash) {
    setInviteJoinInProgress(true);
  }

  // Spectators can only view their session — redirect any other navigation back
  useEffect(() => {
    if (isSpectator && !isSessionView && !isJoinHash) {
      window.location.hash = "";
    }
  }, [isSpectator, isSessionView, isJoinHash]);

  // Handle invite join links: #/join/:token
  useEffect(() => {
    const match = hash.match(/^#\/join\/(.+)$/);
    if (!match) return;
    const token = match[1];
    api.joinSession(token).then((res) => {
      if (res.token) setInviteToken(res.token, res.session_id);
      // Disconnect any existing socket so we reconnect with the invite token.
      disconnectSession(res.session_id);
      useStore.getState().setCurrentSession(res.session_id);
      connectSession(res.session_id);
      // Unblock connectAllSessions now that the invite socket is established
      setInviteJoinInProgress(false);
      window.location.hash = "";
    }).catch(() => {
      console.warn(`[App] Invalid invite token: ${token}`);
      setInviteJoinInProgress(false);
      window.location.hash = "";
    });
  }, [hash]);

  // Auto-connect to restored session on mount
  useEffect(() => {
    const restoredId = useStore.getState().currentSessionId;
    if (restoredId) {
      connectSession(restoredId);
    }
  }, []);

  // Keep update state warm so Settings and the update banner never sit at "Loading...".
  useEffect(() => {
    if (!authChecked || authRequired) return;

    const check = () => {
      api.checkForUpdate()
        .then((info) => useStore.getState().setUpdateInfo(info))
        .catch(() => {});
    };

    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [authChecked, authRequired]);

  // Auth gates — placed after all hooks to satisfy Rules of Hooks
  if (!authChecked) {
    return <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg text-[12px] text-cc-muted">Loading...</div>;
  }

  if (authRequired) {
    return <LoginPage onLogin={() => setAuthRequired(false)} />;
  }

  if (hash === "#/playground") {
    return <Playground />;
  }

  return (
    <div className="h-[100dvh] flex font-sans-ui bg-cc-bg text-cc-fg antialiased text-[12.5px] leading-normal">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && !isSpectator && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => useStore.getState().setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — hidden for spectators, overlay on mobile, inline on desktop */}
      {!isSpectator && (
        <div
          className={`
            fixed md:relative z-40 md:z-auto
            h-full shrink-0 transition-all duration-150 ease-out
            ${sidebarOpen ? "w-[232px] translate-x-0" : "w-0 -translate-x-full md:w-0 md:-translate-x-full"}
            overflow-hidden
          `}
        >
          <Sidebar />
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <UpdateBanner />
        <div className="flex-1 overflow-hidden relative">
          {isSettingsPage && (
            <div className="absolute inset-0">
              <SettingsPage embedded />
            </div>
          )}

          {isTerminalPage && (
            <div className="absolute inset-0">
              <TerminalPage />
            </div>
          )}

          {isEnvironmentsPage && (
            <div className="absolute inset-0">
              <EnvManager embedded />
            </div>
          )}

          {isScheduledPage && (
            <div className="absolute inset-0">
              <CronManager embedded />
            </div>
          )}

          {isGalleryPage && (
            <div className="absolute inset-0">
              <GalleryPage embedded prefillSessionId={gallerySessionId} prefillName={gallerySessionName} />
            </div>
          )}
          {isHubPage && (
            <div className="absolute inset-0 overflow-y-auto">
              <RecordingHub embedded />
            </div>
          )}
          {isMonitorPage && (
            <div className="absolute inset-0 overflow-y-auto">
              <ProtocolMonitorPage embedded />
            </div>
          )}
          {isCommandsPage && (
            <div className="absolute inset-0 overflow-y-auto">
              <CommandsPage embedded />
            </div>
          )}

          {isWebhooksPage && (
            <div className="absolute inset-0">
              <WebhookManager embedded />
            </div>
          )}

          {isAdaptersPage && (
            <div className="absolute inset-0">
              <AdapterManager embedded />
            </div>
          )}

          {isClawHubPage && (
            <div className="absolute inset-0">
              <ClawHubBrowser embedded />
            </div>
          )}

          {isAgentsPage && (
            <div className="absolute inset-0">
              <AgentsPage embedded />
            </div>
          )}

          {isPromptsPage && (
            <div className="absolute inset-0">
              <PromptsPage embedded />
            </div>
          )}

          {isIntegrationsPage && (
            <div className="absolute inset-0">
              <IntegrationsPage embedded />
            </div>
          )}

          {isLinearSettingsPage && (
            <div className="absolute inset-0">
              <LinearSettingsPage embedded />
            </div>
          )}

          {isMemoryPage && (
            <div className="absolute inset-0">
              <MemoryPanel />
            </div>
          )}

          {isRouterPage && (
            <div className="absolute inset-0">
              <TaskRouterPage />
            </div>
          )}

          {isCollectiveMindPage && (
            <div className="absolute inset-0">
              <CollectiveMindPanel />
            </div>
          )}

          {isOrchestratorPage && (
            <div className="absolute inset-0">
              <OrchestratorPage />
            </div>
          )}

          {isRacesPage && (
            <div className="absolute inset-0">
              <RacePage />
            </div>
          )}

          {isKanbanPage && (
            <div className="absolute inset-0">
              <KanbanPage />
            </div>
          )}

          {isSkillsPage && (
            <div className="absolute inset-0">
              <SkillsPage embedded />
            </div>
          )}

          {isPublicReplayPage && publicReplayMatch && (
            <div className="absolute inset-0">
              <PublicReplayPage token={publicReplayMatch[1]} />
            </div>
          )}

          {isReplayPage && (
            <div className="absolute inset-0">
              {replaySessionMatch ? (
                <SessionReplay key={`session-${replaySessionMatch[1]}`} sessionId={replaySessionMatch[1]} />
              ) : replayFileMatch ? (
                <SessionReplay key={`file-${replayFileMatch[1]}`} filename={replayFileMatch[1]} />
              ) : null}
            </div>
          )}

          {isSessionView && (
            <>
              {/* Chat tab — visible when activeTab is "chat" or no session */}
              <div className={`absolute inset-0 ${activeTab === "chat" || !currentSessionId ? "" : "hidden"}`}>
                {currentSessionId ? (
                  <ChatView sessionId={currentSessionId} />
                ) : (
                  <HomePage key={homeResetKey} />
                )}
              </div>

              {/* Diff tab */}
              {currentSessionId && activeTab === "diff" && (
                <div className="absolute inset-0">
                  <DiffPanel sessionId={currentSessionId} />
                </div>
              )}

              {/* Files tab */}
              {currentSessionId && activeTab === "files" && (
                <div className="absolute inset-0">
                  <FilesPanel sessionId={currentSessionId} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && isSessionView && (
        <>
          {/* Mobile overlay backdrop */}
          {taskPanelOpen && (
            <div
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-30 lg:hidden"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              fixed lg:relative z-40 lg:z-auto right-0 top-0
              h-full shrink-0 transition-all duration-150 ease-out
              ${taskPanelOpen ? "w-[264px] translate-x-0" : "w-0 translate-x-full lg:w-0 lg:translate-x-full"}
              overflow-hidden
            `}
          >
            <TaskPanel sessionId={currentSessionId} />
          </div>
        </>
      )}
      {/* Global session launch progress toast */}
      <SessionLaunchProgress />

      {/* Onboarding wizard (first run only) */}
      {showOnboarding && <OnboardingWizard onComplete={() => setShowOnboarding(false)} />}
      <UpdateOverlay active={updateOverlayActive} />
    </div>
  );
}
