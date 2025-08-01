import { FileText } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface ToolResultBlockProps {
	content: string;
}

const MAX_CHARS_COLLAPSE = 200;

function ToolResultBlockComponent({ content }: ToolResultBlockProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);

	return (
		<div className="p-3 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg">
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<FileText className="w-3 h-3 text-green-600 dark:text-green-400" />
					<span className="text-xs font-medium text-green-600 dark:text-green-400">
						Tool Result
					</span>
				</div>
				{isLong && (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={toggle}
					>
						{isExpanded ? "Show less" : "Show more"}
					</Button>
				)}
			</div>
			<div className="text-xs bg-green-100/50 dark:bg-green-900/20 p-2 rounded mt-1 overflow-hidden">
				<pre
					className={`overflow-x-auto whitespace-pre text-left ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-2" : ""
					}`}
				>
					{display}
				</pre>
			</div>
		</div>
	);
}

export const ToolResultBlock = React.memo(ToolResultBlockComponent);
