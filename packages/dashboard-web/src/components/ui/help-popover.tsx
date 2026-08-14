import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * A small "?" that opens an explanation next to whatever it labels.
 *
 * Built on Popover rather than a tooltip on purpose: the project has no
 * tooltip primitive and adding @radix-ui/react-tooltip for this would be a new
 * dependency for one control. A popover also opens on click, which is what
 * this needs — the text explains routing precedence and is meant to be read,
 * not glimpsed while the pointer passes by. It is keyboard reachable and
 * closes on Escape for the same reason.
 *
 * `portal={false}` when used inside a Dialog, so the mouse wheel keeps working
 * (see PopoverContent).
 */
export function HelpPopover({
	label,
	children,
	className,
	portal = true,
}: {
	/** Accessible name, e.g. "How combo routing resolves the model". */
	label: string;
	children: ReactNode;
	className?: string;
	portal?: boolean;
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className={cn(
						"inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
				>
					<HelpCircle className="h-4 w-4" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				portal={portal}
				className="w-80 space-y-2 text-xs leading-relaxed text-muted-foreground"
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}
