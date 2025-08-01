import { Terminal } from "lucide-react";
import React, { useMemo } from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface ToolUsageBlockProps {
	toolName: string;
	input?: Record<string, unknown>;
}

const MAX_CHARS_COLLAPSE = 200;

function ToolUsageBlockComponent({ toolName, input }: ToolUsageBlockProps) {
	const inputStr = useMemo(
		() => (input ? JSON.stringify(input, null, 2) : ""),
		[input],
	);

	const { display, isLong, isExpanded, toggle } = useCollapsible(
		inputStr,
		MAX_CHARS_COLLAPSE,
	);
	const hasInput = input && Object.keys(input).length > 0;

	return (
		<div className="p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg">
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<Terminal className="w-3 h-3 text-blue-600 dark:text-blue-400" />
					<span className="text-xs font-medium text-blue-600 dark:text-blue-400">
						Tool: {toolName}
					</span>
				</div>
				{hasInput && isLong && (
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
			{hasInput && (
				<pre
					className={`text-xs bg-blue-100/50 dark:bg-blue-900/20 p-2 rounded mt-1 overflow-x-auto whitespace-pre text-left ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-2" : ""
					}`}
				>
					{display}
				</pre>
			)}
		</div>
	);
}

export const ToolUsageBlock = React.memo(ToolUsageBlockComponent);
