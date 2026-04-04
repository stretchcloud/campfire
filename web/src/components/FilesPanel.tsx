import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { detectLanguage } from "./CodeEditor.js";

const CodeEditor = lazy(() => import("./CodeEditor.js").then((m) => ({ default: m.CodeEditor })));

/**
 * FilesPanel — a workspace file browser with Monaco editor.
 *
 * Provides lazy-loaded directory tree, file search/filter, syntax-highlighted
 * editing via Monaco, image preview, and git-changed file indicators.
 * Renders as a tab alongside Log and Diff in the main content area.
 */

interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

interface TreeState {
  expanded: Set<string>;
  children: Map<string, DirEntry[]>;
  loading: Set<string>;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);

function isImage(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTS.has(ext);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FilesPanel({ sessionId }: Readonly<{ sessionId: string }>) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const changedFilesSet = useStore((s) => s.changedFiles.get(sessionId));

  const cwd = session?.cwd || sdkSession?.cwd || "";

  const [tree, setTree] = useState<TreeState>({
    expanded: new Set(),
    children: new Map(),
    loading: new Set(),
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const changedFiles = useMemo(() => changedFilesSet ?? new Set<string>(), [changedFilesSet]);

  // Load root directory
  useEffect(() => {
    if (!cwd) return;
    loadDir(cwd);
  }, [cwd, showHidden]);

  function loadDir(dirPath: string) {
    setTree((prev) => {
      const loading = new Set(prev.loading);
      loading.add(dirPath);
      return { ...prev, loading };
    });
    api.listEntries(dirPath, showHidden).then((res) => {
      const sorted = [...res.entries].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setTree((prev) => {
        const children = new Map(prev.children);
        children.set(dirPath, sorted);
        const loading = new Set(prev.loading);
        loading.delete(dirPath);
        return { ...prev, children, loading };
      });
    }).catch(() => {
      setTree((prev) => {
        const loading = new Set(prev.loading);
        loading.delete(dirPath);
        return { ...prev, loading };
      });
    });
  }

  function toggleDir(dirPath: string) {
    setTree((prev) => {
      const expanded = new Set(prev.expanded);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
        if (!prev.children.has(dirPath)) loadDir(dirPath);
      }
      return { ...prev, expanded };
    });
  }

  // Load file content when selected
  useEffect(() => {
    if (!selectedFile) return;
    if (isImage(selectedFile)) return;
    let cancelled = false;
    setFileLoading(true);
    setEditDirty(false);
    setSaved(false);
    api.readFile(selectedFile).then((res) => {
      if (!cancelled) {
        setFileContent(res.content);
        setOriginalContent(res.content);
        setFileLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setFileContent("");
        setOriginalContent("");
        setFileLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    try {
      await api.writeFile(selectedFile, fileContent);
      setOriginalContent(fileContent);
      setEditDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    setSaving(false);
  }, [selectedFile, fileContent, saving]);

  const handleCancel = useCallback(() => {
    setFileContent(originalContent);
    setEditDirty(false);
  }, [originalContent]);

  const handleSelectFile = useCallback((path: string) => {
    if (editDirty && !globalThis.confirm("Discard unsaved changes?")) return;
    setSelectedFile(path);
    if (globalThis.innerWidth < 640) setSidebarOpen(false);
  }, [editDirty]);

  // Filter entries based on search
  const filterLower = filter.toLowerCase();

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-cc-muted text-sm">Waiting for session to initialize...</p>
      </div>
    );
  }

  const selectedName = selectedFile?.split("/").pop() || "";

  return (
    <div className="h-full flex bg-cc-bg relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <button className="fixed inset-0 bg-black/30 z-20 sm:hidden cursor-default border-none" onClick={() => setSidebarOpen(false)} aria-label="Close file tree" tabIndex={-1} />
      )}

      {/* File tree sidebar */}
      <div className={`${sidebarOpen ? "w-[240px] translate-x-0" : "w-0 -translate-x-full"} fixed sm:relative z-30 sm:z-auto shrink-0 h-full flex flex-col bg-cc-sidebar border-r border-cc-border transition-all duration-200 overflow-hidden`}>
        <div className="w-[240px] shrink-0">
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-cc-border flex items-center gap-2">
            <span className="text-[11px] font-semibold text-cc-fg uppercase tracking-wider flex-1">Files</span>
            <button
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
              className={`w-5 h-5 flex items-center justify-center rounded text-[10px] cursor-pointer transition-colors ${showHidden ? "text-cc-primary bg-cc-primary/10" : "text-cc-muted/40 hover:text-cc-muted"}`}
            >
              .*
            </button>
            <button onClick={() => loadDir(cwd)} title="Refresh" className="w-5 h-5 flex items-center justify-center rounded text-cc-muted/50 hover:text-cc-muted cursor-pointer">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
                <path d="M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.002 7.002 0 011.05 8.84a.75.75 0 01.656-.834zM8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 11-1.49.178A5.5 5.5 0 008 2.5z" />
              </svg>
            </button>
          </div>

          {/* Search filter */}
          <div className="px-3 py-2 border-b border-cc-border">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files..."
              className="w-full h-7 px-2 rounded-md border border-cc-border bg-cc-input-bg text-[11px] text-cc-fg placeholder:text-cc-muted/30 focus:outline-none focus:ring-1 focus:ring-cc-primary/30"
            />
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 w-[240px]">
          <DirEntries
            parentPath={cwd}
            tree={tree}
            filter={filterLower}
            changedFiles={changedFiles}
            selectedFile={selectedFile}
            onToggleDir={toggleDir}
            onSelectFile={handleSelectFile}
            depth={0}
          />
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Top bar */}
        {selectedFile && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer shrink-0" title="Show file tree">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-[13px] font-medium text-cc-fg truncate block">{selectedName}</span>
              <span className="text-[10px] text-cc-muted font-mono-code truncate block">{selectedFile.replace(cwd + "/", "")}</span>
            </div>
            {!isImage(selectedFile) && (
              <div className="flex items-center gap-2 shrink-0">
                {editDirty && !saved && <span className="text-[10px] text-cc-warning">Unsaved</span>}
                {saved && <span className="text-[10px] text-cc-success">Saved</span>}
                {editDirty && (
                  <button
                    onClick={handleCancel}
                    className="px-3 py-1 rounded-md text-[11px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !editDirty}
                  className="px-3 py-1 rounded-md bg-cc-primary text-white text-[11px] font-medium hover:bg-cc-primary-hover cursor-pointer disabled:opacity-40 transition-colors"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <FileContent
            selectedFile={selectedFile}
            selectedName={selectedName}
            fileLoading={fileLoading}
            fileContent={fileContent}
            onContentChange={(val) => { setFileContent(val); setEditDirty(true); }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── File Content Viewer/Editor ──────────────────────────────────────────────

function FileContent({ selectedFile, selectedName, fileLoading, fileContent, onContentChange }: Readonly<{
  selectedFile: string | null;
  selectedName: string;
  fileLoading: boolean;
  fileContent: string;
  onContentChange: (val: string) => void;
}>) {
  if (!selectedFile) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 select-none px-6">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-cc-muted/40" aria-hidden>
          <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9l-7-7z" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="13 2 13 9 20 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="text-sm text-cc-muted">Select a file to view or edit</p>
      </div>
    );
  }
  if (fileLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (isImage(selectedFile)) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-cc-bg">
        <img
          src={`/api/fs/read-raw?path=${encodeURIComponent(selectedFile)}`}
          alt={selectedName}
          className="max-w-full max-h-full object-contain rounded-lg shadow-panel"
        />
      </div>
    );
  }
  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center text-cc-muted text-[12px]">Loading editor...</div>}>
      <CodeEditor
        value={fileContent}
        onChange={onContentChange}
        language={detectLanguage(selectedFile)}
        height="calc(100vh - 120px)"
        minimap
        lineNumbers
        wordWrap={false}
        ariaLabel={`Editing ${selectedName}`}
        className="border-0 rounded-none"
      />
    </Suspense>
  );
}

// ─── Directory Entries (recursive tree) ─────────────────────────────────────

function DirEntries({
  parentPath, tree, filter, changedFiles, selectedFile, onToggleDir, onSelectFile, depth,
}: Readonly<{
  parentPath: string;
  tree: TreeState;
  filter: string;
  changedFiles: Set<string>;
  selectedFile: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  depth: number;
}>) {
  const entries = tree.children.get(parentPath);
  const isLoading = tree.loading.has(parentPath);

  if (isLoading && !entries) {
    return <div className="px-3 py-1 text-[10px] text-cc-muted" style={{ paddingLeft: 12 + depth * 16 }}>Loading...</div>;
  }
  if (!entries) return null;

  const filtered = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter))
    : entries;

  return (
    <>
      {filtered.map((entry) => {
        const isDir = entry.type === "directory";
        const isExpanded = tree.expanded.has(entry.path);
        const isSelected = entry.path === selectedFile;
        const isChanged = changedFiles.has(entry.path);

        return isDir ? (
          <div key={entry.path}>
            <button
              onClick={() => onToggleDir(entry.path)}
              className="flex items-center gap-1.5 w-full px-2 py-1 text-[12px] text-cc-fg/80 hover:bg-cc-hover transition-colors cursor-pointer"
              style={{ paddingLeft: 8 + depth * 16 }}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted/50 shrink-0 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} aria-hidden>
                <path d="M6 4l4 4-4 4V4z" />
              </svg>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning/60 shrink-0" aria-hidden>
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="truncate">{entry.name}</span>
            </button>
            {isExpanded && (
              <DirEntries
                parentPath={entry.path}
                tree={tree}
                filter={filter}
                changedFiles={changedFiles}
                selectedFile={selectedFile}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
                depth={depth + 1}
              />
            )}
          </div>
        ) : (
          <button
            key={entry.path}
            onClick={() => onSelectFile(entry.path)}
            className={`flex items-center gap-1.5 w-full px-2 py-1 text-[12px] transition-colors cursor-pointer ${
              isSelected ? "bg-cc-active text-cc-fg" : "text-cc-fg/70 hover:bg-cc-hover"
            }`}
            style={{ paddingLeft: 8 + depth * 16 + 16 }}
          >
            {isChanged ? (
              <span className="w-1.5 h-1.5 rounded-full bg-cc-warning shrink-0" title="Modified by agent" />
            ) : (
              <span className="w-1.5 h-1.5 shrink-0" />
            )}
            <span className={`truncate ${isChanged ? "text-cc-warning" : ""}`}>{entry.name}</span>
          </button>
        );
      })}
    </>
  );
}
