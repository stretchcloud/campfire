import { useState, useMemo, lazy, Suspense, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";

const MermaidDiagram = lazy(() => import("./MermaidDiagram.js").then((m) => ({ default: m.MermaidDiagram })));

function extractTextContent(message: ChatMessage): string {
  if (message.content && typeof message.content === "string") {
    // If there are content blocks with text, prefer those for richer content
    if (message.contentBlocks?.length) {
      const textParts = message.contentBlocks
        .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) return textParts.join("\n\n");
    }
    return message.content;
  }
  if (message.contentBlocks?.length) {
    return message.contentBlocks
      .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!text) return null;

  return (
    <button
      onClick={handleCopy}
      className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-all duration-200"
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-success">
          <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z" />
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z" />
        </svg>
      )}
    </button>
  );
}

export function MessageBubble({ message, onFork }: { message: ChatMessage; onFork?: () => void }) {
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border/30" />
        <span className="text-[10px] text-cc-muted/40 uppercase tracking-[0.15em] font-mono-code shrink-0 px-1">
          {message.content}
        </span>
        <div className="flex-1 h-px bg-cc-border/30" />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out] relative">
        <div className="absolute right-2 top-2 opacity-0 group-hover/msg:opacity-100 transition-all duration-200 z-10">
          <div className="rounded-lg bg-cc-card border border-cc-border shadow-sm p-0.5 flex items-center gap-0.5">
            {typeof message.content === "string" && message.content && (
              <CopyButton text={message.content} />
            )}
            {onFork && (
              <button
                onClick={onFork}
                className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-all duration-200"
                title="Fork session from here"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="bg-cc-primary/[0.04] dark:bg-cc-primary/[0.08] rounded-xl px-4 py-3 border border-cc-primary/10">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="attachment"
                  className="max-w-[180px] sm:max-w-[240px] max-h-[140px] sm:max-h-[180px] rounded-lg object-cover border border-cc-border overflow-hidden shadow-sm"
                />
              ))}
            </div>
          )}
          <pre className="text-[13px] whitespace-pre-wrap break-words font-sans-ui leading-[1.65] text-cc-fg">
            {message.content}
          </pre>
        </div>
      </div>
    );
  }

  // Assistant message
  const textContent = extractTextContent(message);
  return (
    <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out] relative">
      <div className="absolute right-0 top-0 opacity-0 group-hover/msg:opacity-100 transition-all duration-200 z-10">
        <div className="rounded-lg bg-cc-card border border-cc-border shadow-sm p-0.5 flex items-center gap-0.5">
          {textContent && <CopyButton text={textContent} />}
          {onFork && (
            <button
              onClick={onFork}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-all duration-200"
              title="Fork session from here"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="py-1">
        <AssistantMessage message={message} />
      </div>
    </div>
  );
}

interface ToolGroupItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type GroupedBlock =
  | { kind: "content"; block: ContentBlock }
  | { kind: "tool_group"; name: string; items: ToolGroupItem[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const groups: GroupedBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      if (last?.kind === "tool_group" && last.name === block.name) {
        last.items.push({ id: block.id, name: block.name, input: block.input });
      } else {
        groups.push({
          kind: "tool_group",
          name: block.name,
          items: [{ id: block.id, name: block.name, input: block.input }],
        });
      }
    } else {
      groups.push({ kind: "content", block });
    }
  }

  return groups;
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const blocks = message.contentBlocks || [];

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);

  if (blocks.length === 0 && message.content) {
    return (
      <div className="log-accent">
        <MarkdownContent text={message.content} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {grouped.map((group, i) => {
        if (group.kind === "content") {
          return (
            <div key={i} className="log-accent">
              <ContentBlockRenderer block={group.block} />
            </div>
          );
        }
        // Single tool_use renders as before
        if (group.items.length === 1) {
          const item = group.items[0];
          return (
            <div key={i} className="log-tool">
              <ToolBlock name={item.name} input={item.input} toolUseId={item.id} />
            </div>
          );
        }
        // Grouped tool_uses
        return (
          <div key={i} className="log-tool">
            <ToolGroupBlock name={group.name} items={group.items} />
          </div>
        );
      })}
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body text-[13px] text-cc-fg leading-[1.7] overflow-hidden">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-[1.7]">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-cc-fg">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{children}</em>
          ),
          h1: ({ children }) => (
            <h1 className="text-base font-semibold text-cc-fg mt-4 mb-1.5 tracking-tight">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[14px] font-semibold text-cc-fg mt-3 mb-1 tracking-tight">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[13px] font-semibold text-cc-fg mt-2 mb-0.5">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-cc-fg leading-[1.6]">{children}</li>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline underline-offset-2 decoration-cc-primary/40 transition-colors">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-cc-border pl-3 my-2 text-cc-muted italic">
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr className="border-cc-border my-4" />
          ),
          code: (props: ComponentProps<"code">) => {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = match || (typeof children === "string" && children.includes("\n"));

            if (isBlock) {
              const lang = match?.[1] || "";
              const codeStr = typeof children === "string" ? children : String(children ?? "");

              // Render mermaid diagrams
              if (lang === "mermaid") {
                return (
                  <Suspense fallback={
                    <div className="my-2 rounded-lg overflow-hidden border border-cc-border">
                      <div className="px-3 py-1 bg-cc-code-bg border-b border-cc-border flex items-center">
                        <span className="rounded-full bg-cc-hover px-2 py-0.5 text-[9px] text-cc-code-fg/40 font-mono-code uppercase">mermaid</span>
                      </div>
                      <div className="px-3 py-3 bg-cc-code-bg text-[11px] text-cc-muted animate-pulse">Loading diagram...</div>
                    </div>
                  }>
                    <MermaidDiagram code={codeStr} />
                  </Suspense>
                );
              }

              return (
                <div className="my-2 rounded-lg overflow-hidden border border-cc-border">
                  {lang && (
                    <div className="px-3 py-1.5 bg-cc-code-bg border-b border-cc-border flex items-center">
                      <span className="rounded-full bg-cc-hover px-2 py-0.5 text-[9px] text-cc-code-fg/40 font-mono-code uppercase">
                        {lang}
                      </span>
                    </div>
                  )}
                  <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-[1.6] overflow-x-auto">
                    <code>{children}</code>
                  </pre>
                </div>
              );
            }

            return (
              <code className="px-1 py-0.5 rounded bg-cc-fg/[0.04] dark:bg-cc-fg/[0.08] text-[12px] font-mono-code text-cc-fg">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-[12px] border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-cc-fg/[0.03]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-2.5 py-1.5 text-left text-[11px] font-semibold text-cc-fg border border-cc-border/60">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 text-[11px] text-cc-fg border border-cc-border/40">
              {children}
            </td>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-cc-hover/40 transition-colors">
              {children}
            </tr>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} />;
  }

  if (block.type === "tool_use") {
    return <ToolBlock name={block.name} input={block.input} toolUseId={block.id} />;
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const isError = block.is_error;
    return (
      <div className={`text-[11px] font-mono-code rounded-lg px-3 py-2 border ${
        isError
          ? "bg-cc-error/5 text-cc-error border-cc-error/20"
          : "bg-cc-hover text-cc-muted border-cc-border/40"
      } max-h-40 overflow-y-auto whitespace-pre-wrap`}>
        {content}
      </div>
    );
  }

  return null;
}

function ToolGroupBlock({ name, items }: { name: string; items: ToolGroupItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  return (
    <div className="rounded-lg overflow-hidden border border-cc-border/60 bg-cc-card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover transition-all duration-200 cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform duration-200 shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-[11px] font-medium text-cc-fg font-mono-code">
          {items.length}x {label}
        </span>
      </button>

      {open && (
        <div className="px-3 py-1.5">
          {items.map((item, i) => {
            const preview = getPreview(item.name, item.input);
            return (
              <div key={item.id || i} className={`flex items-center gap-2 py-0.5 text-[11px] text-cc-muted font-mono-code truncate ${i > 0 ? "border-t border-cc-border/40 pt-1" : ""}`}>
                <span className="text-cc-muted/30 select-none">-</span>
                <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-cc-border/60 bg-cc-card/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-cc-hover/50 transition-all duration-200"
      >
        {/* Brain/thought icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/40 shrink-0">
          <path d="M8 1a5 5 0 00-3.5 8.57V12a1 1 0 001 1h5a1 1 0 001-1V9.57A5 5 0 008 1zm-1.5 13a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-[11px] font-medium text-cc-muted/60 font-mono-code">Reasoning</span>
        <span className="rounded-full bg-cc-hover px-2 py-0.5 text-[9px] text-cc-muted/40 font-mono-code tabular-nums">{text.length}c</span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/30 transition-transform duration-200 ml-auto ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      <div
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight: open ? "10rem" : "0" }}
      >
        <div className="overflow-y-auto max-h-40 border-t border-cc-border/40">
          <div className="px-3 py-2">
            <pre className="text-[12px] text-cc-muted/70 italic font-mono-code whitespace-pre-wrap leading-relaxed">
              {text}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
