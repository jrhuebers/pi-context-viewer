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
	/** Provider tool name, when this part is a correlated tool result. */
	toolName?: string;
	/** Original bash command, when this part is a correlated bash result. */
	toolDetail?: string;
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

function parseToolArguments(value: any): any {
	let args = value?.arguments ?? value?.input ?? value?.args;
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	return args;
}

function isSkillReadCall(value: any): boolean {
	if (value?.name !== "read") return false;
	return isSkillPath(parseToolArguments(value)?.path);
}

function bashCommand(value: any): string | undefined {
	if (value?.name !== "bash") return undefined;
	const command = parseToolArguments(value)?.command;
	return typeof command === "string" && command.trim() ? command : undefined;
}

function compactBashCommand(command: string): string {
	let compact = command.replaceAll(/\s+/g, " ").trim();
	// Environment setup is not useful in the breakdown label. Remove leading
	// assignments, exports, and env wrappers (for example, PIROOT=/...; rg ...).
	for (;;) {
		const before = compact;
		compact = compact.replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^;\s]+)\s*(?:;|&&)?\s*/, "");
		compact = compact.replace(/^export\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:;|&&)\s*/, "");
		compact = compact.replace(/^env\s+(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^;\s]+))\s+)+/, "");
		if (compact === before) break;
	}
	return compact || command.replaceAll(/\s+/g, " ").trim();
}

function bashCommandFamily(command: string): string {
	const compact = compactBashCommand(command);
	const firstWord = compact.match(/^([A-Za-z_][A-Za-z0-9_.-]*)/)?.[1];
	// A shell script may contain diagnostic strings mentioning rg/find. Prefer
	// the actual interpreter when the command starts with one.
	if (firstWord === "node" || firstWord === "python" || firstWord === "python3") return firstWord;
	for (const family of ["rg", "find", "grep"]) {
		if (new RegExp(`(?:^|[;&|]\\s*)${family}\\b`).test(compact)) return family;
	}
	if (firstWord) return firstWord;
	return compact.match(/\b([A-Za-z_][A-Za-z0-9_.-]*)\b/)?.[1] ?? "shell";
}

function add(parts: PayloadPart[], category: AttributionCategory, label: string, value: unknown, opaque = false, toolName?: string, toolDetail?: string): void {
	const chars = jsonChars(value);
	if (chars > 0) parts.push({ category, label, chars, ...(opaque ? { opaque: true } : {}), ...(toolName ? { toolName } : {}), ...(toolDetail ? { toolDetail } : {}) });
}

function classifyOpenAIResponses(payload: Record<string, any>, parts: PayloadPart[]): boolean {
	let recognized = false;
	const skillCallIds = new Set<string>();
	const toolCallNames = new Map<string, string>();
	const toolCallDetails = new Map<string, string>();
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
				if (typeof item.call_id === "string" && typeof item.name === "string") toolCallNames.set(item.call_id, item.name);
				const command = bashCommand(item);
				if (typeof item.call_id === "string" && command) toolCallDetails.set(item.call_id, command);
				add(parts, category, category === "skills" ? "skill tool call" : "tool call", item);
			} else if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
				const category = skillCallIds.has(item.call_id) ? "skills" : "toolResults";
				add(parts, category, category === "skills" ? "skill result" : "tool result", item, false, toolCallNames.get(item.call_id), toolCallDetails.get(item.call_id));
			} else if (item?.type === "reasoning") {
				const opaque = item.encrypted_content !== undefined && item.summary === undefined;
				add(parts, "thinking", opaque ? "opaque reasoning item" : "reasoning summary", item, opaque);
			} else if (item?.role === "system" || item?.role === "developer") {
				add(parts, "systemPrompt", item.role, item);
			} else if (item?.role === "user") {
				add(parts, "human", "user message", item);
			} else if (item?.role === "assistant") {
				add(parts, "agent", "assistant message", item);
			} else {
				add(parts, "other", "input item", item);
			}
		}
		recognized = true;
	} else if (payload.input !== undefined) {
		add(parts, "human", "input", payload.input);
		recognized = true;
	}
	return recognized;
}

function classifyChatMessages(payload: Record<string, any>, parts: PayloadPart[]): boolean {
	if (!Array.isArray(payload.messages)) return false;
	const skillCallIds = new Set<string>();
	const toolCallNames = new Map<string, string>();
	const toolCallDetails = new Map<string, string>();
	for (const message of payload.messages) {
		const role = message?.role;
		if (role === "system" || role === "developer") add(parts, "systemPrompt", role, message);
		else if (role === "user") add(parts, "human", "user message", message);
		else if (role === "tool") {
			const category = skillCallIds.has(message.tool_call_id) ? "skills" : "toolResults";
			add(parts, category, category === "skills" ? "skill result" : "tool result", message, false, toolCallNames.get(message.tool_call_id), toolCallDetails.get(message.tool_call_id));
		}
		else if (role === "assistant") {
			if (message.content !== undefined) add(parts, "agent", "assistant message", { role, content: message.content });
			if (Array.isArray(message.tool_calls)) {
				for (const call of message.tool_calls) {
					const category = isSkillReadCall(call.function ?? call) ? "skills" : "toolCalls";
					if (category === "skills" && call.id) skillCallIds.add(call.id);
					if (typeof call.id === "string" && typeof call.function?.name === "string") toolCallNames.set(call.id, call.function.name);
					const command = bashCommand({ name: call.function?.name, arguments: call.function?.arguments });
					if (typeof call.id === "string" && command) toolCallDetails.set(call.id, command);
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

export interface InputAttribution {
	rows: AttributionRow[];
	toolResultRows: AttributionRow[];
	bashCommandRows: AttributionRow[];
	inputTokens?: number;
	unknownTokens?: number;
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
): InputAttribution {
	const inputTokens = usageInputTokens(usage) ?? (fallbackUsage?.tokens ?? undefined);
	const grouped = new Map<AttributionCategory, PayloadPart[]>();
	for (const part of parts) {
		const list = grouped.get(part.category) ?? [];
		list.push(part);
		grouped.set(part.category, list);
	}

	const allChars = parts.reduce((n, part) => n + part.chars, 0);
	if (inputTokens === undefined || allChars === 0) return { rows: [], toolResultRows: [], bashCommandRows: [], inputTokens };

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

	// Tool results are one provider input bucket, but correlating each result with
	// its preceding tool call lets the UI show which tools supplied that text.
	const toolResultParts = parts.filter((part) => part.category === "toolResults");
	const toolResultTokens = rows.find((row) => row.category === "toolResults")?.tokens ?? 0;
	const toolResultChars = toolResultParts.reduce((n, part) => n + part.chars, 0);
	const toolResultGroups = new Map<string, PayloadPart[]>();
	for (const part of toolResultParts) {
		const name = part.toolName ?? "unknown tool";
		const group = toolResultGroups.get(name) ?? [];
		group.push(part);
		toolResultGroups.set(name, group);
	}
	const toolResultRows: AttributionRow[] = [];
	if (toolResultChars > 0) {
		for (const [toolName, group] of toolResultGroups) {
			const chars = group.reduce((n, part) => n + part.chars, 0);
			const tokens = Math.round(toolResultTokens * chars / toolResultChars);
			toolResultRows.push({
				category: "toolResults",
				label: `${toolName} output`,
				chars,
				tokens,
				percent: inputTokens > 0 ? tokens / inputTokens * 100 : 0,
				count: group.length,
				opaque: group.some((part) => part.opaque),
			});
		}
	}

	const bashParts = toolResultParts.filter((part) => part.toolName === "bash");
	const bashChars = bashParts.reduce((n, part) => n + part.chars, 0);
	const bashTokens = toolResultRows.find((row) => row.label === "bash output")?.tokens ?? 0;
	const bashGroups = new Map<string, PayloadPart[]>();
	for (const part of bashParts) {
		const command = bashCommandFamily(part.toolDetail ?? "(command unavailable)");
		const group = bashGroups.get(command) ?? [];
		group.push(part);
		bashGroups.set(command, group);
	}
	const bashCommandRows: AttributionRow[] = [];
	if (bashChars > 0) {
		for (const [command, group] of bashGroups) {
			const chars = group.reduce((n, part) => n + part.chars, 0);
			const tokens = Math.round(bashTokens * chars / bashChars);
			bashCommandRows.push({
				category: "toolResults",
				label: `bash: ${command}`,
				chars,
				tokens,
				percent: inputTokens > 0 ? tokens / inputTokens * 100 : 0,
				count: group.length,
				opaque: group.some((part) => part.opaque),
			});
		}
	}
	return { rows, toolResultRows, bashCommandRows, inputTokens, unknownTokens };
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
