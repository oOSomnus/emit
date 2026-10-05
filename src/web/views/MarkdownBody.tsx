/**
 * Employee prose as Markdown.
 *
 * The renderer is the standard one: no raw HTML execution (raw nodes become
 * text), no custom URL protocols, and remote images become links instead of
 * network requests. Chat bodies and live progress text share this component so
 * a half-typed answer renders with the same rules as its final form.
 */

import { memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _node, src, alt }) => (
    <a href={src ?? ""} target="_blank" rel="noopener noreferrer">
      {alt !== undefined && alt.length > 0 ? alt : src ?? ""}
    </a>
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="markdown-table-scroll">
      <table {...props}>{children}</table>
    </div>
  ),
};

export const MarkdownBody = memo(function MarkdownBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}): ReactNode {
  return (
    <div className={className === undefined ? "markdown-body" : `markdown-body ${className}`}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {body}
      </Markdown>
    </div>
  );
});
