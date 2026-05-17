import { AlertCircle, Check, Copy, Loader2 } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface CopyButtonProps {
	/**
	 * String or function returning the string to copy.
	 */
	value?: string;
	getValue?: () => string;
	/**
	 * Async value resolver. Used when the value isn't available synchronously
	 * (e.g. when bodies need to be lazy-fetched). When set, the button shows a
	 * spinner while resolving.
	 */
	getValueAsync?: () => Promise<string>;
	/**
	 * Forwarded props to underlying Button
	 */
	variant?: ComponentProps<typeof Button>["variant"];
	size?: ComponentProps<typeof Button>["size"];
	className?: string;
	/**
	 * Children to render inside the button. If provided, an icon will be shown to the left.
	 */
	children?: React.ReactNode;
	/**
	 * Optional title attribute for accessibility.
	 */
	title?: string;
}

/**
 * A small wrapper around the standard Button that copies supplied text to the
 * clipboard and temporarily shows a "Copied!" label with a subtle animation.
 */
export function CopyButton({
	value,
	getValue,
	getValueAsync,
	variant = "ghost",
	size = "sm",
	className,
	children,
	title,
}: CopyButtonProps) {
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errored, setErrored] = useState(false);
	const timeoutRef = useRef<number | null>(null);

	const flashError = (err: unknown) => {
		console.error("Copy failed", err);
		setErrored(true);
		if (timeoutRef.current) {
			window.clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = window.setTimeout(() => setErrored(false), 1500);
	};

	const finishCopy = (text: string) => {
		if (!text) {
			flashError(new Error("No value to copy"));
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				if (timeoutRef.current) {
					window.clearTimeout(timeoutRef.current);
				}
				timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
			})
			.catch((err) => flashError(err));
	};

	const handleCopy = () => {
		if (loading) return;
		if (typeof getValueAsync === "function") {
			setLoading(true);
			getValueAsync()
				.then((text) => finishCopy(text))
				.catch((err) => flashError(err))
				.finally(() => setLoading(false));
			return;
		}
		const text = typeof getValue === "function" ? getValue() : (value ?? "");
		finishCopy(text);
	};

	return (
		<Button
			variant={variant}
			size={size}
			onClick={handleCopy}
			title={title}
			className={cn("relative overflow-hidden", className)}
			disabled={loading}
		>
			{loading ? (
				<Loader2 className="h-4 w-4 animate-spin" />
			) : errored ? (
				<span className="animate-pulse text-destructive" title="Copy failed">
					<AlertCircle className="h-4 w-4" />
				</span>
			) : copied ? (
				<span className="animate-pulse">
					<Check className="h-4 w-4" />
				</span>
			) : children ? (
				<>
					<Copy className="h-4 w-4 mr-1" />
					{children}
				</>
			) : (
				<Copy className="h-4 w-4" />
			)}
		</Button>
	);
}
