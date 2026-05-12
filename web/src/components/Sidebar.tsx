import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent, type ReactNode } from "react";
import { useStore } from "../store.js";
import { api, type SessionFolder } from "../api.js";
import { connectSession, connectAllSessions, disconnectSession } from "../ws.js";
import { SessionItem } from "./SessionItem.js";
import { type SessionItem as SessionItemType } from "../utils/project-grouping.js";

/* ─── Time Grouping ─────────────────────────────────────────────── */

function getTimeGroup(createdAt: number): string {
  if (!createdAt) return "Older";
  const today = new Date();
  const sessionDate = new Date(createdAt);
  if (sessionDate.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sessionDate.toDateString() === yesterday.toDateString()) return "Yesterday";
  const diff = Date.now() - createdAt;
  const day = 86400000;
  if (diff < 7 * day) return "Previous 7 Days";
  return "Older";
}

const TIME_GROUP_ORDER = ["Today", "Yesterday", "Previous 7 Days", "Older"];

/* ─── Nav Item Types ───────────────────────────────────────────── */

interface NavItem {
  label: string;
  hash: string;
  icon: ReactNode;
}

/* ─── Nav Sections ─────────────────────────────────────────────── */


const NAV_TOOLS: NavItem[] = [
  {
    label: "Terminal",
    hash: "#/terminal",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z" />
      </svg>
    ),
  },
  {
    label: "Dmux",
    hash: "#/dmux",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 2h5.5v5.5H2V2zm.75.75v4h4v-4h-4zM8.5 2H14v5.5H8.5V2zm.75.75v4h4v-4h-4zM2 8.5h5.5V14H2V8.5zm.75.75v4h4v-4h-4zM8.5 8.5H14V14H8.5V8.5zm.75.75v4h4v-4h-4z" />
      </svg>
    ),
  },
  {
    label: "Orchestrator",
    hash: "#/orchestrator",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1.5h-13V3zM1.5 6h13v1.5h-13V6zM1.5 9h13v1.5h-13V9zM1.5 12v1A1.5 1.5 0 003 14.5h10a1.5 1.5 0 001.5-1.5v-1h-13z" />
      </svg>
    ),
  },
  {
    label: "Races",
    hash: "#/races",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M3 2.5A1.5 1.5 0 014.5 1h1A1.5 1.5 0 017 2.5v1A1.5 1.5 0 015.5 5h-1A1.5 1.5 0 013 3.5v-1zM9 2.5A1.5 1.5 0 0110.5 1h1A1.5 1.5 0 0113 2.5v1A1.5 1.5 0 0111.5 5h-1A1.5 1.5 0 019 3.5v-1zM3 12.5A1.5 1.5 0 014.5 11h1A1.5 1.5 0 017 12.5v1A1.5 1.5 0 015.5 15h-1A1.5 1.5 0 013 13.5v-1zM9 12.5a1.5 1.5 0 011.5-1.5h1a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5h-1A1.5 1.5 0 019 13.5v-1zM5 6h1v1.5h4V6h1v4h-1V8.5H6V10H5V6z" />
      </svg>
    ),
  },
  {
    label: "Kanban",
    hash: "#/kanban",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1.5 2h4v12h-4V2zm.75.75v10.5h2.5V2.75h-2.5zM6 2h4v8H6V2zm.75.75v6.5h2.5v-6.5h-2.5zM10.5 2h4v10h-4V2zm.75.75v8.5h2.5v-8.5h-2.5z" />
      </svg>
    ),
  },
  {
    label: "Monitor",
    hash: "#/monitor",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h11A1.5 1.5 0 0115 3.5v6a1.5 1.5 0 01-1.5 1.5H10v1.5h1.5a.5.5 0 010 1h-7a.5.5 0 010-1H6V11H2.5A1.5 1.5 0 011 9.5v-6zM2.5 3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-6a.5.5 0 00-.5-.5h-11z" />
      </svg>
    ),
  },
];

const NAV_DATA: NavItem[] = [
  {
    label: "Environments",
    hash: "#/environments",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
      </svg>
    ),
  },
  {
    label: "Scheduled",
    hash: "#/scheduled",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
      </svg>
    ),
  },
  {
    label: "Gallery",
    hash: "#/gallery",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1H2V3zm0 2.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7zM4 7v3h3V7H4zm5 0v1h3V7H9zm3 2.5H9V11h3V9.5z" />
      </svg>
    ),
  },
  {
    label: "Webhooks",
    hash: "#/webhooks",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M5.5 1a.5.5 0 01.5.5v2a2.5 2.5 0 005 0v-2a.5.5 0 011 0v2a3.5 3.5 0 01-3 3.465V8.5h2a.5.5 0 010 1H9v2.035A3.5 3.5 0 0112 15a.5.5 0 010-1 2.5 2.5 0 01-2.5-2.5V9.5h-3v2A2.5 2.5 0 014 14a.5.5 0 010 1 3.5 3.5 0 003-3.465V9.5H5a.5.5 0 010-1h2V6.965A3.5 3.5 0 014 3.5v-2a.5.5 0 01.5-.5 .5.5 0 01.5.5v2a2.5 2.5 0 005 0v-2a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Recordings",
    hash: "#/hub",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

const NAV_CONFIG: NavItem[] = [
  {
    label: "Adapters",
    hash: "#/adapters",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 4a2 2 0 012-2h1.5a.5.5 0 010 1H4a1 1 0 00-1 1v2.5a.5.5 0 01-1 0V4zm0 8a2 2 0 002 2h1.5a.5.5 0 000-1H4a1 1 0 01-1-1V9.5a.5.5 0 00-1 0V12zm12-8a2 2 0 00-2-2h-1.5a.5.5 0 000 1H12a1 1 0 011 1v2.5a.5.5 0 001 0V4zm0 8a2 2 0 01-2 2h-1.5a.5.5 0 010-1H12a1 1 0 001-1V9.5a.5.5 0 011 0V12zM6 8a2 2 0 114 0 2 2 0 01-4 0z" />
      </svg>
    ),
  },
  {
    label: "Commands",
    hash: "#/commands",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M6.646 5.646a.5.5 0 01.708 0l2.5 2.5a.5.5 0 010 .708l-2.5 2.5a.5.5 0 01-.708-.708L8.793 8.5H1.5a.5.5 0 010-1h7.293L6.646 5.354a.5.5 0 010-.708zM12.5 2a.5.5 0 01.5.5v11a.5.5 0 01-1 0v-11a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Agents",
    hash: "#/agents",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H3z" />
      </svg>
    ),
  },
  {
    label: "Prompts",
    hash: "#/prompts",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 5h6M5 8h6M5 11h4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Skills",
    hash: "#/skills",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 001.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 00-1.828 1.829l-.645 1.936a.361.361 0 01-.686 0l-.645-1.937a2.89 2.89 0 00-1.828-1.828l-1.937-.645a.361.361 0 010-.686l1.937-.645a2.89 2.89 0 001.828-1.829l.645-1.936zM3.794 1.148a.217.217 0 01.412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 010 .412l-1.162.387A1.734 1.734 0 004.593 5.69l-.387 1.162a.217.217 0 01-.412 0L3.407 5.69a1.734 1.734 0 00-1.097-1.097l-1.162-.387a.217.217 0 010-.412l1.162-.387A1.734 1.734 0 003.407 2.31l.387-1.162z" />
      </svg>
    ),
  },
  {
    label: "Integrations",
    hash: "#/integrations",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M4.5 2a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2zM11.5 9a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2zM7.5 4.5a.5.5 0 01.5.5v2.5h1a.5.5 0 010 1H8V11a.5.5 0 01-1 0V8.5H5.5a.5.5 0 010-1H7V5a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Memory",
    hash: "#/memory",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1H3zm2 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h4a.5.5 0 010 1H5a.5.5 0 010-1z" />
      </svg>
    ),
  },
  {
    label: "Router",
    hash: "#/router",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    label: "Collective",
    hash: "#/collective",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 0a8 8 0 110 16A8 8 0 018 0zM4.5 7.5a.5.5 0 000 1h7a.5.5 0 000-1h-7zM4 5.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zm4.5 5a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
      </svg>
    ),
  },
  {
    label: "ClawHub",
    hash: "#/clawhub",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.5 4.5a1 1 0 11-2 0 1 1 0 012 0zM8 13a5 5 0 01-4.33-2.5.5.5 0 01.87-.5A4 4 0 008 12a4 4 0 003.46-2 .5.5 0 01.87.5A5 5 0 018 13zm-3.5-8.5a1 1 0 110 2 1 1 0 010-2z" />
      </svg>
    ),
  },
];

const INITIAL_SESSIONS_SHOWN = 5;

/* ─── Component ─────────────────────────────────────────────────── */

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  const [searchQuery, setSearchQuery] = useState("");
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("cc-collapsed-nav-sections");
      return saved ? new Set(JSON.parse(saved)) : new Set(["Tools", "Data", "Config"]);
    } catch {
      return new Set(["Tools", "Data", "Config"]);
    }
  });
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const completedSubagentSessions = useStore((s) => s.completedSubagentSessions);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse);

  /* Folder state (kept for logic compatibility) */
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("cc-collapsed-folders");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  /* ─── Poll for SDK sessions on mount ───────────────────────────── */
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          connectAllSessions(list);
          const store = useStore.getState();
          for (const s of list) {
            if (
              s.name &&
              (!store.sessionNames.has(s.sessionId) ||
                /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(store.sessionNames.get(s.sessionId)!))
            ) {
              const currentStoreName = store.sessionNames.get(s.sessionId);
              const hadRandomName =
                !!currentStoreName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentStoreName);
              if (currentStoreName !== s.name) {
                store.setSessionName(s.sessionId, s.name);
                if (hadRandomName) {
                  store.markRecentlyRenamed(s.sessionId);
                }
              }
            }
          }
        }
      } catch {
        // server not ready
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  /* Load folders on mount */
  useEffect(() => {
    api.listFolders().then(setFolders).catch(() => {});
  }, []);

  /* Keyboard shortcut for search (Ctrl+K) */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  function toggleSectionCollapse(section: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      localStorage.setItem("cc-collapsed-nav-sections", JSON.stringify([...next]));
      return next;
    });
  }

  function toggleFolderCollapse(folderId: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      localStorage.setItem("cc-collapsed-folders", JSON.stringify([...next]));
      return next;
    });
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      const folder = await api.createFolder(newFolderName.trim());
      setFolders((prev) => [...prev, folder]);
      setNewFolderName("");
      setShowNewFolder(false);
    } catch {}
  }

  async function handleDeleteFolder(folderId: string) {
    try {
      await api.deleteFolder(folderId);
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
    } catch {}
  }

  async function handleMoveToFolder(sessionId: string, folderId: string) {
    try {
      await api.addSessionToFolder(folderId, sessionId);
      const updated = await api.listFolders();
      setFolders(updated);
    } catch {}
  }

  async function handleRemoveFromFolder(sessionId: string) {
    try {
      await api.removeSessionFromFolder(sessionId);
      const updated = await api.listFolders();
      setFolders(updated);
    } catch {}
  }

  /* Hash change listener */
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /* ─── Session handlers ─────────────────────────────────────────── */

  function handleSelectSession(sessionId: string) {
    useStore.getState().closeTerminal();
    window.location.hash = "";
    if (currentSessionId === sessionId) return;
    setCurrentSession(sessionId);
    connectSession(sessionId);
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    useStore.getState().closeTerminal();
    window.location.hash = "";
    useStore.getState().newSession();
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  /* Focus edit input when entering edit mode */
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      useStore.getState().setSessionName(editingSessionId, editingName.trim());
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  function handleStartRename(id: string, currentName: string) {
    setEditingSessionId(id);
    setEditingName(currentName);
  }

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        disconnectSession(sessionId);
        await api.deleteSession(sessionId);
      } catch {
        // best-effort
      }
      removeSession(sessionId);
    },
    [removeSession]
  );

  const handleArchiveSession = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
      const bridgeState = sessions.get(sessionId);
      const isWorktree = bridgeState?.is_worktree || sdkInfo?.isWorktree || false;
      if (isWorktree) {
        setConfirmArchiveId(sessionId);
        return;
      }
      doArchive(sessionId);
    },
    [sdkSessions, sessions]
  );

  const doArchive = useCallback(async (sessionId: string, force?: boolean) => {
    try {
      disconnectSession(sessionId);
      await api.archiveSession(sessionId, force ? { force: true } : undefined);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      useStore.getState().newSession();
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  const confirmArchive = useCallback(() => {
    if (confirmArchiveId) {
      doArchive(confirmArchiveId, true);
      setConfirmArchiveId(null);
    }
  }, [confirmArchiveId, doArchive]);

  const cancelArchive = useCallback(() => {
    setConfirmArchiveId(null);
  }, []);

  const handleUnarchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  /* ─── Build combined session list ──────────────────────────────── */

  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const allSessionList: SessionItemType[] = Array.from(allSessionIds)
    .map((id) => {
      const bridgeState = sessions.get(id);
      const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
      return {
        id,
        model: bridgeState?.model || sdkInfo?.model || "",
        cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
        gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
        isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
        gitAhead: bridgeState?.git_ahead || sdkInfo?.gitAhead || 0,
        gitBehind: bridgeState?.git_behind || sdkInfo?.gitBehind || 0,
        linesAdded: bridgeState?.total_lines_added || sdkInfo?.totalLinesAdded || 0,
        linesRemoved: bridgeState?.total_lines_removed || sdkInfo?.totalLinesRemoved || 0,
        isConnected: cliConnected.get(id) ?? false,
        status: sessionStatus.get(id) ?? null,
        sdkState: sdkInfo?.state ?? null,
        createdAt: sdkInfo?.createdAt ?? 0,
        archived: sdkInfo?.archived ?? false,
        backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
        repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
        permCount: pendingPermissions.get(id)?.size ?? 0,
        cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
        cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
        parentSessionId: bridgeState?.parent_session_id || sdkInfo?.parentSessionId,
        orchestrationRole: bridgeState?.orchestration_role || sdkInfo?.orchestrationRole,
        subagentTerminalStatus: completedSubagentSessions.get(id),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((s) => !s.archived);
  const archivedSessions = allSessionList.filter((s) => s.archived);
  /* ─── Search filtering ─────────────────────────────────────────── */

  const filteredActiveSessions = useMemo(() => {
    if (!searchQuery.trim()) return activeSessions;
    const q = searchQuery.toLowerCase();
    return activeSessions.filter((s) => {
      const name = sessionNames?.get(s.id) || s.id;
      return name.toLowerCase().includes(q);
    });
  }, [activeSessions, searchQuery, sessionNames]);

  /* ─── Time-grouped sessions ────────────────────────────────────── */

  const folderSessionIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const f of folders) {
      for (const sid of f.sessionIds) ids.add(sid);
    }
    return ids;
  }, [folders]);

  const timeGrouped = useMemo(() => {
    const ungrouped = filteredActiveSessions.filter((s) => !folderSessionIdSet.has(s.id));
    const groups: Record<string, SessionItemType[]> = {};
    for (const s of ungrouped) {
      const group = getTimeGroup(s.createdAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(s);
    }
    return TIME_GROUP_ORDER.filter((g) => groups[g]?.length).map((g) => ({
      label: g,
      sessions: groups[g],
    }));
  }, [filteredActiveSessions, folderSessionIdSet]);

  const filteredFolderSessions = useMemo(() => {
    return folders
      .map((folder) => {
        const folderSids = new Set(folder.sessionIds);
        const matched = filteredActiveSessions.filter((s) => folderSids.has(s.id));
        return { folder, sessions: matched };
      })
      .filter((f) => f.sessions.length > 0);
  }, [folders, filteredActiveSessions]);

  /* ─── Flatten all visible sessions for "show more" logic ──────── */

  const allVisibleSessions = useMemo(() => {
    const list: SessionItemType[] = [];
    for (const { sessions: fSessions } of filteredFolderSessions) {
      list.push(...fSessions);
    }
    for (const { sessions: gSessions } of timeGrouped) {
      list.push(...gSessions);
    }
    return list;
  }, [filteredFolderSessions, timeGrouped]);

  const totalSessionCount = allVisibleSessions.length;
  const shouldTruncate = !searchQuery && !sessionsExpanded && totalSessionCount > INITIAL_SESSIONS_SHOWN;

  /* Build a truncated view: take first N sessions across all groups */
  const truncatedTimeGrouped = useMemo(() => {
    if (!shouldTruncate) return timeGrouped;
    let remaining = INITIAL_SESSIONS_SHOWN;
    /* Subtract folder sessions first */
    for (const { sessions: fSessions } of filteredFolderSessions) {
      remaining -= fSessions.length;
    }
    if (remaining <= 0) return [];
    return timeGrouped
      .map(({ label, sessions: gSessions }) => {
        if (remaining <= 0) return null;
        const sliced = gSessions.slice(0, remaining);
        remaining -= sliced.length;
        return { label, sessions: sliced };
      })
      .filter(Boolean) as { label: string; sessions: SessionItemType[] }[];
  }, [shouldTruncate, timeGrouped, filteredFolderSessions]);

  /* ─── Shared SessionItem props ─────────────────────────────────── */

  const sessionItemProps = {
    onSelect: handleSelectSession,
    onStartRename: handleStartRename,
    onArchive: handleArchiveSession,
    onUnarchive: handleUnarchiveSession,
    onDelete: handleDeleteSession,
    onClearRecentlyRenamed: clearRecentlyRenamed,
    editingSessionId,
    editingName,
    setEditingName,
    onConfirmRename: confirmRename,
    onCancelRename: cancelRename,
    editInputRef,
  };

  /* ─── Navigation helper ────────────────────────────────────────── */

  function navigateTo(hashTarget: string) {
    useStore.getState().closeTerminal();
    window.location.hash = hashTarget;
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function isNavItemActive(item: NavItem): boolean {
    if (item.hash === "#/integrations") return hash.startsWith("#/integrations");
    return hash === item.hash;
  }

  /* ─── Render nav section ─────────────────────────────────────── */

  function renderNavSection(title: string, items: NavItem[]) {
    const isCollapsed = collapsedSections.has(title);
    return (
      <div className="mb-0.5">
        <button
          onClick={() => toggleSectionCollapse(title)}
          className="w-[calc(100%-12px)] mx-1.5 flex items-center gap-2 px-2.5 py-2 rounded-lg text-[10px] font-semibold text-cc-fg/50 uppercase tracking-widest hover:text-cc-fg/70 hover:bg-cc-hover/40 cursor-pointer transition-colors"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-2.5 h-2.5 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 3l5 5-5 5V3z" />
          </svg>
          {title}
        </button>
        {!isCollapsed && (
          <div className="space-y-0.5">
            {items.map((item) => (
              <button
                key={item.hash}
                onClick={() => navigateTo(item.hash)}
                className={`w-[calc(100%-12px)] flex items-center gap-2.5 rounded-lg mx-1.5 px-2.5 py-[7px] text-[12px] font-medium transition-all duration-150 cursor-pointer ${
                  isNavItemActive(item)
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-fg/70 hover:text-cc-fg hover:bg-cc-hover/60"
                }`}
                aria-current={isNavItemActive(item) ? "page" : undefined}
              >
                <span className="w-6 h-6 rounded-md bg-cc-hover/50 flex items-center justify-center shrink-0">
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ─── Render ───────────────────────────────────────────────────── */

  return (
    <aside className="w-[240px] h-full flex flex-col bg-cc-sidebar" role="navigation">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="w-5 h-5 opacity-80" />
            <span className="text-[13px] font-semibold text-cc-fg tracking-tight">
              Campfire
            </span>
          </div>
          <button
            onClick={handleNewSession}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-cc-primary text-white hover:opacity-90 shadow-sm transition-all duration-200 cursor-pointer"
            title="New Session"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
              <path d="M8 3v10M3 8h10" />
            </svg>
            New
          </button>
        </div>
      </div>

      {/* ── Search ──────────────────────────────────────────────── */}
      <div className="px-3 pt-1 pb-2" role="search">
        <div className="relative">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cc-muted pointer-events-none"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-14 py-1.5 text-[11px] rounded-lg border border-transparent bg-cc-hover/50 text-cc-fg placeholder:text-cc-fg/50 focus:outline-none focus:bg-cc-bg focus:border-cc-border focus:ring-1 focus:ring-cc-primary/30 transition-all duration-200"
            aria-label="Search sessions"
          />
          {searchQuery ? (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-cc-muted hover:text-cc-fg transition-all duration-200 cursor-pointer"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-cc-fg/45 font-mono pointer-events-none select-none">
              Ctrl+K
            </span>
          )}
        </div>
      </div>

      {/* ── Scrollable area: sessions (top) + nav sections (bottom) ── */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* ── Worktree archive confirmation ───────────────────────── */}
        {confirmArchiveId && (
          <div className="mx-3 mb-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 shadow-sm">
            <div className="flex items-start gap-2">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-cc-fg leading-snug">
                  Archiving will <strong>delete the worktree</strong> and any uncommitted changes.
                </p>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={cancelArchive}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-all duration-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmArchive}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all duration-200 cursor-pointer"
                  >
                    Archive
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Sessions section ──────────────────────────────────── */}
        <div className="px-1.5">
          <div className="px-1.5 py-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-cc-fg/50 uppercase tracking-widest">
              Sessions
            </span>
            {totalSessionCount > 0 && (
              <span className="text-[10px] text-cc-fg/45 tabular-nums">
                {totalSessionCount}
              </span>
            )}
          </div>

          {activeSessions.length === 0 && archivedSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-3 py-8 text-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-fg/35 mb-2">
                <path d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-[11px] text-cc-muted leading-relaxed">
                No sessions yet.<br />Click <strong>New</strong> to start.
              </p>
            </div>
          ) : (
            <>
              {/* ── User-defined folders (collapsible) ─────────────── */}
              {filteredFolderSessions.map(({ folder, sessions: fSessions }) => {
                const isCollapsed = collapsedFolders.has(folder.id);
                return (
                  <div key={folder.id} className="mb-0.5">
                    <div className="flex items-center group">
                      <button
                        onClick={() => toggleFolderCollapse(folder.id)}
                        className="flex-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-semibold text-cc-muted uppercase tracking-wider hover:text-cc-fg hover:bg-cc-hover/50 transition-all duration-200 cursor-pointer"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className={`w-2.5 h-2.5 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                        >
                          <path d="M6 3l5 5-5 5V3z" />
                        </svg>
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3 h-3 opacity-50"
                          style={folder.color ? { color: folder.color } : undefined}
                        >
                          <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                        </svg>
                        <span className="truncate">{folder.name}</span>
                        <span className="text-cc-fg/50 ml-auto tabular-nums">
                          {fSessions.length}
                        </span>
                      </button>
                      <button
                        onClick={() => handleDeleteFolder(folder.id)}
                        className="opacity-0 group-hover:opacity-100 px-1 rounded-md text-cc-muted hover:text-cc-error hover:bg-cc-hover/50 transition-all duration-200 cursor-pointer"
                        title="Delete folder"
                      >
                        <svg viewBox="0 0 16 16" className="w-3 h-3">
                          <path
                            d="M4 4l8 8M12 4l-8 8"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                    </div>
                    {!isCollapsed &&
                      fSessions.map((s) => (
                        <SessionItem
                          key={s.id}
                          session={s}
                          isActive={s.id === currentSessionId}
                          sessionName={sessionNames?.get(s.id)}
                          permCount={pendingPermissions.get(s.id)?.size ?? 0}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          {...sessionItemProps}
                        />
                      ))}
                  </div>
                );
              })}

              {/* New folder inline input */}
              {showNewFolder && (
                <div className="flex items-center gap-1 px-2 py-1 mb-1">
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateFolder();
                      if (e.key === "Escape") setShowNewFolder(false);
                    }}
                    placeholder="Folder name"
                    className="flex-1 px-2 py-0.5 text-[11px] rounded-lg border border-cc-border bg-cc-bg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/30 transition-all duration-200"
                    autoFocus
                  />
                  <button
                    onClick={handleCreateFolder}
                    className="text-[10px] text-cc-primary hover:text-cc-primary-hover cursor-pointer"
                  >
                    +
                  </button>
                </div>
              )}

              {/* New folder toggle */}
              {folders.length > 0 || showNewFolder ? (
                <button
                  onClick={() => setShowNewFolder(!showNewFolder)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 mb-1 text-[10px] text-cc-fg/50 hover:text-cc-muted transition-all duration-200 cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                  </svg>
                  <span>New folder</span>
                </button>
              ) : null}

              {/* ── Time-grouped sessions (truncated) ──────────────── */}
              {(shouldTruncate ? truncatedTimeGrouped : timeGrouped).map(({ label, sessions: groupSessions }) => (
                <div key={label} className="mb-1">
                  <div className="px-2 pt-3 pb-1">
                    <span className="text-[10px] font-medium text-cc-fg/45 uppercase tracking-wider">
                      {label}
                    </span>
                  </div>
                  {groupSessions.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      isActive={s.id === currentSessionId}
                      sessionName={sessionNames?.get(s.id)}
                      permCount={pendingPermissions.get(s.id)?.size ?? 0}
                      isRecentlyRenamed={recentlyRenamed.has(s.id)}
                      {...sessionItemProps}
                    />
                  ))}
                </div>
              ))}

              {/* Show more / Show less toggle */}
              {totalSessionCount > INITIAL_SESSIONS_SHOWN && !searchQuery && (
                <button
                  onClick={() => setSessionsExpanded(!sessionsExpanded)}
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-1 text-[11px] text-cc-fg/55 hover:text-cc-primary transition-colors cursor-pointer"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform duration-200 ${sessionsExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="M8 10.5l-4-4h8l-4 4z" />
                  </svg>
                  {sessionsExpanded
                    ? "Show less"
                    : `Show ${totalSessionCount - INITIAL_SESSIONS_SHOWN} more`}
                </button>
              )}

              {/* If search yields no results */}
              {searchQuery && filteredActiveSessions.length === 0 && (
                <p className="px-3 py-4 text-[11px] text-cc-muted text-center">
                  No sessions matching "{searchQuery}"
                </p>
              )}

              {/* ── Archived sessions (collapsible) ────────────────── */}
              {archivedSessions.length > 0 && (
                <div className="mt-2 pt-2 border-t border-cc-border/30">
                  <button
                    onClick={() => setShowArchived(!showArchived)}
                    className="w-full flex items-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-medium text-cc-fg/50 uppercase tracking-wider hover:text-cc-fg/70 hover:bg-cc-hover/40 transition-all duration-200 cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 transition-transform duration-200 ${showArchived ? "rotate-90" : ""}`}
                    >
                      <path d="M6 3l5 5-5 5V3z" />
                    </svg>
                    Archived
                    <span className="rounded-full bg-cc-hover text-cc-muted text-[10px] px-1.5 ml-auto">
                      {archivedSessions.length}
                    </span>
                  </button>
                  {showArchived && (
                    <div className="space-y-0.5 mt-0.5">
                      {archivedSessions.map((s) => (
                        <SessionItem
                          key={s.id}
                          session={s}
                          isActive={currentSessionId === s.id}
                          isArchived
                          sessionName={sessionNames.get(s.id)}
                          permCount={pendingPermissions.get(s.id)?.size ?? 0}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          {...sessionItemProps}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Spacer pushes nav to bottom ─────────────────────── */}
        <div className="flex-1 min-h-4" />

        {/* ── Nav Sections (bottom-anchored) ────────────────────── */}
        <div className="pt-2 pb-1">
          <div className="h-px bg-cc-border/30 mx-3 mb-3" />
          {renderNavSection("Tools", NAV_TOOLS)}
          {renderNavSection("Data", NAV_DATA)}
          {renderNavSection("Config", NAV_CONFIG)}
        </div>
      </div>

      {/* ── Settings footer ────────────────────────────────────── */}
      <div className="px-3 py-2.5 border-t border-cc-border/40">
        <button
          onClick={() => {
            if (hash === "#/settings") {
              window.location.hash = "";
            } else {
              navigateTo("#/settings");
            }
          }}
          className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12px] font-medium transition-all duration-150 cursor-pointer ${
            hash === "#/settings"
              ? "bg-cc-primary/10 text-cc-primary"
              : "text-cc-fg/70 hover:text-cc-fg hover:bg-cc-hover/60"
          }`}
          aria-current={hash === "#/settings" ? "page" : undefined}
        >
          <span className="w-6 h-6 rounded-md bg-cc-hover/50 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          Settings
        </button>
      </div>
    </aside>
  );
}
