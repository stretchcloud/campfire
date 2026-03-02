import { useState, useMemo, lazy, Suspense, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";

const MermaidDiagram = lazy(() => import("./MermaidDiagram.js").then((m) => ({ default: m.MermaidDiagram })));

export function MessageBubble({ message, onFork }: { message: ChatMessage; onFork?: () => void }) {
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <span className="text-[10px] text-cc-muted/50 uppercase tracking-[0.15em] font-mono-code font-medium shrink-0 px-1">
          {message.content}
        </span>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out] relative">
        {onFork && (
          <button
            onClick={onFork}
            className="absolute right-0 top-0 opacity-0 group-hover/msg:opacity-100 transition-opacity p-1 rounded hover:bg-cc-hover text-cc-muted hover:text-cc-fg z-10"
            title="Fork session from here"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
            </svg>
          </button>
        )}
        <div className="log-user">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono-code text-cc-muted/60 uppercase tracking-wider">you</span>
          </div>
          {message.images && message.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="attachment"
                  className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-md object-cover border border-cc-border"
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
  return (
    <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out] relative">
      {onFork && (
        <button
          onClick={onFork}
          className="absolute right-0 top-0 opacity-0 group-hover/msg:opacity-100 transition-opacity p-1 rounded hover:bg-cc-hover text-cc-muted hover:text-cc-fg z-10"
          title="Fork session from here"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
          </svg>
        </button>
      )}
      <AssistantMessage message={message} />
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
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:text-cc-primary-hover underline underline-offset-2 decoration-cc-primary/30 hover:decoration-cc-primary/60 transition-colors">
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
                    <div className="my-2 rounded-md overflow-hidden border border-cc-border">
                      <div className="px-3 py-1 bg-cc-code-bg border-b border-cc-border text-[9px] text-cc-code-fg/40 font-mono-code uppercase tracking-[0.2em]">mermaid</div>
                      <div className="px-3 py-3 bg-cc-code-bg text-[11px] text-cc-muted animate-pulse">Loading diagram...</div>
                    </div>
                  }>
                    <MermaidDiagram code={codeStr} />
                  </Suspense>
                );
              }

              return (
                <div className="my-2 rounded-md overflow-hidden border border-cc-border">
                  {lang && (
                    <div className="px-3 py-1 bg-cc-code-bg border-b border-cc-border text-[9px] text-cc-code-fg/40 font-mono-code uppercase tracking-[0.2em]">
                      {lang}
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
              <table className="min-w-full text-[12px] border border-cc-border rounded-md overflow-hidden">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-cc-fg/[0.02]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-2.5 py-1 text-left text-[11px] font-semibold text-cc-fg border-b border-cc-border">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1 text-[11px] text-cc-fg border-b border-cc-border">
              {children}
            </td>
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
      <div className={`text-[11px] font-mono-code rounded-md px-3 py-2 ${
        isError
          ? "bg-cc-error/5 text-cc-error"
          : "bg-cc-hover text-cc-muted"
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
    <div className="rounded-md overflow-hidden bg-cc-hover/50">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-[11px] font-medium text-cc-fg font-mono-code">{label}</span>
        <span className="text-[10px] text-cc-muted/60 font-mono-code tabular-nums">
          x{items.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border/50 px-3 py-1.5">
          {items.map((item, i) => {
            const preview = getPreview(item.name, item.input);
            return (
              <div key={item.id || i} className="flex items-center gap-2 py-0.5 text-[11px] text-cc-muted font-mono-code truncate">
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
    <div className="rounded-md overflow-hidden bg-cc-hover/50">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-cc-muted hover:bg-cc-hover transition-colors cursor-pointer font-mono-code"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="font-medium">thinking</span>
        <span className="text-cc-muted/40 tabular-nums">{text.length}c</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-0">
          <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
