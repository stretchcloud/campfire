import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { api, type CompanionEnv, type GitRepoInfo, type GitBranchInfo, type BackendInfo } from "../api.js";
import { connectSession, waitForConnection, sendToSession } from "../ws.js";
import { disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";
import { getModelsForBackend, getModesForBackend, getDefaultModel, getDefaultMode, toModelOptions, type ModelOption } from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { EnvManager } from "./EnvManager.js";
import { LinearSection } from "./LinearSection.js";
import { FolderPicker } from "./FolderPicker.js";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let idCounter = 0;

export function HomePage() {
  const [text, setText] = useState("");
  const [backend, setBackend] = useState<BackendType>(() =>
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  );
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [model, setModel] = useState(() => getDefaultModel(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [mode, setMode] = useState(() => getDefaultMode(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [cwd, setCwd] = useState(() => getRecentDirs()[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [codexInternetAccess, setCodexInternetAccess] = useState(() =>
    localStorage.getItem("cc-codex-internet-access") === "1",
  );
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<"low" | "medium" | "high">(() =>
    (localStorage.getItem("cc-codex-reasoning-effort") as "low" | "medium" | "high") || "medium",
  );

  const MODELS = dynamicModels || getModelsForBackend(backend);
  const MODES = getModesForBackend(backend);

  // Environment state
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => localStorage.getItem("cc-selected-env") || "");
  const [showEnvManager, setShowEnvManager] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Options disclosure
  const [showOptions, setShowOptions] = useState(false);

  // Folder picker
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Worktree state
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);

  // Branch freshness check state
  const [pullPrompt, setPullPrompt] = useState<{ behind: number; branchName: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  // Container mode state
  const [useContainer, setUseContainer] = useState(false);
  const [containerImage, setContainerImage] = useState("companion-dev:latest");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const currentSessionId = useStore((s) => s.currentSessionId);

  // Auto-focus textarea (desktop only -- on mobile it triggers the keyboard immediately)
  useEffect(() => {
    const isDesktop = window.matchMedia("(min-width: 640px)").matches;
    if (isDesktop) {
      textareaRef.current?.focus();
    }
  }, []);

  // Load server home/cwd and available backends on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    api.getBackends().then(setBackends).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When backend changes, reset model and mode to defaults
  function switchBackend(newBackend: BackendType) {
    setBackend(newBackend);
    localStorage.setItem("cc-backend", newBackend);
    setDynamicModels(null);
    setModel(getDefaultModel(newBackend));
    setMode(getDefaultMode(newBackend));
  }

  // Fetch dynamic models for the selected backend
  useEffect(() => {
    if (backend !== "codex") {
      setDynamicModels(null);
      return;
    }
    api.getBackendModels(backend).then((models) => {
      if (models.length > 0) {
        const options = toModelOptions(models);
        setDynamicModels(options);
        // If current model isn't in the list, switch to first
        if (!options.some((m) => m.value === model)) {
          setModel(options[0].value);
        }
      }
    }).catch(() => {
      // Fall back to hardcoded models silently
    });
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Detect git repo when cwd changes
  useEffect(() => {
    if (!cwd) {
      setGitRepoInfo(null);
      return;
    }
    api.getRepoInfo(cwd).then((info) => {
      setGitRepoInfo(info);
      setUseWorktree(false);
      setWorktreeBranch(info.currentBranch);
      setIsNewBranch(false);
      api.listBranches(info.repoRoot).then(setBranches).catch(() => setBranches([]));
    }).catch(() => {
      setGitRepoInfo(null);
    });
  }, [cwd]);

  // Fetch branches when git repo changes
  useEffect(() => {
    if (gitRepoInfo) {
      api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
    }
  }, [gitRepoInfo]);


  const selectedModel = MODELS.find((m) => m.value === model) || MODELS[0];
  const selectedMode = MODES.find((m) => m.value === mode) || MODES[0];
  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const currentModes = getModesForBackend(backend);
      const currentIndex = currentModes.findIndex((m) => m.value === mode);
      const nextIndex = (currentIndex + 1) % currentModes.length;
      setMode(currentModes[nextIndex].value);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg || sending) return;

    setSending(true);
    setError("");
    setPullError("");

    // Branch freshness check: warn if behind remote
    // Only offer pull when the effective branch is the currently checked-out branch,
    // since git pull operates on the checked-out branch
    if (gitRepoInfo) {
      const effectiveBranch = useWorktree ? worktreeBranch : gitRepoInfo.currentBranch;
      if (effectiveBranch && effectiveBranch === gitRepoInfo.currentBranch) {
        const branchInfo = branches.find(b => b.name === effectiveBranch && !b.isRemote);
        if (branchInfo && branchInfo.behind > 0) {
          setPullPrompt({ behind: branchInfo.behind, branchName: effectiveBranch });
          return; // Pause -- user must choose pull/skip/cancel
        }
      }
    }

    await doCreateSession(msg);
  }

  async function doCreateSession(msg: string) {
    if (!msg) {
      setSending(false);
      return;
    }

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      const branchName = worktreeBranch.trim() || undefined;
      const baseOpts = {
        model,
        permissionMode: mode,
        cwd: cwd || undefined,
        envSlug: selectedEnv || undefined,
        branch: branchName,
        createBranch: branchName && isNewBranch ? true : undefined,
        useWorktree: useWorktree || undefined,
        backend,
        codexInternetAccess: backend === "codex" ? codexInternetAccess : undefined,
        codexReasoningEffort: backend === "codex" ? codexReasoningEffort : undefined,
      };

      let sessionId: string;

      if (useContainer) {
        // Container mode: use SSE creation with progress overlay
        const store = useStore.getState();
        store.setSessionCreating(true);
        store.setCreationProgress(null);
        store.setCreationError(null);

        try {
          const result = await api.createSessionWithProgress(
            { ...baseOpts, container: { image: containerImage } },
            ({ type, data }) => {
              if (type === "step") {
                useStore.getState().setCreationProgress({
                  step: data.step as string,
                  message: data.message as string,
                  percent: data.percent as number | undefined,
                });
              }
            },
          );
          if (!result) throw new Error("Session creation returned no result");
          sessionId = result.sessionId;
          useStore.getState().setSessionCreating(false);
        } catch (e) {
          useStore.getState().setCreationError(e instanceof Error ? e.message : String(e));
          setSending(false);
          return;
        }
      } else {
        // Standard session creation
        const result = await api.createSession(baseOpts);
        sessionId = result.sessionId;
      }

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (cwd) addRecentDir(cwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session
      setCurrentSession(sessionId);
      connectSession(sessionId);

      // Wait for WebSocket connection
      await waitForConnection(sessionId);

      // Send message
      sendToSession(sessionId, {
        type: "user_message",
        content: msg,
        session_id: sessionId,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      });

      // Add user message to store
      useStore.getState().appendMessage(sessionId, {
        id: `user-${Date.now()}-${++idCounter}`,
        role: "user",
        content: msg,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
        timestamp: Date.now(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  async function handlePullAndContinue() {
    if (!pullPrompt) return;
    setPulling(true);
    setPullError("");

    try {
      const pullCwd = cwd || gitRepoInfo?.repoRoot;
      if (!pullCwd) throw new Error("No working directory");

      const result = await api.gitPull(pullCwd);
      if (!result.success) {
        setPullError(result.output || "Pull failed");
        setPulling(false);
        setSending(false);
        return;
      }

      // Refresh branch data after successful pull
      if (gitRepoInfo) {
        api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => {});
      }

      setPullPrompt(null);
      setPulling(false);
      await doCreateSession(text.trim());
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : String(e));
      setPulling(false);
    }
  }

  function handleSkipPull() {
    const msg = text.trim();
    setPullPrompt(null);
    setPullError("");
    doCreateSession(msg);
  }

  function handleCancelPull() {
    setPullPrompt(null);
    setPullError("");
    setSending(false);
  }

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="flex-1 h-full flex items-start justify-center px-3 sm:px-4 pt-[12vh] sm:pt-[18vh] overflow-y-auto">
      <div className="w-full max-w-xl">
        {/* Greeting */}
        <h1 className="text-2xl sm:text-3xl font-light text-cc-fg text-center">
          What are you working on?
        </h1>
        <p className="text-sm text-cc-muted/60 text-center mt-2 mb-6">Describe your task and choose a backend to get started</p>

        {/* Linear Integration (only shown when connected + git repo detected) */}
        {gitRepoInfo && (
          <div className="mb-4">
            <LinearSection
              cwd={cwd}
              repoRoot={gitRepoInfo.repoRoot}
              onBranchFromIssue={(branch) => {
                setWorktreeBranch(branch);
                setIsNewBranch(true);
                setUseWorktree(true);
              }}
            />
          </div>
        )}

        {/* Composer card */}
        <div className="bg-cc-card rounded-2xl border border-cc-border/50 shadow-lg transition-all duration-300 focus-within:shadow-xl focus-within:border-cc-border">
          {/* Image thumbnails */}
          {images.length > 0 && (
            <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt={img.name}
                    className="w-14 h-14 rounded-xl object-cover border border-cc-border shadow-sm"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    aria-label={`Remove ${img.name}`}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
            aria-label="Upload images"
          />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Attach files or start a conversation..."
            rows={3}
            aria-label="Task description"
            className="w-full px-5 pt-5 pb-3 text-[15px] bg-transparent resize-none focus:outline-none text-cc-fg placeholder:text-cc-muted/70"
            style={{ minHeight: "96px", maxHeight: "300px" }}
          />

          {/* Toolbar */}
          <div className="flex flex-col gap-3 px-4 pb-4">
            {/* Backend pills — scrollable row */}
            {backends.length > 1 && (
              <div className="flex items-center overflow-x-auto scrollbar-none bg-cc-hover/40 rounded-xl p-1" role="radiogroup" aria-label="Backend">
                {backends.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => b.available && switchBackend(b.id as BackendType)}
                    disabled={!b.available}
                    role="radio"
                    aria-checked={backend === b.id}
                    title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                    className={`px-3 py-1.5 text-[12px] rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      !b.available
                        ? "text-cc-muted/40 cursor-not-allowed"
                        : backend === b.id
                          ? "bg-cc-card text-cc-fg font-semibold shadow-md cursor-pointer"
                          : "text-cc-muted hover:text-cc-fg cursor-pointer"
                    }`}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            )}

            {/* Action buttons row */}
            <div className="flex items-center justify-end gap-2">
              {/* Options toggle */}
              <button
                onClick={() => setShowOptions(!showOptions)}
                aria-expanded={showOptions}
                aria-controls="options-panel"
                className={`flex items-center gap-1 px-3 py-2 text-[12px] rounded-xl transition-colors cursor-pointer ${
                  showOptions
                    ? "text-cc-fg bg-cc-hover"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M8 4v8M4 8h8" strokeLinecap="round" style={{ display: showOptions ? "none" : "block" }} />
                  <path d="M4 8h8" strokeLinecap="round" style={{ display: showOptions ? "block" : "none" }} />
                </svg>
                Options
              </button>

              {/* Image upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload image"
                className="flex items-center justify-center w-9 h-9 rounded-xl text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send message"
                className={`flex items-center justify-center w-10 h-10 rounded-full shadow-md hover:shadow-lg transition-all ${
                  canSend
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                    : "bg-cc-hover text-cc-muted cursor-not-allowed shadow-none"
                }`}
              >
                {sending ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                    <path d="M8 2.5a.75.75 0 01.75.75v7.69l2.72-2.72a.75.75 0 111.06 1.06l-4 4a.75.75 0 01-1.06 0l-4-4a.75.75 0 111.06-1.06l2.72 2.72V3.25A.75.75 0 018 2.5z" transform="rotate(180 8 8)" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Options panel (collapsed by default) */}
        {showOptions && (
          <div id="options-panel" className="mt-4 p-4 bg-cc-card rounded-2xl border border-cc-border/50 shadow-sm">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {/* Model selector */}
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5" htmlFor="model-select">Model</label>
                <select
                  id="model-select"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg focus:outline-none focus:border-cc-primary/50 cursor-pointer"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* Mode selector */}
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5" htmlFor="mode-select">Permission mode</label>
                <select
                  id="mode-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="w-full px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg focus:outline-none focus:border-cc-primary/50 cursor-pointer"
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* Environment selector */}
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5" htmlFor="env-select">Environment</label>
                <div className="flex gap-1">
                  <select
                    id="env-select"
                    value={selectedEnv}
                    onChange={(e) => {
                      setSelectedEnv(e.target.value);
                      localStorage.setItem("cc-selected-env", e.target.value);
                    }}
                    onFocus={() => { api.listEnvs().then(setEnvs).catch(() => {}); }}
                    className="flex-1 min-w-0 px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg focus:outline-none focus:border-cc-primary/50 cursor-pointer"
                  >
                    <option value="">No environment</option>
                    {envs.map((env) => (
                      <option key={env.slug} value={env.slug}>{env.name} ({Object.keys(env.variables).length} vars)</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setShowEnvManager(true)}
                    aria-label="Manage environments"
                    className="px-3 py-2 text-[12px] text-cc-muted hover:text-cc-fg bg-cc-bg border border-cc-border rounded-xl hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                      <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z" />
                      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.843 1.843 0 01-2.739 1.049c-1.547-.966-3.317.803-2.35 2.35a1.843 1.843 0 01-1.049 2.74c-1.79.526-1.79 3.064 0 3.59a1.843 1.843 0 011.049 2.74c-.966 1.547.803 3.317 2.35 2.35a1.843 1.843 0 012.74 1.049c.526 1.79 3.064 1.79 3.59 0a1.843 1.843 0 012.74-1.049c1.547.966 3.317-.803 2.35-2.35a1.843 1.843 0 011.049-2.74c1.79-.526 1.79-3.064 0-3.59a1.843 1.843 0 01-1.049-2.74c.966-1.547-.803-3.317-2.35-2.35a1.843 1.843 0 01-2.74-1.049zM8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492z" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Folder / cwd */}
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Working directory</label>
                <button
                  onClick={() => setShowFolderPicker(true)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer text-left"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted shrink-0">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  <span className="truncate font-mono-code">{dirLabel}</span>
                </button>
                {showFolderPicker && (
                  <FolderPicker
                    initialPath={cwd || ""}
                    onSelect={(path) => { setCwd(path); }}
                    onClose={() => setShowFolderPicker(false)}
                  />
                )}
              </div>

              {/* Branch picker */}
              {gitRepoInfo && (
                <div className="relative" ref={branchDropdownRef}>
                  <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Branch</label>
                  <button
                    onClick={() => {
                      if (!showBranchDropdown && gitRepoInfo) {
                        api.gitFetch(gitRepoInfo.repoRoot)
                          .catch(() => {})
                          .finally(() => {
                            api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
                          });
                      }
                      setShowBranchDropdown(!showBranchDropdown);
                      setBranchFilter("");
                    }}
                    className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer text-left"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted shrink-0">
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    </svg>
                    <span className="truncate font-mono-code">{worktreeBranch || gitRepoInfo.currentBranch}</span>
                  </button>
                  {showBranchDropdown && (
                    <div className="absolute left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-cc-card border border-cc-border rounded-2xl shadow-xl z-10 overflow-hidden">
                      {/* Search/filter input */}
                      <div className="px-2 py-2 border-b border-cc-border">
                        <input
                          type="text"
                          value={branchFilter}
                          onChange={(e) => setBranchFilter(e.target.value)}
                          placeholder="Filter or create branch..."
                          className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setShowBranchDropdown(false);
                            }
                          }}
                        />
                      </div>
                      {/* Branch list */}
                      <div className="max-h-[240px] overflow-y-auto py-1">
                        {(() => {
                          const filter = branchFilter.toLowerCase().trim();
                          const localBranches = branches.filter((b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                          const remoteBranches = branches.filter((b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                          const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                          const hasResults = localBranches.length > 0 || remoteBranches.length > 0;

                          return (
                            <>
                              {/* Local branches */}
                              {localBranches.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">Local</div>
                                  {localBranches.map((b) => (
                                    <button
                                      key={b.name}
                                      onClick={() => {
                                        setWorktreeBranch(b.name);
                                        setIsNewBranch(false);
                                        setShowBranchDropdown(false);
                                      }}
                                      className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                        b.name === worktreeBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                      }`}
                                    >
                                      <span className="truncate font-mono-code">{b.name}</span>
                                      <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                        {b.ahead > 0 && (
                                          <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>
                                        )}
                                        {b.behind > 0 && (
                                          <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>
                                        )}
                                        {b.isCurrent && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">current</span>
                                        )}
                                        {b.worktreePath && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">wt</span>
                                        )}
                                      </span>
                                    </button>
                                  ))}
                                </>
                              )}
                              {/* Remote branches */}
                              {remoteBranches.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">Remote</div>
                                  {remoteBranches.map((b) => (
                                    <button
                                      key={`remote-${b.name}`}
                                      onClick={() => {
                                        setWorktreeBranch(b.name);
                                        setIsNewBranch(false);
                                        setShowBranchDropdown(false);
                                      }}
                                      className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                        b.name === worktreeBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                      }`}
                                    >
                                      <span className="truncate font-mono-code">{b.name}</span>
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">remote</span>
                                    </button>
                                  ))}
                                </>
                              )}
                              {/* No results */}
                              {!hasResults && filter && (
                                <div className="px-3 py-2 text-xs text-cc-muted text-center">No matching branches</div>
                              )}
                              {/* Create new branch option */}
                              {filter && !exactMatch && (
                                <div className="border-t border-cc-border mt-1 pt-1">
                                  <button
                                    onClick={() => {
                                      setWorktreeBranch(branchFilter.trim());
                                      setIsNewBranch(true);
                                      setShowBranchDropdown(false);
                                    }}
                                    className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                                  >
                                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                                      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                                    </svg>
                                    <span>Create <span className="font-mono-code font-medium">{branchFilter.trim()}</span></span>
                                  </button>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Worktree toggle */}
              {gitRepoInfo && (
                <div>
                  <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Worktree</label>
                  <button
                    onClick={() => setUseWorktree(!useWorktree)}
                    className={`w-full flex items-center gap-1.5 px-3 py-2 text-[12px] rounded-xl border transition-colors cursor-pointer ${
                      useWorktree
                        ? "bg-cc-primary/10 border-cc-primary/30 text-cc-primary font-medium"
                        : "bg-cc-bg border-cc-border text-cc-fg hover:bg-cc-hover"
                    }`}
                    title="Create an isolated worktree for this session"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-70">
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                    </svg>
                    {useWorktree ? "Enabled" : "Disabled"}
                  </button>
                </div>
              )}

              {/* Container toggle */}
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Container</label>
                <button
                  onClick={() => setUseContainer(!useContainer)}
                  className={`w-full flex items-center gap-1.5 px-3 py-2 text-[12px] rounded-xl border transition-colors cursor-pointer ${
                    useContainer
                      ? "bg-cc-primary/10 border-cc-primary/30 text-cc-primary font-medium"
                      : "bg-cc-bg border-cc-border text-cc-fg hover:bg-cc-hover"
                  }`}
                  title="Run session in a Docker container"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 shrink-0 opacity-70">
                    <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.186.186 0 00-.185.186v1.887c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.186.186 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.186.186 0 00-.185.185v1.887c0 .102.082.186.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.186.186 0 00-.185.185v1.887c0 .102.083.186.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.186.186 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.186.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.186v1.887c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.186v1.887c0 .102.083.185.185.185m-2.964 0h2.119a.186.186 0 00.185-.185V9.006a.186.186 0 00-.185-.186H5.136a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.687 11.687 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.228 12.228 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288z" />
                  </svg>
                  {useContainer ? "Enabled" : "Disabled"}
                </button>
              </div>

              {/* Container image (shown when container mode active) */}
              {useContainer && (
                <div>
                  <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5" htmlFor="container-image">Docker image</label>
                  <input
                    id="container-image"
                    type="text"
                    value={containerImage}
                    onChange={(e) => setContainerImage(e.target.value)}
                    placeholder="Docker image"
                    className="w-full px-3 py-2 text-[12px] bg-cc-bg border border-cc-border rounded-xl text-cc-fg focus:outline-none focus:border-cc-primary/50"
                  />
                </div>
              )}

              {/* Codex: internet access */}
              {backend === "codex" && (
                <div>
                  <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Internet access</label>
                  <button
                    onClick={() => {
                      const next = !codexInternetAccess;
                      setCodexInternetAccess(next);
                      localStorage.setItem("cc-codex-internet-access", next ? "1" : "0");
                    }}
                    className={`w-full flex items-center gap-1.5 px-3 py-2 text-[12px] rounded-xl border transition-colors cursor-pointer ${
                      codexInternetAccess
                        ? "bg-cc-primary/10 border-cc-primary/30 text-cc-primary font-medium"
                        : "bg-cc-bg border-cc-border text-cc-fg hover:bg-cc-hover"
                    }`}
                    title="Allow Codex internet/network access for this session"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-70">
                      <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5c.8 0 1.55.22 2.2.61-.39.54-.72 1.21-.95 1.98H6.75c-.23-.77-.56-1.44-.95-1.98A4.47 4.47 0 018 3.5zm-3.2 1.3c.3.4.57.86.78 1.37H3.83c.24-.53.57-1.01.97-1.37zm-.97 2.87h2.15c.07.44.12.9.12 1.38 0 .48-.05.94-.12 1.38H3.83A4.56 4.56 0 013.5 9c0-.47.12-.92.33-1.33zm2.03 4.08c.39-.54.72-1.21.95-1.98h2.38c.23.77.56 1.44.95 1.98A4.47 4.47 0 018 12.5c-.8 0-1.55-.22-2.2-.61zm4.34-1.37c.07-.44.12-.9.12-1.38 0-.48-.05-.94-.12-1.38h2.15c.21.41.33.86.33 1.33 0 .47-.12.92-.33 1.33H10.2zm1.37-3.58h-1.75c-.21-.51-.48-.97-.78-1.37.4.36.73.84.97 1.37z" />
                    </svg>
                    {codexInternetAccess ? "Enabled" : "Disabled"}
                  </button>
                </div>
              )}

              {/* Codex: reasoning effort */}
              {backend === "codex" && (
                <div>
                  <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5">Reasoning effort</label>
                  <div className="flex rounded-lg border border-cc-border overflow-hidden">
                    {(["low", "medium", "high"] as const).map((level) => (
                      <button
                        key={level}
                        onClick={() => {
                          setCodexReasoningEffort(level);
                          localStorage.setItem("cc-codex-reasoning-effort", level);
                        }}
                        className={`flex-1 px-2 py-1.5 text-[11px] transition-colors cursor-pointer ${
                          codexReasoningEffort === level
                            ? "bg-cc-primary/15 text-cc-primary font-medium"
                            : "bg-cc-bg text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                        }`}
                      >
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Branch behind remote warning */}
        {pullPrompt && (
          <div className="mt-3 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-cc-fg leading-snug">
                  <span className="font-mono-code font-medium">{pullPrompt.branchName}</span> is{" "}
                  <span className="font-semibold text-amber-500">{pullPrompt.behind} commit{pullPrompt.behind !== 1 ? "s" : ""} behind</span>{" "}
                  remote. Pull before starting?
                </p>
                {pullError && (
                  <div className="mt-2 px-2 py-1.5 rounded-md bg-cc-error/10 border border-cc-error/20 text-[11px] text-cc-error font-mono-code whitespace-pre-wrap">
                    {pullError}
                  </div>
                )}
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={handleCancelPull}
                    disabled={pulling}
                    className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSkipPull}
                    disabled={pulling}
                    className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Continue anyway
                  </button>
                  <button
                    onClick={handlePullAndContinue}
                    disabled={pulling}
                    className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    {pulling ? (
                      <>
                        <span className="w-3 h-3 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />
                        Pulling...
                      </>
                    ) : (
                      "Pull and continue"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-2xl bg-cc-error/5 border border-cc-error/20">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-cc-error">{error}</p>
          </div>
        )}
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager
          onClose={() => {
            setShowEnvManager(false);
            api.listEnvs().then(setEnvs).catch(() => {});
          }}
        />
      )}

      {/* Container session creation progress overlay */}
      <SessionLaunchOverlay
        onRetry={() => {
          useStore.getState().setCreationError(null);
          useStore.getState().setSessionCreating(false);
          setSending(false);
        }}
        onCancel={() => {
          useStore.getState().setCreationError(null);
          useStore.getState().setSessionCreating(false);
          setSending(false);
        }}
      />
    </div>
  );
}
