import type { Usage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Pi OpenTelemetry metrics extension.
 *
 * Configure with environment variables:
 * - PI_OTEL_METRICS_EXPORTER=otlp|console|file|off (default: otlp)
 * - PI_OTEL_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
 * - PI_OTEL_METRICS_HEADERS='{"Authorization":"Bearer ..."}'
 * - PI_OTEL_METRICS_INTERVAL_MS=15000
 * - PI_OTEL_METRICS_SERVICE_NAME=pi-coding-agent
 * - PI_OTEL_METRICS_FILE=~/.pi/agent/otel-metrics.jsonl (for exporter=file)
 * - PI_OTEL_METRICS_DEBUG=1
 */

type Attributes = Record<string, string | number | boolean | undefined>;

type CounterPoint = {
  attributes: Record<string, string | number | boolean>;
  value: number;
};

type HistogramPoint = {
  attributes: Record<string, string | number | boolean>;
  count: number;
  sum: number;
  bucketCounts: number[];
};

type GaugePoint = {
  attributes: Record<string, string | number | boolean>;
  value: number;
};

type Config = {
  exporter: "otlp" | "console" | "file" | "off";
  endpoint: string;
  headers: Record<string, string>;
  intervalMs: number;
  serviceName: string;
  serviceVersion: string;
  file: string;
  debug: boolean;
};

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_FILE = join(homedir(), ".pi", "agent", "otel-metrics.jsonl");
const DEFAULT_HISTOGRAM_BOUNDS_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function nowSeconds(startMs: number): number {
  return Math.max(0, (Date.now() - startMs) / 1000);
}

function cleanAttributes(
  attributes: Attributes,
): Record<string, string | number | boolean> {
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function attributeKey(attributes: Attributes): string {
  const cleaned = cleanAttributes(attributes);
  return JSON.stringify(
    Object.entries(cleaned).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function otelAttributes(attributes: Record<string, string | number | boolean>) {
  return Object.entries(attributes).map(([key, value]) => {
    if (typeof value === "number")
      return { key, value: { doubleValue: value } };
    if (typeof value === "boolean") return { key, value: { boolValue: value } };
    return { key, value: { stringValue: value } };
  });
}

function envFlag(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    const headers: Record<string, string> = {};
    for (const part of raw.split(",")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      headers[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return headers;
  }
}

function loadConfig(): Config {
  const exporter = (
    process.env.PI_OTEL_METRICS_EXPORTER ?? "otlp"
  ).toLowerCase();
  return {
    exporter:
      exporter === "console" || exporter === "file" || exporter === "off"
        ? exporter
        : "otlp",
    endpoint: process.env.PI_OTEL_METRICS_ENDPOINT || DEFAULT_ENDPOINT,
    headers: parseHeaders(process.env.PI_OTEL_METRICS_HEADERS),
    intervalMs: envInt("PI_OTEL_METRICS_INTERVAL_MS", 15_000),
    serviceName: process.env.PI_OTEL_METRICS_SERVICE_NAME || "pi-coding-agent",
    serviceVersion: process.env.PI_OTEL_METRICS_SERVICE_VERSION || "unknown",
    file: expandPath(process.env.PI_OTEL_METRICS_FILE || DEFAULT_FILE),
    debug: envFlag("PI_OTEL_METRICS_DEBUG"),
  };
}

class MetricsStore {
  private readonly startTimeUnixNano = nowNs();
  private readonly counters = new Map<string, CounterPoint>();
  private readonly histograms = new Map<string, HistogramPoint>();
  private readonly gauges = new Map<string, GaugePoint>();

  addCounter(name: string, value = 1, attributes: Attributes = {}) {
    const key = `${name}:${attributeKey(attributes)}`;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.counters.set(key, { attributes: cleanAttributes(attributes), value });
  }

  recordHistogram(name: string, value: number, attributes: Attributes = {}) {
    const key = `${name}:${attributeKey(attributes)}`;
    let point = this.histograms.get(key);
    if (!point) {
      point = {
        attributes: cleanAttributes(attributes),
        count: 0,
        sum: 0,
        bucketCounts: Array(DEFAULT_HISTOGRAM_BOUNDS_SECONDS.length + 1).fill(
          0,
        ),
      };
      this.histograms.set(key, point);
    }

    point.count += 1;
    point.sum += value;
    const bucketIndex = DEFAULT_HISTOGRAM_BOUNDS_SECONDS.findIndex(
      (bound) => value <= bound,
    );
    point.bucketCounts[
      bucketIndex === -1 ? DEFAULT_HISTOGRAM_BOUNDS_SECONDS.length : bucketIndex
    ] += 1;
  }

  setGauge(name: string, value: number, attributes: Attributes = {}) {
    const key = `${name}:${attributeKey(attributes)}`;
    this.gauges.set(key, { attributes: cleanAttributes(attributes), value });
  }

  reset() {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  summary(): string {
    return [
      `counters=${this.counters.size}`,
      `histograms=${this.histograms.size}`,
      `gauges=${this.gauges.size}`,
    ].join(" ");
  }

  toOtlp(resourceAttributes: Attributes) {
    const timeUnixNano = nowNs();
    const metrics: any[] = [];

    const counterGroups = new Map<string, CounterPoint[]>();
    for (const [key, point] of this.counters) {
      const name = key.slice(0, key.indexOf(":"));
      const group = counterGroups.get(name) ?? [];
      group.push(point);
      counterGroups.set(name, group);
    }
    for (const [name, points] of counterGroups) {
      metrics.push({
        name,
        sum: {
          aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
          isMonotonic: true,
          dataPoints: points.map((point) => ({
            attributes: otelAttributes(point.attributes),
            startTimeUnixNano: this.startTimeUnixNano,
            timeUnixNano,
            asDouble: point.value,
          })),
        },
      });
    }

    const histogramGroups = new Map<string, HistogramPoint[]>();
    for (const [key, point] of this.histograms) {
      const name = key.slice(0, key.indexOf(":"));
      const group = histogramGroups.get(name) ?? [];
      group.push(point);
      histogramGroups.set(name, group);
    }
    for (const [name, points] of histogramGroups) {
      metrics.push({
        name,
        unit: "s",
        histogram: {
          aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
          dataPoints: points.map((point) => ({
            attributes: otelAttributes(point.attributes),
            startTimeUnixNano: this.startTimeUnixNano,
            timeUnixNano,
            count: String(point.count),
            sum: point.sum,
            bucketCounts: point.bucketCounts.map(String),
            explicitBounds: DEFAULT_HISTOGRAM_BOUNDS_SECONDS,
          })),
        },
      });
    }

    const gaugeGroups = new Map<string, GaugePoint[]>();
    for (const [key, point] of this.gauges) {
      const name = key.slice(0, key.indexOf(":"));
      const group = gaugeGroups.get(name) ?? [];
      group.push(point);
      gaugeGroups.set(name, group);
    }
    for (const [name, points] of gaugeGroups) {
      metrics.push({
        name,
        gauge: {
          dataPoints: points.map((point) => ({
            attributes: otelAttributes(point.attributes),
            timeUnixNano,
            asDouble: point.value,
          })),
        },
      });
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: otelAttributes(cleanAttributes(resourceAttributes)),
          },
          scopeMetrics: [
            {
              scope: { name: "pi-otel-metrics-extension", version: "1" },
              metrics,
            },
          ],
        },
      ],
    };
  }
}

async function exportMetrics(config: Config, payload: unknown): Promise<void> {
  switch (config.exporter) {
    case "off":
      return;
    case "console":
      console.log(JSON.stringify(payload));
      return;
    case "file":
      await mkdir(dirname(config.file), { recursive: true });
      await writeFile(config.file, `${JSON.stringify(payload)}\n`, {
        flag: "a",
      });
      return;
    case "otlp": {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          `OTLP metrics export failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
    }
  }
}

function usageAttributes(
  usage: Usage,
  message: { provider?: string; model?: string },
) {
  return {
    provider: message.provider ?? "unknown",
    model: message.model ?? "unknown",
  };
}

function recordUsage(
  metrics: MetricsStore,
  usage: Usage,
  message: { provider?: string; model?: string },
) {
  const attrs = usageAttributes(usage, message);
  metrics.addCounter("pi.tokens", usage.input ?? 0, {
    ...attrs,
    type: "input",
  });
  metrics.addCounter("pi.tokens", usage.output ?? 0, {
    ...attrs,
    type: "output",
  });
  metrics.addCounter("pi.tokens", usage.cacheRead ?? 0, {
    ...attrs,
    type: "cache_read",
  });
  metrics.addCounter("pi.tokens", usage.cacheWrite ?? 0, {
    ...attrs,
    type: "cache_write",
  });
  metrics.addCounter("pi.tokens", usage.totalTokens ?? 0, {
    ...attrs,
    type: "total",
  });

  metrics.addCounter("pi.cost.usd", usage.cost?.input ?? 0, {
    ...attrs,
    type: "input",
  });
  metrics.addCounter("pi.cost.usd", usage.cost?.output ?? 0, {
    ...attrs,
    type: "output",
  });
  metrics.addCounter("pi.cost.usd", usage.cost?.cacheRead ?? 0, {
    ...attrs,
    type: "cache_read",
  });
  metrics.addCounter("pi.cost.usd", usage.cost?.cacheWrite ?? 0, {
    ...attrs,
    type: "cache_write",
  });
  metrics.addCounter("pi.cost.usd", usage.cost?.total ?? 0, {
    ...attrs,
    type: "total",
  });
}

function modelAttributes(ctx: ExtensionContext | undefined) {
  return {
    provider: ctx?.model?.provider ?? "unknown",
    model: ctx?.model?.id ?? "unknown",
  };
}

export default function otelMetricsExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const metrics = new MetricsStore();
  const toolStarts = new Map<string, number>();
  const turnStarts = new Map<number | string, number>();
  let agentStart: number | undefined;
  let flushInFlight: Promise<void> = Promise.resolve();
  let lastExportError: string | undefined;
  let cwd = process.cwd();
  let sessionId = "unknown";

  const resourceAttributes = () => ({
    "service.name": config.serviceName,
    "service.version": config.serviceVersion,
    "process.pid": process.pid,
    "pi.cwd": cwd,
    "pi.session.id": sessionId,
  });

  const flush = async (ctx?: ExtensionContext) => {
    if (config.exporter === "off") return;
    flushInFlight = flushInFlight
      .then(async () => {
        const payload = metrics.toOtlp(resourceAttributes());
        await exportMetrics(config, payload);
        lastExportError = undefined;
      })
      .catch((error) => {
        lastExportError =
          error instanceof Error ? error.message : String(error);
        if (config.debug) console.warn(`[otel-metrics] ${lastExportError}`);
      });
    await flushInFlight;
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  if (config.exporter !== "off") {
    interval = setInterval(() => void flush(), config.intervalMs);
    interval.unref?.();
  }

  pi.on("session_start", async (event, ctx) => {
    cwd = ctx.cwd;
    sessionId =
      ctx.sessionManager.getSessionId?.() ??
      ctx.sessionManager.getSessionFile?.() ??
      "unknown";
    metrics.addCounter("pi.session.starts", 1, { reason: event.reason });
    metrics.setGauge("pi.up", 1);
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentStart = Date.now();
    metrics.addCounter("pi.agent.starts", 1, modelAttributes(ctx));
  });

  pi.on("agent_end", async (_event, ctx) => {
    metrics.addCounter("pi.agent.runs", 1, {
      ...modelAttributes(ctx),
      status: "ok",
    });
    if (agentStart !== undefined) {
      metrics.recordHistogram(
        "pi.agent.duration",
        nowSeconds(agentStart),
        modelAttributes(ctx),
      );
      agentStart = undefined;
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    const key = event.turnIndex ?? turnStarts.size;
    turnStarts.set(key, Date.now());
    metrics.addCounter("pi.turn.starts", 1, modelAttributes(ctx));
  });

  pi.on("turn_end", async (event, ctx) => {
    const key =
      event.turnIndex ?? Array.from(turnStarts.keys()).at(-1) ?? "unknown";
    const start = turnStarts.get(key);
    if (start !== undefined) {
      metrics.recordHistogram(
        "pi.turn.duration",
        nowSeconds(start),
        modelAttributes(ctx),
      );
      turnStarts.delete(key);
    }
    metrics.addCounter("pi.turns", 1, modelAttributes(ctx));
  });

  pi.on("message_end", async (event) => {
    const message = event.message as {
      role?: string;
      usage?: Usage;
      provider?: string;
      model?: string;
      stopReason?: string;
    };

    metrics.addCounter("pi.messages", 1, {
      role: message.role ?? "unknown",
      provider: message.provider,
      model: message.model,
      stop_reason: message.stopReason,
    });

    if (message.role === "assistant" && message.usage) {
      recordUsage(metrics, message.usage, message);
    }
  });

  pi.on("tool_execution_start", async (event) => {
    toolStarts.set(event.toolCallId, Date.now());
    metrics.addCounter("pi.tool.starts", 1, { tool: event.toolName });
  });

  pi.on("tool_execution_end", async (event) => {
    const status = event.isError ? "error" : "ok";
    metrics.addCounter("pi.tool.executions", 1, {
      tool: event.toolName,
      status,
    });
    const start = toolStarts.get(event.toolCallId);
    if (start !== undefined) {
      metrics.recordHistogram("pi.tool.duration", nowSeconds(start), {
        tool: event.toolName,
        status,
      });
      toolStarts.delete(event.toolCallId);
    }
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    metrics.addCounter("pi.provider.requests", 1, modelAttributes(ctx));
  });

  pi.on("after_provider_response", async (event, ctx) => {
    metrics.addCounter("pi.provider.responses", 1, {
      ...modelAttributes(ctx),
      status_code: event.status,
    });
  });

  pi.on("session_before_compact", async () => {
    metrics.addCounter("pi.compaction.starts", 1);
  });

  pi.on("session_compact", async (event) => {
    metrics.addCounter("pi.compactions", 1, {
      from_extension: event.fromExtension,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    metrics.setGauge("pi.up", 0);
    if (interval) clearInterval(interval);
    await flush(ctx);
  });

  pi.registerCommand("otel-metrics", {
    description:
      "Show or control OTel metrics exporter. Args: status | flush | reset | config",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "flush") {
        await flush(ctx);
        ctx.ui.notify(
          lastExportError
            ? `OTel metrics flush failed: ${lastExportError}`
            : "OTel metrics flushed",
          lastExportError ? "error" : "info",
        );
        return;
      }
      if (command === "reset") {
        metrics.reset();
        ctx.ui.notify(
          "OTel metrics counters reset for this pi process",
          "info",
        );
        return;
      }
      if (command === "config") {
        pi.sendMessage({
          customType: "otel-metrics",
          display: true,
          content: [
            "OTel metrics configuration",
            `exporter=${config.exporter}`,
            `endpoint=${config.endpoint}`,
            `intervalMs=${config.intervalMs}`,
            `serviceName=${config.serviceName}`,
            `serviceVersion=${config.serviceVersion}`,
            `file=${config.file}`,
            `headers=${Object.keys(config.headers).length ? Object.keys(config.headers).join(",") : "(none)"}`,
            "",
            "Change destination with env vars, e.g.:",
            "PI_OTEL_METRICS_ENDPOINT=http://collector:4318/v1/metrics",
            "PI_OTEL_METRICS_EXPORTER=file PI_OTEL_METRICS_FILE=.tmp/pi-metrics.jsonl",
          ].join("\n"),
        });
        return;
      }

      pi.sendMessage({
        customType: "otel-metrics",
        display: true,
        content: [
          "OTel metrics status",
          metrics.summary(),
          `exporter=${config.exporter}`,
          `target=${config.exporter === "otlp" ? config.endpoint : config.exporter === "file" ? config.file : config.exporter}`,
          `lastError=${lastExportError ?? "(none)"}`,
          "",
          "Commands: /otel-metrics status | flush | reset | config",
        ].join("\n"),
      });
    },
  });
}
