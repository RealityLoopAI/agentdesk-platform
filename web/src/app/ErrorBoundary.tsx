import { Component, type ErrorInfo, type PropsWithChildren } from 'react';

import { Button } from '@/components/ui/Button';

export class ErrorBoundary extends Component<PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Production telemetry is intentionally handled by the Host; do not log
    // protected API payloads or browser session material here.
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="grid min-h-screen place-items-center bg-canvas p-6">
        <section role="alert" className="max-w-md rounded-lg border border-line bg-surface p-8 text-center">
          <h1 className="text-xl font-semibold text-ink">页面暂时无法显示</h1>
          <p className="mt-3 text-sm leading-6 text-muted">请刷新后重试。你的登录凭证和消息不会写入浏览器存储。</p>
          <Button className="mt-6" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        </section>
      </main>
    );
  }
}
