import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { ApiError, getMe } from '@/api/client';
import { BrandLogo } from '@/branding/BrandLogo';

export function ProtectedRoute() {
  const location = useLocation();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
  });

  if (me.isPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-canvas" aria-busy="true" aria-live="polite">
        <div className="flex items-center gap-3 text-sm text-muted">
          <BrandLogo className="size-9 animate-pulse motion-reduce:animate-none" decorative />
          正在确认登录状态…
        </div>
      </main>
    );
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (me.isError) {
    throw me.error;
  }
  return <Outlet context={{ me: me.data }} />;
}
