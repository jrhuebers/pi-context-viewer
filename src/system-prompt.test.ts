import { describe, expect, it } from "vitest";
import { renderReplayedSystemPrompt } from "./system-prompt.js";

describe("renderReplayedSystemPrompt", () => {
	it("shows inline-expanded preamble rather than raw SYSTEM.md directives", () => {
		const prompt = renderReplayedSystemPrompt([
			{ role: "system", content: "", sections: { preamble: "Intro\n\n## Research log\nRule", cwd: "<cwd>project</cwd>" } },
			{ role: "user", content: "hello" },
		]);
		expect(prompt).toBe("Intro\n\n## Research log\nRule\n\n<cwd>project</cwd>");
	});

	it("replays section updates and removals from later system messages", () => {
		expect(renderReplayedSystemPrompt([
			{ role: "system", content: "Base", sections: { preamble: "Before @include.md", cwd: "old", extra: "remove me" } },
			{ role: "system", content: "Added", sections: { preamble: "Before expanded guidance", cwd: "new", extra: null } },
		])).toBe("Base\n\nAdded\n\nBefore expanded guidance\n\nnew");
	});

	it("returns undefined before the branch has a persisted system prompt", () => {
		expect(renderReplayedSystemPrompt([{ role: "user", content: "hello" }])).toBeUndefined();
	});
});
