import type { MessageData } from "@better-ccflare/types";

export const genMessageKey = (msg: MessageData, index: number): string => {
	const preview = msg.content?.slice(0, 20).replace(/\s/g, "-");
	return [
		"msg",
		msg.role,
		index,
		preview ||
			msg.tools?.[0]?.name ||
			msg.toolResults?.[0]?.tool_use_id ||
			"empty",
	].join("-");
};
