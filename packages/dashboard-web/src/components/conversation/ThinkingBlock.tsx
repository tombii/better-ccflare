import { MessageSquare } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface ThinkingBlockProps {
	content: string;
}

const MAX_CHARS_COLLAPSE = 200;

function ThinkingBlockComponent({ content }: ThinkingBlockProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);

	return (
		<div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg">
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<MessageSquare className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
					<span className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
						Thinking
					</span>
				</div>
				{isLong && (
					<Button
						variant="ghost"
						size="sm"
						className="h-5 px-2 text-xs"
						onClick={toggle}
					>
						{isExpanded ? "Show less" : "Show more"}
					</Button>
				)}
			</div>
			<div className="text-xs text-yellow-700 dark:text-yellow-300 whitespace-pre overflow-x-auto">
				{display}
			</div>
		</div>
	);
}

export const ThinkingBlock = React.memo(ThinkingBlockComponent);
