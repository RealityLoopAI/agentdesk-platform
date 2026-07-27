import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';

import { BrandingProvider } from '@/branding/BrandingProvider';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { ConversationPlaceholder, ConversationsPage } from '@/pages/ConversationsPage';
import { LoginPage } from '@/pages/LoginPage';
import { ErrorBoundary } from './ErrorBoundary';

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
          { path: ':laneId', element: <ConversationPlaceholder /> },
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
