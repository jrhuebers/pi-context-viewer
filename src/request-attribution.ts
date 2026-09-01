import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export type AttributionCategory =
	| "systemPrompt"
	| "systemTools"
	| "human"
	| "agent"
	| "thinking"
	| "skills"
	| "toolCalls"
	| "toolResults"
	| "summaries"
	| "other";

export interface PayloadPart {
	category: AttributionCategory;
	label: string;
	chars: number;
	opaque?: boolean;
}

export interface ProviderRequestSnapshot {
	api?: string;
	provider?: string;
	model?: string;
	payload: unknown;
	parts: PayloadPart[];
	usage?: any;
	timestamp: number;
}

const jsonChars = (value: unknown): number => {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return String(value).length;
	}
};

const textChars = (value: unknown): number => {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce((n, item) => n + textChars(item), 0);
	if (value && typeof value === "object") {
		const item = value as Record<string, unknown>;
		if (typeof item.text === "string") return item.text.length;
		if (typeof item.thinking === "string") return item.thinking.length;
		if (typeof item.content === "string") return item.content.length;
		if (Array.isArray(item.content)) return textChars(item.content);
	}
	return 0;
};

function isSkillPath(path: unknown): boolean {
	return typeof path === "string" && /(^|\/)\.agents\/skills\/|(^|\/)\.pi\/agent\/.*\/skills\/|(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(path);
}

function isSkillReadCall(value: any): boolean {
	if (value?.name !== "read") return false;
	let args = value.arguments ?? value.input ?? value.args;
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { return false; }
	}
	return isSkillPath(args?.path);
}

function add(parts: PayloadPart[], category: AttributionCategory, label: string, value: unknown, opaque = false): void {
	const chars = jsonChars(value);
	if (chars > 0) parts.push({ category, label, chars, ...(opaque ? { opaque: true } : {}) });
}

function classifyOpenAIResponses(payload: Record<string, any>, parts: PayloadPart[]): boolean {
	let recognized = false;
	const skillCallIds = new Set<string>();
	if (payload.instructions !== undefined) {
		add(parts, "systemPrompt", "instructions", payload.instructions);
		recognized = true;
	}
	if (Array.isArray(payload.tools)) {
		add(parts, "systemTools", "tool definitions", payload.tools);
		recognized = true;
	}
	if (Array.isArray(payload.input)) {
		for (const item of payload.input) {
			if (item?.type === "function_call" || item?.type === "custom_tool_call") {
				const category = isSkillReadCall(item) ? "skills" : "toolCalls";
				if (category === "skills" && item.call_id) skillCallIds.add(item.call_id);
				add(parts, category, category === "skills" ? "skill tool call" : "tool call", item);
			} else if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
				const category = skillCallIds.has(item.call_id) ? "skills" : "toolResults";
				add(parts, category, category === "skills" ? "skill result" : "tool result", item);
			} else if (item?.type === "reasoning") {
				const opaque = item.encrypted_content !== undefined && item.summary === undefined;
				add(parts, "thinking", opaque ? "opaque reasoning item" : "reasoning summary", item, opaque);
			} else if (item?.role === "user") {
				add(parts, "human", "user message", item);
			} else if (item?.role === "assistant") {
				add(parts, "agent", "assistant message", item);
			} else {
				add(parts, "other", "input item", item);
			}
		}
		recognized = true;
	}
	return recognized;
}

function classifyChatMessages(payload: Record<string, any>, parts: PayloadPart[]): boolean {
	if (!Array.isArray(payload.messages)) return false;
	const skillCallIds = new Set<string>();
	for (const message of payload.messages) {
		const role = message?.role;
		if (role === "system" || role === "developer") add(parts, "systemPrompt", role, message);
		else if (role === "user") add(parts, "human", "user message", message);
		else if (role === "tool") {
			const category = skillCallIds.has(message.tool_call_id) ? "skills" : "toolResults";
			add(parts, category, category === "skills" ? "skill result" : "tool result", message);
		}
		else if (role === "assistant") {
			if (message.content !== undefined) add(parts, "agent", "assistant message", { role, content: message.content });
			if (Array.isArray(message.tool_calls)) {
				for (const call of message.tool_calls) {
					const category = isSkillReadCall(call.function ?? call) ? "skills" : "toolCalls";
					if (category === "skills" && call.id) skillCallIds.add(call.id);
					add(parts, category, category === "skills" ? "skill tool call" : "tool call", call);
				}
			} else if (message.tool_calls !== undefined) add(parts, "toolCalls", "tool call", message.tool_calls);
			if (message.reasoning_content !== undefined) add(parts, "thinking", "reasoning", message.reasoning_content);
		} else add(parts, "other", "message", message);
	}
	return true;
}

function classifyAnthropic(payload: Record<string, any>, parts: PayloadPart[]): boolean {
	let recognized = false;
	const skillCallIds = new Set<string>();
	if (payload.system !== undefined) {
		add(parts, "systemPrompt", "system", payload.system);
		recognized = true;
	}
	if (Array.isArray(payload.tools)) {
		add(parts, "systemTools", "tool definitions", payload.tools);
		recognized = true;
	}
	if (Array.isArray(payload.messages)) {
		for (const message of payload.messages) {
			if (message?.role === "user") add(parts, "human", "user message", message);
			else if (message?.role === "assistant") {
				const content = Array.isArray(message.content) ? message.content : [message.content];
				for (const block of content) {
					if (block?.type === "tool_use") {
						const category = isSkillReadCall(block) ? "skills" : "toolCalls";
						if (category === "skills" && block.id) skillCallIds.add(block.id);
						add(parts, category, category === "skills" ? "skill tool call" : "tool call", block);
					} else if (block?.type === "tool_result") {
						const category = skillCallIds.has(block.tool_use_id) ? "skills" : "toolResults";
						add(parts, category, category === "skills" ? "skill result" : "tool result", block);
					} else if (block?.type === "thinking") add(parts, "thinking", "thinking", block);
					else add(parts, "agent", "assistant content", block);
				}
			} else if (message?.role === "tool") add(parts, "toolResults", "tool result", message);
			else add(parts, "other", "message", message);
		}
		recognized = true;
	}
	return recognized;
}

/** Classify the final provider payload for proportional attribution. */
export function classifyProviderPayload(payload: unknown, api?: string): PayloadPart[] {
	if (!payload || typeof payload !== "object") return [];
	const object = payload as Record<string, any>;
	const parts: PayloadPart[] = [];
	let recognized = false;

	if (api?.includes("openai") || api?.includes("codex")) {
		const responsesRecognized = classifyOpenAIResponses(object, parts);
		const chatRecognized = classifyChatMessages(object, parts);
		recognized = responsesRecognized || chatRecognized;
	}
	if (api?.includes("anthropic")) recognized = classifyAnthropic(object, parts) || recognized;
	if (!recognized) {
		// Generic fallback for providers with conventional fields.
		if (object.system !== undefined) add(parts, "systemPrompt", "system", object.system);
		if (object.instructions !== undefined) add(parts, "systemPrompt", "instructions", object.instructions);
		if (Array.isArray(object.tools)) add(parts, "systemTools", "tool definitions", object.tools);
		if (Array.isArray(object.messages)) {
			for (const message of object.messages) {
				const role = message?.role;
				add(parts, role === "user" ? "human" : role === "assistant" ? "agent" : role === "tool" ? "toolResults" : "other", `${role ?? "unknown"} message`, message);
			}
		}
	}
	return parts;
}

export interface AttributionRow {
	category: AttributionCategory;
	label: string;
	chars: number;
	tokens: number;
	percent: number;
	count: number;
	opaque: boolean;
}

const usageInputTokens = (usage: any): number | undefined => {
	if (!usage || typeof usage.input !== "number") return undefined;
	return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
};

/** Allocate an exact provider-reported bucket proportionally across payload parts. */
export function allocateInputTokens(
	parts: PayloadPart[],
	usage: any,
	fallbackUsage?: ContextUsage,
): { rows: AttributionRow[]; inputTokens?: number; unknownTokens?: number } {
	const inputTokens = usageInputTokens(usage) ?? (fallbackUsage?.tokens ?? undefined);
	const grouped = new Map<AttributionCategory, PayloadPart[]>();
	for (const part of parts) {
		const list = grouped.get(part.category) ?? [];
		list.push(part);
		grouped.set(part.category, list);
	}

	const allChars = parts.reduce((n, part) => n + part.chars, 0);
	if (inputTokens === undefined || allChars === 0) return { rows: [], inputTokens };

	const rows: AttributionRow[] = [];
	let allocated = 0;
	for (const [category, categoryParts] of grouped) {
		const chars = categoryParts.reduce((n, part) => n + part.chars, 0);
		const tokens = Math.round(inputTokens * chars / allChars);
		allocated += tokens;
		rows.push({
			category,
			label: categoryLabel(category),
			chars,
			tokens,
			percent: inputTokens > 0 ? tokens / inputTokens * 100 : 0,
			count: categoryParts.length,
			opaque: categoryParts.some((part) => part.opaque),
		});
	}
	const unknownTokens = Math.max(0, inputTokens - allocated);
	return { rows, inputTokens, unknownTokens };
}

export function categoryLabel(category: AttributionCategory): string {
	return {
		systemPrompt: "System prompt",
		systemTools: "Tool definitions",
		human: "Human messages",
		agent: "Agent messages",
		thinking: "Replayed thinking",
		skills: "Skills",
		toolCalls: "Tool calls",
		toolResults: "Tool results",
		summaries: "Summaries",
		other: "Other/protocol",
	}[category];
}

export function formatProviderPayload(payload: unknown): string {
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

export function getVisibleAssistantChars(message: any): { text: number; toolCalls: number; thinking: number } {
	let text = 0;
	let toolCalls = 0;
	let thinking = 0;
	for (const block of message?.content ?? []) {
		if (block?.type === "text") text += textChars(block.text);
		else if (block?.type === "toolCall") toolCalls += jsonChars(block);
		else if (block?.type === "thinking") thinking += textChars(block.thinking);
	}
	return { text, toolCalls, thinking };
}
