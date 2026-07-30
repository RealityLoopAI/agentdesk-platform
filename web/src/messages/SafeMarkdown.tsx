import { Check, Copy } from 'lucide-react';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/Button';

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const source = textFromNode(children).replace(/\n$/, '');
  return (
    <div className="group/code relative my-4 min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-[#f6f8f8]">
      <Button
        type="button"
        size="compact"
        variant="secondary"
        className="absolute top-2 right-2 z-10 h-8 min-h-8 bg-surface/90 px-2 text-xs"
        aria-label={copied ? '代码已复制' : '复制代码'}
        onClick={() => {
          void navigator.clipboard
            .writeText(source)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            })
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
        {copied ? '已复制' : '复制'}
      </Button>
      <pre className="overflow-x-auto p-4 pt-12 text-[13px] leading-6">{children}</pre>
    </div>
  );
}

function safeUrl(url: string): string {
  const normalized = url.trim();
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('#') ||
    /^https?:\/\//i.test(normalized) ||
    /^mailto:/i.test(normalized)
  ) {
    return normalized;
  }
  return '';
}

const components: Components = {
  a({ href = '', children }) {
    const safeHref = safeUrl(href);
    if (!safeHref) return <span>{children}</span>;
    const external = /^https?:\/\//i.test(safeHref);
    return (
      <a
        href={safeHref}
        className="font-medium text-brand underline decoration-brand-border underline-offset-2 hover:text-brand-hover"
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <span className="text-sm text-muted">[图片{alt ? `：${alt}` : ''}]</span>;
  },
  pre: CodeBlock,
  table({ children }) {
    return (
      <div className="my-4 max-w-full overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[520px] border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-line bg-brand-subtle px-3 py-2 text-left font-semibold text-ink">{children}</th>
    );
  },
  td({ children }) {
    return <td className="border-b border-line px-3 py-2 align-top">{children}</td>;
  },
  code({ className, children }) {
    return (
      <code
        className={
          className ?? 'rounded-sm border border-line bg-brand-subtle px-1.5 py-0.5 font-mono text-[0.9em] text-ink'
        }
      >
        {children}
      </code>
    );
  },
};

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown min-w-0 max-w-full text-[15px] leading-7 text-ink">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
        urlTransform={safeUrl}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
