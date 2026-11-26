import { memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../icons.tsx";
import { useCopy } from "./Toast.tsx";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const copy = useCopy();
  const code = (Array.isArray(children) ? children[0] : children) as ReactElement<{
    className?: string;
    children?: ReactNode;
  }>;
  const language = /language-([\w+-]+)/.exec(code?.props?.className ?? "")?.[1] ?? "texte";
  const text = textOf(code?.props?.children).replace(/\n$/, "");
  return (
    <div className="code">
      <div className="code-head">
        <p className="code-lang">{language}</p>
        <button
          type="button"
          className="code-copy"
          aria-label="Copier le code"
          onClick={() => copy(text, "Code copié.")}
        >
          <Icon name="copy" size={16} />
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span>{alt ? `[image : ${alt}]` : "[image]"}</span>,
};

/**
 * Model output as Markdown. Raw HTML is never rendered (react-markdown escapes it) and images are
 * not loaded: an answer cannot run a script or call a foreign server.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
