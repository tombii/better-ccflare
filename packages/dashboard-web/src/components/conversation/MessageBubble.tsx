import type { Role } from "@ccflare/types";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface MessageBubbleProps {
	role: Role;
	content: string;
}

const MAX_CHARS_COLLAPSE = 300;

const ROLE_BG_COLORS: Record<Role, string> = {
	user: "bg-primary text-primary-foreground",
	assistant: "bg-muted",
	system: "bg-orange-100 dark:bg-orange-900",
};

function MessageBubbleComponent({ role, content }: MessageBubbleProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);
	const bgColor = ROLE_BG_COLORS[role];

	return (
		<div>
			<div className={`rounded-lg px-4 py-2 ${bgColor}`}>
				<div
					className={`whitespace-pre text-sm overflow-x-auto ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-2" : ""
					}`}
				>
					{display}
				</div>
			</div>
			{isLong && (
				<Button
					variant="ghost"
					size="sm"
					className="mt-1 h-6 px-2 text-xs"
					onClick={toggle}
				>
					{isExpanded ? "Show less" : "Show more"}
				</Button>
			)}
		</div>
	);
}

export const MessageBubble = React.memo(MessageBubbleComponent);
