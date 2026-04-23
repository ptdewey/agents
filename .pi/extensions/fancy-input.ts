import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Chrome = {
	frame: (s: string) => string;
	side: (s: string) => string;
	prompt: (s: string) => string;
	secondaryPrompt: (s: string) => string;
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

function isBorderLine(text: string): boolean {
	const plain = stripAnsi(text).trim();
	if (!plain) return false;
	if (plain.includes("↑") || plain.includes("↓")) return true;
	return /^─+$/.test(plain);
}

class FancyPromptBarEditor extends CustomEditor {
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private chrome: Chrome,
	) {
		super(tui, theme, keybindings);
	}

	override render(width: number): string[] {
		if (width < 10) return super.render(width);

		const innerWidth = Math.max(1, width - 4);
		const base = super.render(innerWidth);
		if (base.length < 3) return base;

		const bodyStart = 1;
		let bodyEnd = base.length - 1;
		for (let i = base.length - 1; i >= 1; i--) {
			if (isBorderLine(base[i]!)) {
				bodyEnd = i;
				break;
			}
		}

		const contentLines = base.slice(bodyStart, bodyEnd);
		const trailingLines = base.slice(bodyEnd + 1);

		const top = this.chrome.frame(`╭${"─".repeat(width - 2)}╮`);
		const bottom = this.chrome.frame(`╰${"─".repeat(width - 2)}╯`);

		const boxed = contentLines.map((line, index) => {
			const prompt = index === 0 ? this.chrome.prompt("> ") : this.chrome.secondaryPrompt("│ ");
			const bodyWidth = Math.max(1, innerWidth);
			const truncated = truncateToWidth(line, bodyWidth, "");
			const padded = truncated + " ".repeat(Math.max(0, bodyWidth - visibleWidth(truncated)));
			return `${this.chrome.side("│")}${prompt}${padded}${this.chrome.side("│")}`;
		});

		return [top, ...boxed, bottom, ...trailingLines];
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const chrome: Chrome = {
				frame: (s) => ctx.ui.theme.fg("borderAccent", s),
				side: (s) => ctx.ui.theme.fg("accent", s),
				prompt: (s) => ctx.ui.theme.fg("accent", ctx.ui.theme.bold(s)),
				secondaryPrompt: (s) => ctx.ui.theme.fg("muted", s),
			};

			return new FancyPromptBarEditor(tui, editorTheme, keybindings, chrome);
		});
	});
}
