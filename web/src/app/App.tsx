import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';

import { BrandingProvider } from '@/branding/BrandingProvider';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { ConversationPlaceholder, ConversationsPage } from '@/pages/ConversationsPage';
import { LoginPage } from '@/pages/LoginPage';
import { ErrorBoundary } from './ErrorBoundary';

const ConversationPage = lazy(() =>
  import('@/pages/ConversationPage').then((module) => ({ default: module.ConversationPage })),
);

function ConversationRoute() {
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-sm text-muted" aria-busy="true">
          正在加载会话…
        </div>
      }
    >
      <ConversationPage />
    </Suspense>
  );
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        path: '/conversations',
        element: <ConversationsPage />,
        children: [
          { index: true, element: <ConversationPlaceholder /> },
          { path: ':laneId', element: <ConversationRoute /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/conversations" replace /> },
]);

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrandingProvider>
          <RouterProvider router={router} />
        </BrandingProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
