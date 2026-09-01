# pi-context-viewer

A Pi extension for inspecting the context sent to the model.

The `/context` overlay shows:

- provider-reported input, output, cache, and reasoning usage;
- proportional attribution of input tokens to system prompt, tool definitions, human/agent messages, tool calls, tool results, and replayed thinking;
- the provider-specific payload captured immediately before it is sent;
- system/instruction text, exact serialized tool definitions, session messages, and a combined view.

Per-category token values are estimates calibrated to the provider's exact aggregate usage. OpenAI's hidden reasoning count is shown from `usage.output_tokens_details.reasoning_tokens` when available, while opaque reasoning replay is marked as such.

## Use

Install the package from GitHub:

```bash
pi install git:github.com/jrhuebers/pi-context-viewer
```

Then run:

```text
/context
```

The extension is based on `@agnishc/edb-context-viewer` by Agnish Chakraborty and retains its MIT license.

## Development

```bash
pi -e ./src/index.ts
```

The extension keeps the latest provider payload in memory only; it does not write request payloads or context contents to the session JSONL file.
