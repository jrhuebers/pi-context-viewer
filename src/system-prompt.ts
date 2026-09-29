interface SystemDelta {
	role?: string;
	content?: unknown;
	sections?: Record<string, string | null>;
}

function systemContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text).join("\n");
}

/** Replay the branch's persisted system sections, including before_agent_start edits. */
export function renderReplayedSystemPrompt(messages: readonly SystemDelta[]): string | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let hasSystemMessage = false;
	for (const message of messages) {
		if (message.role !== "system") continue;
		hasSystemMessage = true;
		const text = systemContentText(message.content);
		if (text) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	if (!hasSystemMessage) return undefined;
	return [...content, ...sections.values()].filter(Boolean).join("\n\n");
}
