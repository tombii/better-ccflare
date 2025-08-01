import type { MessageData } from "@ccflare/types";
import {
	cleanLineNumbers,
	genMessageKey,
	parseAssistantMessage,
	parseRequestMessages,
} from "@ccflare/ui-common";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Message } from "./conversation";

interface ConversationViewProps {
	requestBody: string | null;
	responseBody: string | null;
}

function ConversationViewComponent({
	requestBody,
	responseBody,
}: ConversationViewProps) {
	const [messages, setMessages] = useState<MessageData[]>([]);

	// Create stable cleanLineNumbers function
	const cleanLineNumbersCallback = useCallback(cleanLineNumbers, []);

	// Parse request body to extract conversation messages
	const requestMessages = useMemo(
		() => parseRequestMessages(requestBody),
		[requestBody],
	);

	// Parse streaming response to extract assistant message
	const assistantMessage = useMemo(
		() => parseAssistantMessage(responseBody),
		[responseBody],
	);

	// Combine messages
	useEffect(() => {
		const allMessages: MessageData[] = [...requestMessages];
		if (assistantMessage) {
			allMessages.push(assistantMessage);
		}
		setMessages(allMessages);
	}, [requestMessages, assistantMessage]);

	if (messages.length === 0) {
		return (
			<div className="flex items-center justify-center h-32">
				<p className="text-muted-foreground">No conversation data available</p>
			</div>
		);
	}

	return (
		<div className="h-[calc(65vh-10rem)] w-full overflow-hidden">
			<div className="h-full w-full overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">
				{messages.map((message, index) => (
					<Message
						key={genMessageKey(message, index)}
						role={message.role}
						content={message.content}
						contentBlocks={message.contentBlocks}
						tools={message.tools}
						toolResults={message.toolResults}
						cleanLineNumbers={cleanLineNumbersCallback}
					/>
				))}
			</div>
		</div>
	);
}

export const ConversationView = React.memo(ConversationViewComponent);
