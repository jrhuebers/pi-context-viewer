import path from "node:path";
import { parseSkillBlock, type SessionEntry, type SessionContext } from "@earendil-works/pi-coding-agent";

export interface SkillLoadRow {
	name: string;
	readCount: number;
	commandCount: number;
	contextReadCount: number;
	contextCommandCount: number;
}

type Message = SessionContext["messages"][number];

function textOf(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
		: "";
}

function readPath(call: any): string | undefined {
	if (call?.type !== "toolCall" || call.name !== "read") return undefined;
	const file = call.arguments?.path;
	return typeof file === "string" && path.basename(file) === "SKILL.md" ? file : undefined;
}

function skillName(file: string, namesByPath: Map<string, string>): string {
	return namesByPath.get(path.normalize(file)) ?? path.basename(path.dirname(file));
}

function collect(messages: Message[], namesByPath: Map<string, string>): Map<string, { reads: number; commands: number }> {
	const counts = new Map<string, { reads: number; commands: number }>();
	const pendingReads = new Map<string, string>();
	const increment = (name: string, kind: "reads" | "commands") => {
		const row = counts.get(name) ?? { reads: 0, commands: 0 };
		row[kind]++;
		counts.set(name, row);
	};
	for (const message of messages) {
		if (message.role === "user") {
			const block = parseSkillBlock(textOf(message));
			if (block) increment(block.name, "commands");
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				const file = readPath(part);
				if (file && typeof (part as any).id === "string") pendingReads.set((part as any).id, skillName(file, namesByPath));
			}
		} else if (message.role === "toolResult") {
			const name = pendingReads.get(message.toolCallId);
			if (name && !message.isError) increment(name, "reads");
			pendingReads.delete(message.toolCallId);
		}
	}
	return counts;
}

/** Historical loads from the selected branch; current loads from the compaction-aware projection. */
export function collectSkillStats(branch: SessionEntry[], context: SessionContext, skills: readonly { name: string; filePath: string }[] = []): SkillLoadRow[] {
	const namesByPath = new Map(skills.map((skill) => [path.normalize(skill.filePath), skill.name]));
	const history = collect(branch.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message").map((entry) => entry.message), namesByPath);
	const current = collect(context.messages, namesByPath);
	return [...new Set([...history.keys(), ...current.keys()])].map((name) => ({
		name,
		readCount: history.get(name)?.reads ?? 0,
		commandCount: history.get(name)?.commands ?? 0,
		contextReadCount: current.get(name)?.reads ?? 0,
		contextCommandCount: current.get(name)?.commands ?? 0,
	})).sort((a, b) => b.readCount + b.commandCount - a.readCount - a.commandCount || a.name.localeCompare(b.name));
}
