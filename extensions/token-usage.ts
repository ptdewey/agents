import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Usage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

type UsageBucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  messages: number;
};

type StatsFile = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  totals: UsageBucket;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
};

const DEFAULT_STATS_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "token-usage-stats.json",
);

const zeroBucket = (): UsageBucket => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costInput: 0,
  costOutput: 0,
  costCacheRead: 0,
  costCacheWrite: 0,
  costTotal: 0,
  messages: 0,
});

const zeroStats = (): StatsFile => {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    totals: zeroBucket(),
    byProvider: {},
    byModel: {},
  };
};

const addUsage = (bucket: UsageBucket, usage: Usage) => {
  bucket.input += usage.input ?? 0;
  bucket.output += usage.output ?? 0;
  bucket.cacheRead += usage.cacheRead ?? 0;
  bucket.cacheWrite += usage.cacheWrite ?? 0;
  bucket.totalTokens += usage.totalTokens ?? 0;
  bucket.costInput += usage.cost?.input ?? 0;
  bucket.costOutput += usage.cost?.output ?? 0;
  bucket.costCacheRead += usage.cost?.cacheRead ?? 0;
  bucket.costCacheWrite += usage.cost?.cacheWrite ?? 0;
  bucket.costTotal += usage.cost?.total ?? 0;
  bucket.messages += 1;
};

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
const fmtMoney = (n: number): string => `$${n.toFixed(4)}`;
const metricLabel = (label: string): string => label.padEnd(10);

const formatBucketLines = (
  bucket: UsageBucket,
  indent: string,
  style: {
    label?: (text: string) => string;
    value?: (text: string) => string;
    detail?: (text: string) => string;
  } = {},
): string[] => {
  const avg = bucket.messages > 0 ? bucket.totalTokens / bucket.messages : 0;
  const label = style.label ?? ((text: string) => text);
  const value = style.value ?? ((text: string) => text);
  const detail = style.detail ?? ((text: string) => text);

  return [
    `${indent}${label(metricLabel("tokens"))}${value(fmtInt(bucket.totalTokens))} ${detail(`in ${fmtInt(bucket.input)} · out ${fmtInt(bucket.output)} · cache read ${fmtInt(bucket.cacheRead)} · cache write ${fmtInt(bucket.cacheWrite)}`)}`,
    `${indent}${label(metricLabel("cost"))}${value(fmtMoney(bucket.costTotal))} ${detail(`in ${fmtMoney(bucket.costInput)} · out ${fmtMoney(bucket.costOutput)} · cache read ${fmtMoney(bucket.costCacheRead)} · cache write ${fmtMoney(bucket.costCacheWrite)}`)}`,
    `${indent}${label(metricLabel("messages"))}${value(fmtInt(bucket.messages))} ${detail(`avg tokens/msg ${fmtInt(avg)}`)}`,
  ];
};

const categoryTokenTotal = (bucket: UsageBucket): number =>
  bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;

const sortedEntries = (
  obj: Record<string, UsageBucket>,
): Array<[string, UsageBucket]> =>
  Object.entries(obj)
    .filter(([, bucket]) => categoryTokenTotal(bucket) > 0)
    .sort((a, b) => categoryTokenTotal(b[1]) - categoryTokenTotal(a[1]));

type UsageReportDetails = {
  path: string;
  updatedAt: string;
  totals: UsageBucket;
  providers: Array<[string, UsageBucket]>;
  models: Array<[string, UsageBucket]>;
};

const buildReportDetails = (stats: StatsFile, path: string): UsageReportDetails => ({
  path,
  updatedAt: stats.updatedAt,
  totals: stats.totals,
  providers: sortedEntries(stats.byProvider),
  models: sortedEntries(stats.byModel),
});

const renderReport = (
  details: UsageReportDetails,
  style: {
    title?: (text: string) => string;
    section?: (text: string) => string;
    item?: (text: string) => string;
    bullet?: (text: string) => string;
    meta?: (text: string) => string;
    label?: (text: string) => string;
    value?: (text: string) => string;
    detail?: (text: string) => string;
    empty?: (text: string) => string;
  } = {},
): string => {
  const title = style.title ?? ((text: string) => text);
  const section = style.section ?? ((text: string) => text);
  const item = style.item ?? ((text: string) => text);
  const bullet = style.bullet ?? ((text: string) => text);
  const meta = style.meta ?? ((text: string) => text);
  const empty = style.empty ?? ((text: string) => text);
  const bucketStyle = {
    label: style.label,
    value: style.value,
    detail: style.detail,
  };

  const entryLines = (entries: Array<[string, UsageBucket]>): string[] => {
    if (entries.length === 0) return [`  ${empty("(no data)")}`];

    return entries.flatMap(([name, bucket], index) => [
      ...(index === 0 ? [] : [""]),
      `  ${bullet("•")} ${item(name)}`,
      ...formatBucketLines(bucket, "    ", bucketStyle),
    ]);
  };

  return [
    title("Token Usage Stats"),
    meta(`  File:    ${details.path}`),
    meta(`  Updated: ${details.updatedAt}`),
    "",
    section("Total"),
    ...formatBucketLines(details.totals, "  ", bucketStyle),
    "",
    section("By provider"),
    ...entryLines(details.providers),
    "",
    section("By provider/model"),
    ...entryLines(details.models),
  ].join("\n");
};

async function loadStats(path: string): Promise<StatsFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StatsFile>;
    if (parsed.version !== 1) return zeroStats();
    return {
      version: 1,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      totals: { ...zeroBucket(), ...(parsed.totals ?? {}) },
      byProvider: Object.fromEntries(
        Object.entries(parsed.byProvider ?? {}).map(([k, v]) => [
          k,
          { ...zeroBucket(), ...v },
        ]),
      ),
      byModel: Object.fromEntries(
        Object.entries(parsed.byModel ?? {}).map(([k, v]) => [
          k,
          { ...zeroBucket(), ...v },
        ]),
      ),
    };
  } catch {
    return zeroStats();
  }
}

async function saveStats(path: string, stats: StatsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export default function tokenUsageExtension(pi: ExtensionAPI) {
  const statsPath = DEFAULT_STATS_PATH;
  let stats = zeroStats();
  let saveQueue: Promise<void> = Promise.resolve();

  pi.registerMessageRenderer("token-usage", (message, _options, theme) => {
    const details = message.details as UsageReportDetails | undefined;
    const content = details
      ? renderReport(details, {
          title: (text) => theme.bold(theme.fg("accent", text)),
          section: (text) => theme.bold(theme.fg("toolTitle", text)),
          item: (text) => theme.bold(text),
          bullet: (text) => theme.fg("accent", text),
          meta: (text) => theme.fg("muted", text),
          label: (text) => theme.fg("muted", text),
          value: (text) => theme.fg("success", text),
          detail: (text) => theme.fg("dim", text),
          empty: (text) => theme.fg("dim", text),
        })
      : message.content;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  });

  const queueSave = () => {
    saveQueue = saveQueue
      .then(async () => {
        stats.updatedAt = new Date().toISOString();
        await saveStats(statsPath, stats);
      })
      .catch((err) => {
        console.warn(`[token-usage] Failed to persist stats: ${String(err)}`);
      });
  };

  pi.on("session_start", async () => {
    stats = await loadStats(statsPath);
  });

  pi.on("message_end", async (event) => {
    const message = event.message as {
      role?: string;
      usage?: Usage;
      provider?: string;
      model?: string;
    };

    if (message.role !== "assistant" || !message.usage) return;

    const provider = message.provider ?? "unknown";
    const model = message.model ?? "unknown";
    const modelKey = `${provider}/${model}`;

    addUsage(stats.totals, message.usage);
    if (!stats.byProvider[provider]) stats.byProvider[provider] = zeroBucket();
    if (!stats.byModel[modelKey]) stats.byModel[modelKey] = zeroBucket();
    addUsage(stats.byProvider[provider], message.usage);
    addUsage(stats.byModel[modelKey], message.usage);

    queueSave();
  });

  pi.registerCommand("usage", {
    description: "Show persistent token/cost usage stats. Use this instead of a status bar widget. Args: reset | path",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();

      if (cmd === "path") {
        ctx.ui.notify(statsPath, "info");
        return;
      }

      if (cmd === "reset") {
        const confirmed = await ctx.ui.confirm(
          "Reset token usage stats?",
          `This clears all accumulated usage totals.\n\n${statsPath}`,
        );
        if (!confirmed) return;

        stats = zeroStats();
        queueSave();
        ctx.ui.notify("Token usage stats reset", "info");
        return;
      }

      const details = buildReportDetails(stats, statsPath);
      pi.sendMessage({
        customType: "token-usage",
        content: renderReport(details),
        display: true,
        details,
      });
    },
  });
}
