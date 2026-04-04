import { useRef, useCallback } from "react";
import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useStore } from "../store.js";

/**
 * CodeEditor — a shared Monaco Editor wrapper with Campfire theme integration.
 *
 * Provides VS Code-quality editing with syntax highlighting, IntelliSense,
 * minimap, find/replace, code folding, and multi-cursor. Auto-switches
 * between light/dark Campfire themes.
 *
 * Usage:
 *   <CodeEditor value={code} onChange={setCode} language="markdown" />
 *   <CodeEditor value={code} readOnly language="typescript" />
 */

// ─── Campfire Monaco Themes ─────────────────────────────────────────────────

const CAMPFIRE_LIGHT: editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "71717A", fontStyle: "italic" },
    { token: "keyword", foreground: "5B5FC7" },
    { token: "string", foreground: "22C55E" },
    { token: "number", foreground: "F59E0B" },
    { token: "type", foreground: "5BA8A0" },
    { token: "variable", foreground: "09090B" },
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#09090B",
    "editor.lineHighlightBackground": "#00000006",
    "editor.selectionBackground": "#5B5FC730",
    "editor.inactiveSelectionBackground": "#5B5FC715",
    "editorLineNumber.foreground": "#71717A60",
    "editorLineNumber.activeForeground": "#71717A",
    "editorIndentGuide.background": "#00000008",
    "editorCursor.foreground": "#5B5FC7",
    "editor.findMatchBackground": "#F59E0B30",
    "editor.findMatchHighlightBackground": "#F59E0B18",
    "editorWidget.background": "#FFFFFF",
    "editorWidget.border": "#00000010",
    "input.background": "#FAFAFA",
    "input.border": "#00000010",
    "minimap.background": "#FAFAFA",
    "scrollbarSlider.background": "#71717A20",
    "scrollbarSlider.hoverBackground": "#71717A40",
  },
};

const CAMPFIRE_DARK: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "A1A1AA", fontStyle: "italic" },
    { token: "keyword", foreground: "818CF8" },
    { token: "string", foreground: "4ADE80" },
    { token: "number", foreground: "FBBF24" },
    { token: "type", foreground: "5BA8A0" },
    { token: "variable", foreground: "FAFAFA" },
  ],
  colors: {
    "editor.background": "#18181B",
    "editor.foreground": "#FAFAFA",
    "editor.lineHighlightBackground": "#FFFFFF06",
    "editor.selectionBackground": "#818CF830",
    "editor.inactiveSelectionBackground": "#818CF815",
    "editorLineNumber.foreground": "#A1A1AA50",
    "editorLineNumber.activeForeground": "#A1A1AA",
    "editorIndentGuide.background": "#FFFFFF08",
    "editorCursor.foreground": "#818CF8",
    "editor.findMatchBackground": "#FBBF2430",
    "editor.findMatchHighlightBackground": "#FBBF2418",
    "editorWidget.background": "#18181B",
    "editorWidget.border": "#FFFFFF10",
    "input.background": "#09090B",
    "input.border": "#FFFFFF10",
    "minimap.background": "#09090B",
    "scrollbarSlider.background": "#A1A1AA20",
    "scrollbarSlider.hoverBackground": "#A1A1AA40",
  },
};

let themesRegistered = false;

function registerThemes(monaco: Monaco) {
  if (themesRegistered) return;
  monaco.editor.defineTheme("campfire-light", CAMPFIRE_LIGHT);
  monaco.editor.defineTheme("campfire-dark", CAMPFIRE_DARK);
  themesRegistered = true;
}

// ─── Language Detection ─────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  kt: "kotlin", scala: "scala", r: "r",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "ini",
  md: "markdown", mdx: "markdown", txt: "plaintext",
  sql: "sql", xml: "xml", xsl: "xml",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  dockerfile: "dockerfile", docker: "dockerfile",
  graphql: "graphql", gql: "graphql",
};

export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const basename = filePath.split("/").pop()?.toLowerCase() || "";
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "plaintext";
  if (basename.endsWith(".json")) return "json";
  return EXT_TO_LANG[ext] || "plaintext";
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface CodeEditorProps {
  /** The text content */
  value: string;
  /** Called on every edit (omit for read-only) */
  onChange?: (value: string) => void;
  /** Monaco language ID (e.g. "typescript", "markdown", "json") */
  language?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Height — CSS value (default: "300px") */
  height?: string;
  /** Show minimap (default: false for small editors, true for tall ones) */
  minimap?: boolean;
  /** Show line numbers (default: true) */
  lineNumbers?: boolean;
  /** Word wrap (default: true) */
  wordWrap?: boolean;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Additional CSS class for the container */
  className?: string;
  /** ARIA label for accessibility */
  ariaLabel?: string;
}

export function CodeEditor({
  value,
  onChange,
  language = "plaintext",
  readOnly = false,
  height = "300px",
  minimap = false,
  lineNumbers = true,
  wordWrap = true,
  className = "",
  ariaLabel,
}: Readonly<CodeEditorProps>) {
  const darkMode = useStore((s) => s.darkMode);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback((ed, monaco) => {
    registerThemes(monaco);
    monaco.editor.setTheme(darkMode ? "campfire-dark" : "campfire-light");
    editorRef.current = ed;

    // Configure editor for better UX
    ed.updateOptions({
      fontSize: 13,
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontLigatures: false,
      renderLineHighlight: readOnly ? "none" : "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      padding: { top: 12, bottom: 12 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      roundedSelection: true,
      guides: { indentation: true, bracketPairs: false },
    });

    if (ariaLabel) {
      ed.updateOptions({ ariaLabel });
    }
  }, [darkMode, readOnly, ariaLabel]);

  const handleChange = useCallback((val: string | undefined) => {
    if (onChange && val !== undefined) onChange(val);
  }, [onChange]);

  const theme = darkMode ? "campfire-dark" : "campfire-light";

  return (
    <div className={`rounded-xl border border-cc-border overflow-hidden ${className}`}>
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme={theme}
        options={{
          readOnly,
          minimap: { enabled: minimap },
          lineNumbers: lineNumbers ? "on" : "off",
          wordWrap: wordWrap ? "on" : "off",
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
          folding: true,
          glyphMargin: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 3,
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          contextmenu: true,
          quickSuggestions: !readOnly,
          suggestOnTriggerCharacters: !readOnly,
          bracketPairColorization: { enabled: true },
        }}
        loading={
          <div className="flex items-center justify-center h-full text-cc-muted text-[12px]">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}
