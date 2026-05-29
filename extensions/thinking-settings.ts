import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { ThinkingSelectorComponent, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const DEFAULT_LEVEL: ThinkingLevel = "medium";

const LEVEL_ALIASES: Record<string, ThinkingLevel> = {
  "0": "off",
  none: "off",
  no: "off",
  off: "off",
  false: "off",

  "1": "minimal",
  min: "minimal",
  minimal: "minimal",

  "2": "low",
  l: "low",
  low: "low",

  "3": "medium",
  m: "medium",
  med: "medium",
  medium: "medium",

  "4": "high",
  h: "high",
  high: "high",

  "5": "xhigh",
  x: "xhigh",
  xh: "xhigh",
  xhigh: "xhigh",
  max: "xhigh",
  maximum: "xhigh",
};

const COMPLETIONS: AutocompleteItem[] = LEVELS.map((level) => ({
  value: level,
  label: level,
  description: `Set thinking level to ${level}`,
}));

function parseThinkingLevel(args: string): ThinkingLevel | undefined {
  const token = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!token) return undefined;
  return LEVEL_ALIASES[token];
}

function usage(command: string): string {
  return `Usage: /${command} [${LEVELS.join("|")}] (default: ${DEFAULT_LEVEL}; aliases: 0-5, min, med, h, max)`;
}

async function selectThinkingLevel(
  ctx: ExtensionCommandContext,
  current: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  return ctx.ui.custom<ThinkingLevel | undefined>((_tui, _theme, _kb, done) =>
    new ThinkingSelectorComponent(
      current,
      LEVELS,
      (level) => done(level as ThinkingLevel),
      () => done(undefined),
    ),
  );
}

function currentLine(pi: ExtensionAPI): string {
  return `thinking: ${pi.getThinkingLevel()}`;
}

export default function (pi: ExtensionAPI) {
  const setStatus = (ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }) => {
    ctx.ui.setStatus("thinking", currentLine(pi));
  };

  async function setThinking(args: string, ctx: ExtensionCommandContext, command: string) {
    let level = parseThinkingLevel(args);

    if (!level) {
      if (!args.trim() && ctx.hasUI) {
        const current = pi.getThinkingLevel() || DEFAULT_LEVEL;
        const choice = await selectThinkingLevel(ctx, current);
        if (!choice) return;
        level = choice;
      } else if (!args.trim()) {
        level = DEFAULT_LEVEL;
      } else {
        ctx.ui.notify(usage(command), "error");
        return;
      }
    }

    const previous = pi.getThinkingLevel();
    pi.setThinkingLevel(level);
    const actual = pi.getThinkingLevel();
    setStatus(ctx);

    const clamped = actual !== level ? ` (requested ${level}; clamped by current model)` : "";
    ctx.ui.notify(`Thinking ${previous} → ${actual}${clamped}`, "info");
  }

  const commandOptions = (name: "thinking" | "effort") => ({
    description: `Set thinking effort quickly (${LEVELS.join(", ")})`,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const normalized = prefix.trim().toLowerCase();
      const matches = COMPLETIONS.filter((item) => item.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await setThinking(args, ctx, name);
    },
  });

  pi.registerCommand("thinking", commandOptions("thinking"));
  pi.registerCommand("effort", commandOptions("effort"));

  pi.on("session_start", async (_event, ctx) => {
    setStatus(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    setStatus(ctx);
  });
}
