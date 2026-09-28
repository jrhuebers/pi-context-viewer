import { describe, expect, it } from "vitest";
import { collectSkillStats } from "./skill-stats.js";
import type { SessionEntry, SessionContext } from "@earendil-works/pi-coding-agent";

const user = (name: string) => ({ role: "user", content: [{ type: "text", text: `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\nContent\n</skill>` }] });
const call = (id: string, file: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: file } }] });
const result = (id: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "read", isError, content: [{ type: "text", text: "skill instructions" }] });
const branch = (messages: object[]) => messages.map((message, i) => ({ type: "message", id: `${i}`, parentId: i ? `${i - 1}` : null, timestamp: "2026-01-01T00:00:00Z", message })) as SessionEntry[];
const context = (messages: object[]) => ({ messages, thinkingLevel: "off", model: null }) as SessionContext;

describe("skill loads", () => {
	it("counts repeated successful reads and slash commands independently", () => {
		const messages = [user("demo"), call("a", "/skills/demo/SKILL.md"), result("a"), call("b", "/skills/demo/SKILL.md"), result("b"), user("demo"), call("c", "/skills/demo/SKILL.md"), result("c", true)];
		expect(collectSkillStats(branch(messages), context(messages))).toEqual([{
			name: "demo", readCount: 2, commandCount: 2, contextReadCount: 2, contextCommandCount: 2,
		}]);
	});

	it("keeps historical counts when compaction drops skill content, ignoring summaries", () => {
		const messages = [user("demo"), call("a", "/skills/demo/SKILL.md"), result("a")];
		expect(collectSkillStats(branch(messages), context([{ role: "compactionSummary", summary: "Read /skills/demo/SKILL.md" }]))).toEqual([{
			name: "demo", readCount: 1, commandCount: 1, contextReadCount: 0, contextCommandCount: 0,
		}]);
	});

	it("uses discovered skill names rather than directory names", () => {
		const messages = [call("a", "/skills/directory/SKILL.md"), result("a")];
		expect(collectSkillStats(branch(messages), context(messages), [{ name: "real-name", filePath: "/skills/directory/SKILL.md" }])[0]?.name).toBe("real-name");
	});

	it("ignores unmatched tool results and non-skill file reads", () => {
		const messages = [result("missing"), call("a", "/project/README.md"), result("a")];
		expect(collectSkillStats(branch(messages), context(messages))).toEqual([]);
	});
});
