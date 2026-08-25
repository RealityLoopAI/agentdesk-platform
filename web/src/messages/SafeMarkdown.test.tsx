import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeMarkdown } from './SafeMarkdown';

describe('SafeMarkdown', () => {
  it('removes executable markup and unsafe links', () => {
    const { container } = render(
      <SafeMarkdown>{`<script>alert('x')</script>

[危险链接](javascript:alert('x'))

[安全链接](https://example.com)`}</SafeMarkdown>,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('危险链接').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: '安全链接' })).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('renders GFM tables and highlighted code with a copy action', () => {
    const { container } = render(
      <SafeMarkdown>{`| 字段 | 值 |
|---|---|
| 状态 | 正常 |

\`\`\`typescript
const ok = true;
\`\`\``}</SafeMarkdown>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制代码' })).toBeInTheDocument();
    expect(container.querySelector('code.hljs')).toBeInTheDocument();
  });
});
