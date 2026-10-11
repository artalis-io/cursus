import { Component, type ErrorInfo, type ReactNode } from 'react';

/* Catches render-time errors so a bug in one component shows a recoverable
 * message instead of a blank white screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI error boundary:', error, info.componentStack); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
          Reload
        </button>
      </div>
    );
  }
}
