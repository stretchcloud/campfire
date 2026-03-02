import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { api } from "../api.js";
import { CLAUDE_MODES, CODEX_MODES } from "../utils/backends.js";
import type { ModeOption } from "../utils/backends.js";
import type { Prompt } from "../types.js";
import { useSpeechToText } from "../hooks/useSpeechToText.js";

let idCounter = 0;
const EMPTY_QUEUE: string[] = [];

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

interface CommandItem {
  name: string;
  type: "command" | "skill";
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuIndex, setAtMenuIndex] = useState(0);
  const [allPrompts, setAllPrompts] = useState<Prompt[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionData = useStore((s) => s.sessions.get(sessionId));
  const previousMode = useStore((s) => s.previousPermissionMode.get(sessionId) || "acceptEdits");

  // Voice input
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setText((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(" ");
      return prev + (needsSpace ? " " : "") + transcript;
    });
    // Auto-resize textarea
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, []);
  const { isSupported: speechSupported, isListening, interimText, toggle: toggleVoice, stop: stopVoice } = useSpeechToText(handleVoiceTranscript);

  const myRole = useStore((s) => s.myRole.get(sessionId) ?? "spectator");
  const isSpectator = myRole === "spectator";
  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = sessionData?.permissionMode || "acceptEdits";
  const isPlan = currentMode === "plan";
  const isCodex = sessionData?.backend_type === "codex";
  const modes: ModeOption[] = isCodex ? CODEX_MODES : CLAUDE_MODES;
  const modeLabel = modes.find((m) => m.value === currentMode)?.label?.toLowerCase() || currentMode;

  // Build command list from session data
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    if (sessionData?.slash_commands) {
      for (const cmd of sessionData.slash_commands) {
        cmds.push({ name: cmd, type: "command" });
      }
    }
    if (sessionData?.skills) {
      for (const skill of sessionData.skills) {
        cmds.push({ name: skill, type: "skill" });
      }
    }
    return cmds;
  }, [sessionData?.slash_commands, sessionData?.skills]);

  // Filter commands based on what the user typed after /
  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen) return [];
    // Extract the slash query: text starts with / and we match the part after /
    const match = text.match(/^\/(\S*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    if (query === "") return allCommands;
    return allCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [text, slashMenuOpen, allCommands]);

  // Open/close menu based on text
  useEffect(() => {
    const shouldOpen = text.startsWith("/") && /^\/\S*$/.test(text) && allCommands.length > 0;
    if (shouldOpen && !slashMenuOpen) {
      setSlashMenuOpen(true);
      setSlashMenuIndex(0);
    } else if (!shouldOpen && slashMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [text, allCommands.length, slashMenuOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, slashMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    const items = menuRef.current.querySelectorAll("[data-cmd-index]");
    const selected = items[slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [slashMenuIndex, slashMenuOpen]);

  const selectCommand = useCallback((cmd: CommandItem) => {
    setText(`/${cmd.name} `);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  }, []);

  // @-mention prompt insertion
  // Extract query after @ in the text (matches last @ followed by word chars)
  const atQuery = useMemo(() => {
    const match = text.match(/@(\w*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const filteredPrompts = useMemo(() => {
    if (!atMenuOpen) return [];
    if (atQuery === null) return [];
    if (atQuery === "") return allPrompts;
    return allPrompts.filter(
      (p) =>
        p.name.toLowerCase().includes(atQuery) ||
        p.content.toLowerCase().includes(atQuery),
    );
  }, [atMenuOpen, atQuery, allPrompts]);

  // Clear cached prompts when session cwd changes
  const sessionCwd = sessionData?.cwd;
  useEffect(() => { setAllPrompts([]); }, [sessionCwd]);

  // Load prompts once when @ is typed; open/close menu
  useEffect(() => {
    const hasAt = atQuery !== null;
    if (hasAt && !atMenuOpen) {
      setAtMenuOpen(true);
      setAtMenuIndex(0);
      api.listPrompts(sessionCwd ? { cwd: sessionCwd } : undefined).then(setAllPrompts).catch(() => {});
    } else if (!hasAt && atMenuOpen) {
      setAtMenuOpen(false);
    }
  }, [atQuery, atMenuOpen, sessionCwd]);

  // Keep @-menu index in bounds
  useEffect(() => {
    if (atMenuIndex >= filteredPrompts.length) {
      setAtMenuIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [filteredPrompts.length, atMenuIndex]);

  const selectPrompt = useCallback((prompt: Prompt) => {
    // Replace the @query with the prompt content
    const newText = text.replace(/@\w*$/, prompt.content);
    setText(newText);
    setAtMenuOpen(false);
    textareaRef.current?.focus();
    // Resize textarea
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [text]);

  function sendMessageDirectly(msg: string, imgs?: ImageAttachment[]) {
    sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      images: imgs && imgs.length > 0 ? imgs.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    useStore.getState().appendMessage(sessionId, {
      id: `user-${Date.now()}-${++idCounter}`,
      role: "user",
      content: msg,
      images: imgs && imgs.length > 0 ? imgs.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      timestamp: Date.now(),
    });
  }

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected || isSpectator) return;

    const sessionSt = useStore.getState().sessionStatus.get(sessionId);
    const agentIsRunning = sessionSt === "running";

    if (agentIsRunning) {
      // Queue the message for later
      useStore.getState().enqueueMessage(sessionId, msg);
      useStore.getState().appendMessage(sessionId, {
        id: `user-queued-${Date.now()}-${++idCounter}`,
        role: "system",
        content: `Queued: "${msg.length > 60 ? msg.slice(0, 60) + "…" : msg}"`,
        timestamp: Date.now(),
      });
    } else {
      sendMessageDirectly(msg, images);
    }

    setText("");
    setImages([]);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    if (isListening) stopVoice();

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // @-mention menu navigation
    if (atMenuOpen && filteredPrompts.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtMenuIndex((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtMenuIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectPrompt(filteredPrompts[atMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectPrompt(filteredPrompts[atMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtMenuOpen(false);
        return;
      }
    }

    // Slash menu navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    // Ctrl+Shift+M or Cmd+Shift+M to toggle voice input
    if (e.key === "m" && e.shiftKey && (e.ctrlKey || e.metaKey) && speechSupported) {
      e.preventDefault();
      toggleVoice();
      return;
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function handleInterrupt() {
    if (isSpectator) return;
    sendToSession(sessionId, { type: "interrupt" });
  }

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

  function toggleMode() {
    if (!isConnected || isCodex || isSpectator) return;
    const store = useStore.getState();
    if (!isPlan) {
      store.setPreviousPermissionMode(sessionId, currentMode);
      sendToSession(sessionId, { type: "set_permission_mode", mode: "plan" });
      store.updateSession(sessionId, { permissionMode: "plan" });
    } else {
      const restoreMode = previousMode || "acceptEdits";
      sendToSession(sessionId, { type: "set_permission_mode", mode: restoreMode });
      store.updateSession(sessionId, { permissionMode: restoreMode });
    }
  }

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const queuedMessages = useStore((s) => s.messageQueue.get(sessionId)) ?? EMPTY_QUEUE;
  const canSend = text.trim().length > 0 && isConnected && !isSpectator;

  // Auto-send queued messages when agent transitions to idle
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isRunning;

    if (wasRunning && !isRunning && isConnected && !isSpectator) {
      // Agent just became idle — send next queued message
      const nextMsg = useStore.getState().dequeueMessage(sessionId);
      if (nextMsg) {
        // Small delay to let the UI settle
        setTimeout(() => sendMessageDirectly(nextMsg), 300);
      }
    }
  }, [isRunning, isConnected, isSpectator, sessionId]);

  return (
    <div className="shrink-0 px-4 sm:px-6 pb-3 pt-1">
      <div className="max-w-4xl mx-auto">
        {/* Queued messages indicator */}
        {queuedMessages.length > 0 && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-cc-primary/10 text-cc-primary text-[11px] font-mono-code">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path d="M8 0a1 1 0 011 1v5.268l3.562-1.78a1 1 0 01.894 1.789L8 9.382l-5.456-3.105a1 1 0 11.894-1.79L7 6.27V1a1 1 0 011-1zM3 12a1 1 0 100 2h10a1 1 0 100-2H3z" />
              </svg>
              <span>{queuedMessages.length} message{queuedMessages.length > 1 ? "s" : ""} queued</span>
            </div>
            <button
              onClick={() => useStore.getState().clearQueue(sessionId)}
              className="text-[10px] text-cc-muted hover:text-cc-error transition-colors"
            >
              Clear queue
            </button>
          </div>
        )}

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="w-10 h-10 rounded-md object-cover border border-cc-border"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-cc-error text-white flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2 h-2">
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
        />

        {/* Terminal-style input */}
        <div className={`relative bg-cc-card rounded-lg overflow-visible transition-all border ${
          isPlan
            ? "border-cc-primary/25"
            : "border-cc-border focus-within:border-cc-muted/20"
        }`}>
          {/* @-mention prompt menu */}
          {atMenuOpen && filteredPrompts.length > 0 && (
            <div className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-lg shadow-lg z-20 py-1">
              {filteredPrompts.map((prompt, i) => (
                <button
                  key={prompt.id}
                  onClick={() => selectPrompt(prompt)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                    i === atMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                  }`}
                >
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0 text-[11px] font-bold">
                    @
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg">{prompt.name}</span>
                    <span className="ml-2 text-[11px] text-cc-muted capitalize">{prompt.scope}</span>
                    <p className="text-[11px] text-cc-muted truncate mt-0.5">{prompt.content.slice(0, 60)}{prompt.content.length > 60 ? "…" : ""}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Slash command menu */}
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div
              ref={menuRef}
              className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-lg shadow-lg z-20 py-1"
            >
              {filteredCommands.map((cmd, i) => (
                <button
                  key={`${cmd.type}-${cmd.name}`}
                  data-cmd-index={i}
                  onClick={() => selectCommand(cmd)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                    i === slashMenuIndex
                      ? "bg-cc-hover"
                      : "hover:bg-cc-hover/50"
                  }`}
                >
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                    {cmd.type === "skill" ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M5 12L10 4" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg">/{cmd.name}</span>
                    <span className="ml-2 text-[11px] text-cc-muted">{cmd.type}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isSpectator ? "Spectators cannot send messages" : isConnected ? "Type a message... (/ for commands, @ for prompts)" : "Waiting for connection..."}
            disabled={!isConnected || isSpectator}
            rows={1}
            className="w-full px-3.5 pt-2.5 pb-1 text-[13px] bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted/50 disabled:opacity-40"
            style={{ minHeight: "34px", maxHeight: "200px" }}
          />

          {/* Voice input interim text */}
          {isListening && (
            <div className="flex items-center gap-2 px-3.5 pb-1 text-[11px] text-cc-muted font-sans-ui animate-pulse">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-error shrink-0">
                <path d="M8 1a2.5 2.5 0 00-2.5 2.5v4a2.5 2.5 0 005 0v-4A2.5 2.5 0 008 1z" />
                <path d="M3.5 7a.75.75 0 011.5 0 3 3 0 006 0 .75.75 0 011.5 0 4.5 4.5 0 01-3.75 4.437V13h1.5a.75.75 0 010 1.5h-4.5a.75.75 0 010-1.5h1.5v-1.563A4.5 4.5 0 013.5 7z" />
              </svg>
              <span>{interimText || "Listening..."}</span>
            </div>
          )}

          {/* Git branch + lines info */}
          {sessionData?.git_branch && (
            <div className="flex items-center gap-2 px-3.5 pb-1 text-[10px] text-cc-muted/60 font-mono-code overflow-hidden">
              <span className="flex items-center gap-1 truncate min-w-0">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate max-w-[100px] sm:max-w-[160px]">{sessionData.git_branch}</span>
                {sessionData.is_worktree && (
                  <span className="text-[10px] bg-cc-hover text-cc-muted px-1 rounded">worktree</span>
                )}
              </span>
              {((sessionData.git_ahead || 0) > 0 || (sessionData.git_behind || 0) > 0) && (
                <span className="flex items-center gap-0.5 text-[10px]">
                  {(sessionData.git_ahead || 0) > 0 && <span className="text-green-500">{sessionData.git_ahead}&#8593;</span>}
                  {(sessionData.git_behind || 0) > 0 && (
                    <button
                      className="text-cc-warning hover:text-amber-400 cursor-pointer hover:underline"
                      title="Pull latest changes"
                      onClick={() => {
                        const cwd = sessionData.repo_root || sessionData.cwd;
                        if (!cwd) return;
                        api.gitPull(cwd).then((r) => {
                          useStore.getState().updateSession(sessionId, {
                            git_ahead: r.git_ahead,
                            git_behind: r.git_behind,
                          });
                          if (!r.success) console.warn("[git pull]", r.output);
                        }).catch((e) => console.error("[git pull]", e));
                      }}
                    >
                      {sessionData.git_behind}&#8595;
                    </button>
                  )}
                </span>
              )}
              {((sessionData.total_lines_added || 0) > 0 || (sessionData.total_lines_removed || 0) > 0) && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{sessionData.total_lines_added || 0}</span>
                  <span className="text-red-400">-{sessionData.total_lines_removed || 0}</span>
                </span>
              )}
            </div>
          )}

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-2.5 pb-2">
            {/* Left: mode indicator */}
            <button
              onClick={toggleMode}
              disabled={!isConnected || isCodex || isSpectator}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono-code transition-all select-none ${
                !isConnected || isCodex || isSpectator
                  ? "opacity-25 cursor-not-allowed text-cc-muted"
                  : isPlan
                  ? "text-cc-primary hover:bg-cc-primary/10 cursor-pointer"
                  : "text-cc-muted/60 hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              }`}
              title={isCodex ? "Mode is fixed for Codex sessions" : "Toggle mode (Shift+Tab)"}
            >
              {isPlan ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                  <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
              <span>{modeLabel}</span>
            </button>

            {/* Right: image + send/stop */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!isConnected || isSpectator}
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                  isConnected && !isSpectator
                    ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                    : "text-cc-muted opacity-30 cursor-not-allowed"
                }`}
                title="Upload image"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {speechSupported && (
                <button
                  onClick={toggleVoice}
                  disabled={!isConnected || isSpectator}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                    !isConnected || isSpectator
                      ? "text-cc-muted opacity-30 cursor-not-allowed"
                      : isListening
                      ? "text-cc-error bg-cc-error/10 hover:bg-cc-error/20 cursor-pointer"
                      : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  }`}
                  title={isListening ? "Stop listening" : `Voice input (${navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Shift+M)`}
                >
                  {isListening ? (
                    <span className="relative flex items-center justify-center">
                      <span className="absolute inline-flex h-4 w-4 rounded-full bg-cc-error/30 animate-ping" />
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 relative">
                        <path d="M8 1a2.5 2.5 0 00-2.5 2.5v4a2.5 2.5 0 005 0v-4A2.5 2.5 0 008 1z" />
                        <path d="M3.5 7a.75.75 0 011.5 0 3 3 0 006 0 .75.75 0 011.5 0 4.5 4.5 0 01-3.75 4.437V13h1.5a.75.75 0 010 1.5h-4.5a.75.75 0 010-1.5h1.5v-1.563A4.5 4.5 0 013.5 7z" />
                      </svg>
                    </span>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                      <path d="M8 1a2.5 2.5 0 00-2.5 2.5v4a2.5 2.5 0 005 0v-4A2.5 2.5 0 008 1z" />
                      <path d="M3.5 7a.75.75 0 011.5 0 3 3 0 006 0 .75.75 0 011.5 0 4.5 4.5 0 01-3.75 4.437V13h1.5a.75.75 0 010 1.5h-4.5a.75.75 0 010-1.5h1.5v-1.563A4.5 4.5 0 013.5 7z" />
                    </svg>
                  )}
                </button>
              )}

              {isRunning ? (
                <button
                  onClick={handleInterrupt}
                  disabled={isSpectator}
                  className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                    isSpectator
                      ? "bg-cc-hover text-cc-muted/40 cursor-not-allowed"
                      : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                  }`}
                  title={isSpectator ? "Spectators cannot interrupt" : "Stop generation"}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <rect x="4" y="4" width="8" height="8" rx="1" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                    canSend
                      ? "bg-cc-fg text-cc-bg hover:opacity-80 cursor-pointer"
                      : "bg-cc-hover text-cc-muted/40 cursor-not-allowed"
                  }`}
                  title="Send message (Enter)"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2v10M4 8l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
