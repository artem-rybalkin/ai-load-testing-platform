import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useRouteError } from 'react-router-dom';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'An unexpected error occurred while rendering this page.';

function Fallback({ title, message }: { title?: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <p className="font-display text-lg font-semibold text-tx">{title ?? 'Something went wrong'}</p>
      <p className="text-sm text-tx-3 max-w-md">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-tx hover:bg-hover"
      >
        Reload
      </button>
    </div>
  );
}

/** For use as a route's `errorElement` — catches errors thrown from that
 *  route's loader or render, retrieved via useRouteError() instead of
 *  componentDidCatch (React Router's data router handles the catching itself,
 *  this just renders the same fallback UI as the class-component boundary
 *  below for anything outside the router's own error handling). */
export function RouteErrorBoundary({ fallbackTitle }: { fallbackTitle?: string }) {
  const error = useRouteError();
  return <Fallback title={fallbackTitle} message={errorMessage(error)} />;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Uncaught render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <Fallback title={this.props.fallbackTitle} message={errorMessage(this.state.error)} />;
    }
    return this.props.children;
  }
}
