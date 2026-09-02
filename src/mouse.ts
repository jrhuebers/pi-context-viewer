/** Default used when running with a TUI that does not expose its wheel setting. */
export const DEFAULT_WHEEL_SCROLL_LINES = 3;

/** Read pi-tui's current mouse-wheel setting. */
export function getWheelScrollLines(tui: unknown): number {
	const value = (tui as { wheelScrollLines?: unknown })?.wheelScrollLines;
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: DEFAULT_WHEEL_SCROLL_LINES;
}

/** Parse terminal mouse-wheel sequences into a line delta. */
export function parseWheelDelta(data: string): number | undefined {
	// SGR mouse protocol: ESC [ < button ; column ; row M/m
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return direction === 0 ? -1 : 1;
	}

	// X10 mouse protocol: ESC [ M button column row (one byte each).
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return direction === 0 ? -1 : 1;
	}

	return undefined;
}
