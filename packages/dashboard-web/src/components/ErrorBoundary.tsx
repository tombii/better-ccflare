import React from "react";

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
	children: React.ReactNode;
	fallback?: React.ComponentType<{ error: Error | null; reset: () => void }>;
	onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

/**
 * Error Boundary component to catch and handle errors in React component trees
 * Prevents UI crashes and provides graceful error handling
 */
export class ErrorBoundary extends React.Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		this.setState({
			error,
			errorInfo,
		});

		// Call error handler if provided
		if (this.props.onError) {
			this.props.onError(error, errorInfo);
		}

		// Log error for debugging
		console.error("ErrorBoundary caught an error:", error, errorInfo);
	}

	handleReset = () => {
		this.setState({
			hasError: false,
			error: null,
			errorInfo: null,
		});
	};

	render() {
		if (this.state.hasError) {
			const FallbackComponent = this.props.fallback || DefaultErrorFallback;
			return (
				<FallbackComponent error={this.state.error} reset={this.handleReset} />
			);
		}

		return this.props.children;
	}
}

/**
 * Default error fallback component
 */
interface DefaultErrorFallbackProps {
	error: Error | null;
	reset: () => void;
}

function DefaultErrorFallback({ error, reset }: DefaultErrorFallbackProps) {
	return (
		<div className="p-4 border border-red-200 rounded-lg bg-red-50 dark:bg-red-900/20 dark:border-red-800">
			<div className="flex flex-col items-center text-center">
				<div className="text-red-600 dark:text-red-400 mb-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="h-8 w-8"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
						/>
					</svg>
				</div>
				<h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
					Something went wrong
				</h3>
				<p className="text-red-600 dark:text-red-300 mb-4 max-w-md">
					{error?.message ||
						"An unexpected error occurred while loading this component."}
				</p>
				<button
					onClick={reset}
					className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
				>
					Try again
				</button>
			</div>
		</div>
	);
}

/**
 * Token Status Error Fallback component for OAuth token status specific errors
 */
export function TokenStatusErrorFallback() {
	return (
		<span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 rounded-full">
			Status unavailable
		</span>
	);
}

/**
 * API Error Boundary for components that make API calls
 */
export function APIErrorBoundary({ children }: { children: React.ReactNode }) {
	const handleAPIError = (error: Error, errorInfo: React.ErrorInfo) => {
		// Log API errors with additional context
		console.error("API Error Boundary - Error:", error);
		console.error(
			"API Error Boundary - Component Stack:",
			errorInfo.componentStack,
		);

		// You could also send errors to an error reporting service here
		// trackError(error, { componentStack: errorInfo.componentStack, type: 'api-error' });
	};

	return (
		<ErrorBoundary fallback={TokenStatusErrorFallback} onError={handleAPIError}>
			{children}
		</ErrorBoundary>
	);
}

export default ErrorBoundary;
