import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import type { AttributionRow } from "./request-attribution.js";
import type { SkillLoadRow } from "./skill-stats.js";
import type { TabContent } from "./tabbed-overlay.js";
import { formatTokens } from "./utils.js";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDelta } from "./mouse.js";

export interface ContextStats {
	modelName: string;
	contextUsage?: ContextUsage;
	usage?: any;
	inputRows: AttributionRow[];
	toolResultRows: AttributionRow[];
	bashCommandRows: AttributionRow[];
	unknownInputTokens: number;
	payloadChars: number;
	skillRows: SkillLoadRow[];
}

function usageInput(usage: any): number | undefined {
	if (!usage || typeof usage.input !== "number") return undefined;
	return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function number(value: unknown): string {
	return typeof value === "number" ? value.toLocaleString() : "N/A";
}

function attributionLabel(label: string): string {
	const width = 28;
	const compact = label.length > width ? `${label.slice(0, width - 1)}…` : label;
	return compact.padEnd(width);
}

export class StatsTabContent implements TabContent {
	readonly name = "Stats";
	readonly footerHints = "↑↓/wheel scroll";
	private scrollOffset = 0;

	constructor(
		private stats: ContextStats,
		private theme: Theme,
		private wheelScrollLines: number = DEFAULT_WHEEL_SCROLL_LINES,
	) {}

	getAboveContentLine(_innerWidth: number): string | null {
		return null;
	}

	getFooterLeft(): string {
		const usage = this.stats.contextUsage;
		if (!usage) return "no context usage";
		const tokens = usage.tokens == null ? "?" : formatTokens(usage.tokens);
		return `${tokens}/${formatTokens(usage.contextWindow)}${usage.percent == null ? "" : ` (${usage.percent.toFixed(1)}%)`}`;
	}

	handleInput(data: string): boolean {
		const wheelDelta = parseWheelDelta(data);
		if (wheelDelta !== undefined) {
			this.scrollOffset = Math.max(0, this.scrollOffset + wheelDelta * this.wheelScrollLines);
			return true;
		}
		if (data === "j" || data === "\u001b[B") {
			this.scrollOffset++;
			return true;
		}
		if (data === "k" || data === "\u001b[A") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return true;
		}
		return false;
	}

	invalidate(): void {}

	renderContent(_innerWidth: number, height: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const usage = this.stats.usage;
		const context = this.stats.contextUsage;

		lines.push(`  ${th.bold(this.stats.modelName)}`);
		lines.push(`  ${th.fg("dim", "Per-category values are proportional estimates calibrated to provider totals.")}`);
		lines.push("");
		lines.push(`  ${th.fg("accent", "Skills loaded (current branch)")}`);
		lines.push(`    ${th.fg("dim", "Full SKILL.md only; reads and /skill:name invocations counted separately.")}`);
		if (this.stats.skillRows.length === 0) {
			lines.push(`    ${th.fg("dim", "No full skill loads recorded on this branch.")}`);
		} else {
			lines.push(`    ${th.fg("dim", "Session: read / command  ·  Current context: read / command")}`);
			for (const row of this.stats.skillRows) {
				const current = row.contextReadCount + row.contextCommandCount > 0;
				lines.push(`    ${current ? th.fg("success", "●") : th.fg("dim", "○")} ${row.name}  ${row.readCount} / ${row.commandCount}  ·  ${row.contextReadCount} / ${row.contextCommandCount}${current ? "" : " (not in context)"}`);
			}
		}
		lines.push("");
		lines.push(`  ${th.fg("accent", "Last provider request (exact usage)")}`);
		if (usage) {
			const input = usageInput(usage);
			lines.push(`    Input/context:       ${number(input)} tokens`);
			lines.push(`      uncached:          ${number(usage.input)} tokens`);
			lines.push(`      cache read:        ${number(usage.cacheRead)} tokens`);
			lines.push(`      cache write:       ${number(usage.cacheWrite)} tokens`);
			lines.push(`    Output:              ${number(usage.output)} tokens`);
			lines.push(`      reasoning:         ${usage.reasoning == null ? "not reported" : `${number(usage.reasoning)} tokens`}`);
			lines.push(`    Provider total:      ${number(usage.totalTokens)} tokens`);
		} else {
			lines.push(`    ${th.fg("warning", "No completed provider request captured yet.")}`);
		}
		lines.push("");
		lines.push(`  ${th.fg("accent", "Input/context attribution")}`);
		if (this.stats.inputRows.length === 0) {
			lines.push(`    ${th.fg("dim", "No provider payload captured yet.")}`);
		} else {
			for (const row of this.stats.inputRows.sort((a, b) => b.tokens - a.tokens)) {
				const opaque = row.opaque ? " · opaque" : "";
				lines.push(`    ${attributionLabel(row.label)} ${formatTokens(row.tokens).padStart(8)} · ${row.percent.toFixed(1).padStart(5)}% · ${row.count} part${row.count === 1 ? "" : "s"}${opaque}`);
			}
			if (this.stats.unknownInputTokens > 0) {
				lines.push(`    ${attributionLabel("Unattributed/protocol")} ${formatTokens(this.stats.unknownInputTokens).padStart(8)}`);
			}
		}
		if (this.stats.toolResultRows.length > 0) {
			lines.push("");
			lines.push(`  ${th.fg("accent", "Tool-result breakdown (top 4; input estimate)")}`);
			const toolRows = [...this.stats.toolResultRows].sort((a, b) => b.tokens - a.tokens);
			for (const row of toolRows.slice(0, 4)) {
				lines.push(`    ${attributionLabel(row.label)} ${formatTokens(row.tokens).padStart(8)} · ${row.percent.toFixed(1).padStart(5)}% · ${row.count} result${row.count === 1 ? "" : "s"}`);
			}
			if (toolRows.length > 4) lines.push(`    ${th.fg("dim", `+ ${toolRows.length - 4} more tool${toolRows.length - 4 === 1 ? "" : "s"} recorded`)}`);
		}
		if (this.stats.bashCommandRows.length > 0) {
			lines.push("");
			lines.push(`  ${th.fg("accent", "Bash-result breakdown (top 3; input estimate)")}`);
			const bashRows = [...this.stats.bashCommandRows].sort((a, b) => b.tokens - a.tokens);
			for (const row of bashRows.slice(0, 3)) {
				lines.push(`    ${attributionLabel(row.label)} ${formatTokens(row.tokens).padStart(8)} · ${row.percent.toFixed(1).padStart(5)}% · ${row.count} result${row.count === 1 ? "" : "s"}`);
			}
			if (bashRows.length > 3) lines.push(`    ${th.fg("dim", `+ ${bashRows.length - 3} more command${bashRows.length - 3 === 1 ? "" : "s"} recorded`)}`);
		}
		lines.push("");
		if (context) {
			lines.push(`  ${th.fg("dim", `Footer context meter: ${context.tokens == null ? "unknown" : formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`)}`);
		}
		lines.push(`  ${th.fg("dim", `Payload material: ${this.stats.payloadChars.toLocaleString()} serialized characters`)}`);

		const maxScroll = Math.max(0, lines.length - height);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		return Array.from({ length: height }, (_, i) => lines[this.scrollOffset + i] ?? th.fg("dim", "~"));
	}
}
