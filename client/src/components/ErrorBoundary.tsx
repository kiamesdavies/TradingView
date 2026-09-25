import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
  /** Render nothing on failure instead of the inline message (for invisible layers). */
  silent?: boolean;
  /** Changing this value clears a previous error (e.g. pass the symbol). */
  resetKey?: unknown;
}
interface State { error: Error | null; resetKey: unknown }

/** Keeps one failing module (chart, indicators, drawings) from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] crashed`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="boundary-error" role="alert">
        <strong>{this.props.name} failed to render.</strong>
        <span>{this.state.error.message}</span>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
