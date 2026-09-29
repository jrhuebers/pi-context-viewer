import {
	buildSessionContext,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { ScrollableTabContent } from "./scrollable-tab-content.js";
import { allocateInputTokens, classifyProviderPayload, formatProviderPayload, type ProviderRequestSnapshot } from "./request-attribution.js";
import { StatsTabContent, type ContextStats } from "./stats-tab-content.js";
import { collectSkillStats } from "./skill-stats.js";
import { renderReplayedSystemPrompt } from "./system-prompt.js";
import { TabbedOverlay } from "./tabbed-overlay.js";
import { getWheelScrollLines } from "./mouse.js";
import { formatTokens } from "./utils.js";

/** Build display lines with line numbers from raw text. */
export function buildNumberedLines(text: string, theme: Theme): string[] {
	const rawLines = text.split("\n");
	const numWidth = String(rawLines.length).length;
	return rawLines.map((line, i) => {
		const num = String(i + 1).padStart(numWidth, " ");
		return `${theme.fg("dim", num)} ${theme.fg("dim", "│")} ${line}`;
	});
}

function formatImageBlock(block: any): string {
	const label = block.mimeType ?? block.source?.type ?? "unknown";
	return `[Image: ${label}]`;
}

function formatContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			lines.push(String(block));
			continue;
		}
		switch ((block as any).type) {
			case "text": lines.push((block as any).text ?? ""); break;
			case "thinking": lines.push(`[Thinking: ${(block as any).thinking ?? ""}]`); break;
			case "toolCall": lines.push(`[Tool Call: ${(block as any).name}(${JSON.stringify((block as any).arguments ?? {})})]`); break;
			case "image": lines.push(formatImageBlock(block)); break;
			default: lines.push(`[${(block as any).type ?? "unknown"}]`);
		}
	}
	return lines;
}

function formatUsage(usage: any): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.input != null) parts.push(`input: ${usage.input}`);
	if (usage.output != null) parts.push(`output: ${usage.output}`);
	if (usage.reasoning != null) parts.push(`reasoning: ${usage.reasoning}`);
	if (usage.cacheRead != null) parts.push(`cache-read: ${usage.cacheRead}`);
	if (usage.cacheWrite != null) parts.push(`cache-write: ${usage.cacheWrite}`);
	if (usage.totalTokens != null) parts.push(`total: ${usage.totalTokens}`);
	return parts.length > 0 ? `Tokens: ${parts.join(", ")}` : undefined;
}

export function formatMessageForDisplay(message: SessionContext["messages"][number], index: number): string[] {
	const msg = message as any;
	const lines: string[] = ["", `──── Message ${index + 1} ────`, `Role: ${msg.role ?? "unknown"}`];
	if (msg.role === "assistant") {
		if (msg.provider || msg.model) lines.push(`Model: ${[msg.provider, msg.model].filter(Boolean).join("/")}`);
		const usage = formatUsage(msg.usage);
		if (usage) lines.push(usage);
		if (msg.stopReason) lines.push(`Stop: ${msg.stopReason}`);
		if (msg.errorMessage) lines.push(`Error: ${msg.errorMessage}`);
	}
	if (msg.role === "toolResult") {
		lines.push(`Tool: ${msg.toolName ?? "unknown"}`);
		lines.push(`Tool Call ID: ${msg.toolCallId ?? "unknown"}`);
		lines.push(`Error: ${msg.isError ? "yes" : "no"}`);
	}
	if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
		if (msg.role === "compactionSummary" && msg.tokensBefore != null) lines.push(`Tokens before compaction: ${msg.tokensBefore}`);
		if (msg.role === "branchSummary" && msg.fromId) lines.push(`From entry: ${msg.fromId}`);
		lines.push("Summary:", ...(typeof msg.summary === "string" ? msg.summary.split("\n") : ["(empty)"]));
	} else if (msg.role === "bashExecution") {
		lines.push(`Command: ${msg.command ?? "unknown"}`);
		lines.push(`Exit code: ${msg.exitCode ?? "unknown"}`);
		lines.push(`Cancelled: ${msg.cancelled ? "yes" : "no"}`);
		if (msg.excludeFromContext) lines.push("Excluded from provider context: yes");
		lines.push("Output:", ...(typeof msg.output === "string" ? msg.output.split("\n") : ["(no output)"]));
	} else {
		lines.push(...formatContent(msg.content));
	}
	return lines;
}

interface ContextViewerModelInfo {
	provider: string;
	id: string;
	contextWindow?: number;
}

function providerSystemText(payload: unknown, fallback: string): string {
	if (!payload || typeof payload !== "object") return fallback;
	const p = payload as any;
	if (p.instructions !== undefined) return typeof p.instructions === "string" ? p.instructions : JSON.stringify(p.instructions, null, 2);
	if (p.system !== undefined) return typeof p.system === "string" ? p.system : JSON.stringify(p.system, null, 2);
	if (Array.isArray(p.messages)) {
		const systemMessages = p.messages.filter((m: any) => m?.role === "system" || m?.role === "developer");
		if (systemMessages.length > 0) return JSON.stringify(systemMessages, null, 2);
	}
	if (Array.isArray(p.input)) {
		const systemItems = p.input.filter((m: any) => m?.role === "system" || m?.role === "developer");
		if (systemItems.length > 0) return JSON.stringify(systemItems, null, 2);
	}
	return fallback;
}

function providerToolsText(payload: unknown, activeToolDefs: unknown[]): string {
	if (payload && typeof payload === "object" && Array.isArray((payload as any).tools)) {
		return JSON.stringify((payload as any).tools, null, 2);
	}
	if (activeToolDefs.length === 0) return "(no active tools)";
	return JSON.stringify(activeToolDefs, null, 2);
}

function buildTotalContextText(
	systemPrompt: string,
	toolsText: string,
	context: SessionContext,
	usage: ContextUsage | undefined,
	model: ContextViewerModelInfo | undefined,
): string {
	const sections: string[] = [];
	sections.push("═══════════════════════════════════════════════════════", "SYSTEM / INSTRUCTIONS", "═══════════════════════════════════════════════════════", systemPrompt, "");
	sections.push("═══════════════════════════════════════════════════════", "TOOL DEFINITIONS", "═══════════════════════════════════════════════════════", toolsText, "");
	sections.push("═══════════════════════════════════════════════════════", "MESSAGES", "═══════════════════════════════════════════════════════");
	if (context.messages.length > 0) {
		for (let i = 0; i < context.messages.length; i++) sections.push(...formatMessageForDisplay(context.messages[i]!, i));
	} else sections.push("(no messages yet)");
	sections.push("", "═══════════════════════════════════════════════════════", "CONTEXT USAGE", "═══════════════════════════════════════════════════════");
	if (usage) {
		sections.push(`Context meter: ${usage.tokens?.toLocaleString() ?? "unknown"}`);
		if (model) sections.push(`Model: ${model.provider}/${model.id}`, `Context window: ${model.contextWindow?.toLocaleString() ?? usage.contextWindow.toLocaleString()}`);
	}
	return sections.join("\n");
}

const OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: {
		anchor: "center" as const,
		width: "100%" as const,
		maxHeight: "100%" as const,
		margin: 0,
	},
};

export default function contextViewerExtension(pi: ExtensionAPI): void {
	let lastRequest: ProviderRequestSnapshot | undefined;

	// This is the final provider-specific payload, after Pi has serialized the
	// system prompt, tools, messages, thinking, and tool results.
	pi.on("before_provider_request", (event, ctx) => {
		lastRequest = {
			api: ctx.model?.api,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			payload: event.payload,
			parts: classifyProviderPayload(event.payload, ctx.model?.api),
			timestamp: Date.now(),
		};
	});

	// Pair the most recent request payload with the exact usage returned for it.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !event.message.usage || !lastRequest) return;
		lastRequest = { ...lastRequest, usage: event.message.usage };
	});

	pi.on("session_start", () => {
		lastRequest = undefined;
	});

	pi.registerCommand("context", {
		description: "Inspect exact provider usage and proportional context attribution",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const fallbackSystemPrompt = ctx.getSystemPrompt() ?? "";
			const usage = ctx.getContextUsage();
			const allTools = pi.getAllTools();
			const activeToolNames = pi.getActiveTools();
			const activeToolDefs = allTools.filter((t) => activeToolNames.includes(t.name));
			const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			const request = lastRequest;
			// The idle-session fallback can be the unexpanded SYSTEM.md source; the
			// branch transcript contains the prompt after before_agent_start edits.
			const systemPrompt = renderReplayedSystemPrompt(context.messages)
				?? providerSystemText(request?.payload, fallbackSystemPrompt);
			const toolsText = providerToolsText(request?.payload, activeToolDefs);
			const attribution = allocateInputTokens(request?.parts ?? [], request?.usage, usage);
			const payloadChars = request ? formatProviderPayload(request.payload).length : 0;
			const stats: ContextStats = {
				modelName: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
				contextUsage: usage,
				usage: request?.usage,
				inputRows: attribution.rows,
				toolResultRows: attribution.toolResultRows,
				bashCommandRows: attribution.bashCommandRows,
				unknownInputTokens: attribution.unknownTokens ?? 0,
				payloadChars,
				skillRows: collectSkillStats(ctx.sessionManager.getBranch(), context, ctx.getSystemPromptOptions().skills),
			};
			const fullText = buildTotalContextText(systemPrompt, toolsText, context, usage, ctx.model);
			const subtitle = usage?.tokens != null && usage.contextWindow != null
				? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${(usage.percent ?? (usage.tokens / usage.contextWindow) * 100).toFixed(1)}%)`
				: "no usage data yet";

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const wheelScrollLines = getWheelScrollLines(tui);
				const messagesLines: string[] = [];
				if (context.messages.length > 0) {
					for (let i = 0; i < context.messages.length; i++) messagesLines.push(...formatMessageForDisplay(context.messages[i]!, i));
				} else messagesLines.push("(no messages yet)");
				const messagesText = messagesLines.join("\n");
				const payloadText = request ? formatProviderPayload(request.payload) : "(no provider request captured yet)";
				const tabs = [
					new StatsTabContent(stats, theme, wheelScrollLines),
					new ScrollableTabContent({ rawText: systemPrompt, displayLines: buildNumberedLines(systemPrompt, theme), theme, wheelScrollLines }, "System"),
					new ScrollableTabContent({ rawText: toolsText, displayLines: buildNumberedLines(toolsText, theme), theme, wheelScrollLines }, "Tools"),
					new ScrollableTabContent({ rawText: messagesText, displayLines: buildNumberedLines(messagesText, theme), theme, wheelScrollLines }, "Messages"),
					new ScrollableTabContent({ rawText: payloadText, displayLines: buildNumberedLines(payloadText, theme), theme, wheelScrollLines }, "Payload"),
					new ScrollableTabContent({ rawText: fullText, displayLines: buildNumberedLines(fullText, theme), theme, wheelScrollLines }, "Full"),
				];
				return new TabbedOverlay({
					title: "Context Viewer",
					subtitle,
					tabs,
					theme,
					done,
					contentHeight: Math.max(1, tui.terminal.rows - 8),
				});
			}, OVERLAY_OPTIONS);
		},
	});
}
