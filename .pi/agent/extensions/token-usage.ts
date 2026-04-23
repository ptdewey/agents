import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Usage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

const formatBucketLine = (label: string, bucket: UsageBucket): string => {
  const avg = bucket.messages > 0 ? bucket.totalTokens / bucket.messages : 0;
  return [
    `${label}`,
    `  tokens=${fmtInt(bucket.totalTokens)} (in=${fmtInt(bucket.input)}, out=${fmtInt(bucket.output)}, cacheR=${fmtInt(bucket.cacheRead)}, cacheW=${fmtInt(bucket.cacheWrite)})`,
    `  cost=${fmtMoney(bucket.costTotal)} (in=${fmtMoney(bucket.costInput)}, out=${fmtMoney(bucket.costOutput)}, cacheR=${fmtMoney(bucket.costCacheRead)}, cacheW=${fmtMoney(bucket.costCacheWrite)})`,
    `  messages=${fmtInt(bucket.messages)}, avg_tokens/msg=${fmtInt(avg)}`,
  ].join("\n");
};

const sortedEntries = (
  obj: Record<string, UsageBucket>,
): Array<[string, UsageBucket]> =>
  Object.entries(obj).sort((a, b) => b[1].totalTokens - a[1].totalTokens);

const renderReport = (stats: StatsFile, path: string): string => {
  const providerLines = sortedEntries(stats.byProvider)
    .map(([provider, bucket]) => formatBucketLine(`- ${provider}`, bucket))
    .join("\n\n");

  const modelLines = sortedEntries(stats.byModel)
    .map(([key, bucket]) => formatBucketLine(`- ${key}`, bucket))
    .join("\n\n");

  return [
    "Token Usage Stats (persistent)",
    `File: ${path}`,
    `Updated: ${stats.updatedAt}`,
    "",
    formatBucketLine("TOTAL", stats.totals),
    "",
    "By provider:",
    providerLines || "(no data)",
    "",
    "By provider/model:",
    modelLines || "(no data)",
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

  const refreshStatus = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, text: string | undefined) => void };
  }) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "token-usage",
      `${fmtInt(stats.totals.totalTokens)} tok: ${fmtMoney(stats.totals.costTotal)}`,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    stats = await loadStats(statsPath);
    refreshStatus(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
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

    refreshStatus(ctx);
    queueSave();
  });

  pi.registerCommand("usage", {
    description: "Show persistent token/cost usage stats. Args: reset | path",
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
        refreshStatus(ctx);
        queueSave();
        ctx.ui.notify("Token usage stats reset", "info");
        return;
      }

      const report = renderReport(stats, statsPath);
      pi.sendMessage({
        customType: "token-usage",
        content: report,
        display: true,
      });
    },
  });
}
