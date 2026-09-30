// ═══════════════════════════════════════════════════
// ErrorBoundary — top-level crash screen for the app
// ═══════════════════════════════════════════════════

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught React error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="min-h-dvh w-full bg-canvas p-8 text-fg">
          <div className="mx-auto max-w-3xl rounded-md border border-line bg-surface p-6">
            <h1 className="text-lg font-semibold text-danger">Application error</h1>
            <p className="mt-2 text-[13px] text-fg-muted">
              NERO hit an unexpected error. Reload the page to continue; if it persists, share the details below.
            </p>
            <p className="mt-4 font-mono text-xs text-fg">{this.state.error?.toString()}</p>
            {this.state.errorInfo?.componentStack && (
              <pre className="mt-3 max-h-80 overflow-auto rounded-sm border border-line bg-surface-2 p-3 font-mono text-2xs text-fg-muted">
                {this.state.errorInfo.componentStack}
              </pre>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex h-8 items-center rounded-sm bg-primary-solid px-3 text-[13px] font-medium text-on-primary hover:bg-primary-solid-hover"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
