import { Component } from "react";
import type { ReactNode } from "react";
import { IWarn } from "./ui";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class FlowErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[flow] ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="tv-panel flex flex-col items-center gap-3 px-6 py-12 text-center">
          <IWarn size={32} className="text-bear-400" />
          <p className="font-display text-lg font-extrabold tracking-tight text-fog-200">
            FLOW TAB ERROR
          </p>
          <p className="max-w-md text-sm leading-relaxed text-fog-400">
            The FLOW tab encountered an error and has been disabled. The rest of the terminal continues to work normally.
          </p>
          {this.state.error && (
            <pre className="mt-2 max-w-lg overflow-auto rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-[10px] text-fog-500">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="tv-btn mt-2 rounded border border-ink-500 bg-ink-800 px-4 py-1.5 font-mono text-xs font-semibold text-fog-200 hover:border-gold-600/60 hover:text-gold-300"
          >
            RETRY
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
