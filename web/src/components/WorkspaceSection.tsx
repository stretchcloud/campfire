import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    ts: "TS", tsx: "TX", js: "JS", jsx: "JX",
    json: "{}", md: "MD", css: "CS", html: "HT",
    py: "PY", rs: "RS", go: "GO", rb: "RB",
    yml: "YM", yaml: "YM", toml: "TL",
    sh: "SH", bash: "SH",
    sql: "SQ", graphql: "GQ",
    svg: "SV", png: "IM", jpg: "IM", gif: "IM",
    txt: "TX", env: "EV", lock: "LK",
    gitignore: "GI", dockerignore: "DI",
  };
  return icons[ext] || "  ";
}

function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.readFile(path)
      .then((r) => setContent(r.content))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [path]);

  const filename = path.split("/").pop() || path;

  return (
    <div className="border-t border-cc-border mt-1">
      <div className="flex items-center justify-between px-2 py-1 bg-cc-hover/50">
        <span className="text-[10px] font-mono-code text-cc-fg truncate">{filename}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      <div className="max-h-[200px] overflow-auto">
        {loading && (
          <div className="p-2 text-[11px] text-cc-muted">Loading...</div>
        )}
        {error && (
          <div className="p-2 text-[11px] text-cc-error">{error}</div>
        )}
        {content !== null && (
          <pre className="p-2 text-[10px] font-mono-code text-cc-fg leading-[1.5] whitespace-pre-wrap break-all">
            {content.slice(0, 10000)}{content.length > 10000 ? "\n... (truncated)" : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  onToggle,
  onSelect,
  selectedPath,
  showHidden,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (node: TreeNode) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  showHidden: boolean;
}) {
  const isDir = node.type === "directory";
  const isSelected = node.path === selectedPath;
  const paddingLeft = 8 + depth * 14;

  return (
    <>
      <button
        onClick={() => isDir ? onToggle(node) : onSelect(node.path)}
        className={`w-full flex items-center gap-1.5 py-[3px] text-left transition-colors group/tree-item hover:bg-cc-hover/70 ${
          isSelected ? "bg-cc-hover" : ""
        }`}
        style={{ paddingLeft }}
      >
        {isDir ? (
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-2.5 h-2.5 text-cc-muted/60 transition-transform shrink-0 ${node.expanded ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        ) : (
          <span className="w-2.5 h-2.5 shrink-0" />
        )}
        {isDir ? (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted/70 shrink-0">
            <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7h-3.25z" />
          </svg>
        ) : (
          <span className="text-[8px] font-mono-code text-cc-muted/50 w-3.5 text-center shrink-0 leading-none">
            {getFileIcon(node.name)}
          </span>
        )}
        <span className={`text-[11px] truncate ${isDir ? "text-cc-fg font-medium" : "text-cc-fg/80"} font-mono-code`}>
          {node.name}
        </span>
        {node.size !== undefined && (
          <span className="text-[9px] text-cc-muted/40 ml-auto pr-2 shrink-0 font-mono-code tabular-nums">
            {formatFileSize(node.size)}
          </span>
        )}
      </button>
      {isDir && node.expanded && node.children && (
        <>
          {node.children
            .filter((child) => showHidden || !child.name.startsWith("."))
            .map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                onToggle={onToggle}
                onSelect={onSelect}
                selectedPath={selectedPath}
                showHidden={showHidden}
              />
            ))}
          {node.loaded && node.children.length === 0 && (
            <div
              className="text-[10px] text-cc-muted/40 italic py-0.5 font-mono-code"
              style={{ paddingLeft: paddingLeft + 18 }}
            >
              empty
            </div>
          )}
        </>
      )}
    </>
  );
}

export function WorkspaceSection({ sessionId }: { sessionId: string }) {
  const cwd = useStore((s) => s.sessions.get(sessionId)?.cwd);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const loadedRef = useRef(false);

  const loadRoot = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    try {
      const result = await api.listEntries(cwd, showHidden);
      setTree(result.entries.map((e) => ({ ...e, loaded: false, expanded: false })));
    } catch {
      setTree([]);
    }
    setLoading(false);
  }, [cwd, showHidden]);

  useEffect(() => {
    if (cwd && !loadedRef.current) {
      loadedRef.current = true;
      loadRoot();
    }
  }, [cwd, loadRoot]);

  // Reload when hidden toggle changes
  useEffect(() => {
    if (loadedRef.current) loadRoot();
  }, [showHidden, loadRoot]);

  const toggleDir = useCallback(async (node: TreeNode) => {
    if (node.expanded) {
      // Collapse
      setTree((prev) => updateNode(prev, node.path, { expanded: false }));
      return;
    }
    if (!node.loaded) {
      // Load children
      try {
        const result = await api.listEntries(node.path, showHidden);
        const children = result.entries.map((e) => ({ ...e, loaded: false, expanded: false }));
        setTree((prev) => updateNode(prev, node.path, { expanded: true, loaded: true, children }));
      } catch {
        setTree((prev) => updateNode(prev, node.path, { expanded: true, loaded: true, children: [] }));
      }
    } else {
      setTree((prev) => updateNode(prev, node.path, { expanded: true }));
    }
  }, [showHidden]);

  if (!cwd) return null;

  return (
    <div className="shrink-0 border-b border-cc-border">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-cc-hover/30 transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform shrink-0 ${collapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted shrink-0">
          <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7h-3.25z" />
        </svg>
        <span className="text-[11px] text-cc-muted uppercase tracking-wider flex-1">Workspace</span>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setShowHidden(!showHidden)}
            className={`p-0.5 rounded text-[9px] font-mono-code transition-colors ${
              showHidden ? "text-cc-fg bg-cc-hover" : "text-cc-muted/40 hover:text-cc-muted"
            }`}
            title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          >
            .*
          </button>
          <button
            onClick={() => { loadedRef.current = false; loadRoot(); }}
            className="p-0.5 rounded text-cc-muted/40 hover:text-cc-muted transition-colors"
            title="Refresh"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M8 3a5 5 0 104.546 2.914.75.75 0 011.358-.628A6.5 6.5 0 118 1.5v2A.75.75 0 018 3z" />
              <path d="M8 1.5V4a.75.75 0 01-.75.75H4.5a.75.75 0 010-1.5h2.69A.75.75 0 008 2.5V1.5z" />
            </svg>
          </button>
        </div>
      </button>

      {!collapsed && (
        <div className="max-h-[300px] overflow-y-auto">
          {loading && tree.length === 0 ? (
            <div className="px-4 py-2 text-[11px] text-cc-muted/50">Loading...</div>
          ) : tree.length === 0 ? (
            <div className="px-4 py-2 text-[11px] text-cc-muted/50 italic">No files</div>
          ) : (
            tree
              .filter((n) => showHidden || !n.name.startsWith("."))
              .map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  onToggle={toggleDir}
                  onSelect={setSelectedFile}
                  selectedPath={selectedFile}
                  showHidden={showHidden}
                />
              ))
          )}

          {selectedFile && (
            <FilePreview path={selectedFile} onClose={() => setSelectedFile(null)} />
          )}
        </div>
      )}
    </div>
  );
}

// Helper to immutably update a node deep in the tree
function updateNode(nodes: TreeNode[], path: string, updates: Partial<TreeNode>): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, ...updates };
    }
    if (node.children) {
      return { ...node, children: updateNode(node.children, path, updates) };
    }
    return node;
  });
}
