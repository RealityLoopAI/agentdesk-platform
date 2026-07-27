import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import { BrandLogo } from '@/branding/BrandLogo';
import { useBranding } from '@/branding/BrandingProvider';
import { Button } from '@/components/ui/Button';

export function LoginPage() {
  const branding = useBranding();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const failed = params.get('error') === 'authentication_failed';

  return (
    <main className="relative grid min-h-screen overflow-hidden bg-canvas px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)] lg:gap-12 lg:px-16">
      <div className="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-brand-subtle opacity-70 blur-3xl" />
      <section className="relative hidden max-w-2xl content-center lg:grid">
        <BrandLogo className="mb-10 size-20" />
        <p className="mb-4 text-sm font-semibold tracking-[0.18em] text-brand uppercase">连接工作，延续上下文</p>
        <h1 className="max-w-xl text-5xl leading-[1.12] font-semibold tracking-tight text-ink">
          在浏览器和飞书之间，
          <span className="text-brand">继续同一段 Agent 会话。</span>
        </h1>
        <p className="mt-7 max-w-lg text-lg leading-8 text-muted">
          消息历史、用户身份和权限都由服务端统一管理。换一个终端，不需要从头解释。
        </p>
      </section>

      <section className="relative mx-auto grid w-full max-w-md content-center">
        <div className="rounded-xl border border-line bg-surface p-7 shadow-[var(--shadow-panel)] sm:p-10">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandLogo className="size-12" />
            <span className="text-lg font-semibold text-ink">{branding.displayName}</span>
          </div>
          <div className="mb-8">
            <div className="mb-5 inline-flex size-11 items-center justify-center rounded-lg bg-brand-subtle text-brand">
              <ShieldCheck aria-hidden="true" className="size-5" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">登录工作台</h2>
            <p className="mt-2 leading-6 text-muted">使用飞书身份安全登录 {branding.displayName}。</p>
          </div>

          {failed ? (
            <div role="alert" className="mb-5 rounded-md border border-danger/25 bg-danger/5 p-3 text-sm text-danger">
              登录没有完成。请重试；如果仍然失败，请联系管理员确认飞书应用配置。
            </div>
          ) : null}

          <Button className="w-full" asChild>
            <a href="/auth/feishu/start">
              使用飞书登录
              <ArrowRight aria-hidden="true" className="size-4" />
            </a>
          </Button>
          <p className="mt-5 text-center text-xs leading-5 text-muted">登录后只会访问你当前有权限使用的 Agent 会话。</p>
        </div>
      </section>
    </main>
  );
}
