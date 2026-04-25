import type { Usage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Pi OpenTelemetry metrics/traces extension.
 *
 * Configure with environment variables:
 * - PI_OTEL_METRICS_EXPORTER=otlp|console|file|off (default: otlp)
 * - PI_OTEL_METRICS_ENDPOINT=http://localhost:14318/v1/metrics
 * - PI_OTEL_METRICS_HEADERS='{"Authorization":"Bearer ..."}'
 * - PI_OTEL_METRICS_INTERVAL_MS=15000
 * - PI_OTEL_METRICS_SERVICE_NAME=pi-coding-agent
 * - PI_OTEL_METRICS_FILE=~/.pi/agent/otel-metrics.jsonl (for exporter=file)
 * - PI_OTEL_METRICS_DEBUG=1
 * - PI_OTEL_TRACES_EXPORTER=otlp|console|file|off (default: otlp)
 * - PI_OTEL_TRACES_ENDPOINT=http://localhost:14318/v1/traces
 * - PI_OTEL_TRACES_HEADERS='{"Authorization":"Bearer ..."}'
 * - PI_OTEL_TRACES_INTERVAL_MS=15000
 * - PI_OTEL_TRACES_SERVICE_NAME=pi-coding-agent
 * - PI_OTEL_TRACES_FILE=~/.pi/agent/otel-traces.jsonl (for exporter=file)
 * - PI_OTEL_TRACES_DEBUG=1
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
  unit: string;
};

type GaugePoint = {
  attributes: Record<string, string | number | boolean>;
  value: number;
};

type SpanKind = "SPAN_KIND_INTERNAL" | "SPAN_KIND_CLIENT";

type TraceEvent = {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
};

type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
  events: TraceEvent[];
  status?: {
    code: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR";
    message?: string;
  };
};

type TraceConfig = {
  exporter: "otlp" | "console" | "file" | "off";
  endpoint: string;
  headers: Record<string, string>;
  intervalMs: number;
  serviceName: string;
  serviceVersion: string;
  file: string;
  debug: boolean;
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

const DEFAULT_ENDPOINT = "http://localhost:14318/v1/metrics";
const DEFAULT_FILE = join(homedir(), ".pi", "agent", "otel-metrics.jsonl");
const DEFAULT_TRACE_ENDPOINT = "http://localhost:14318/v1/traces";
const DEFAULT_TRACE_FILE = join(homedir(), ".pi", "agent", "otel-traces.jsonl");
const DEFAULT_HISTOGRAM_BOUNDS_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowSeconds(startMs: number): number {
  return Math.max(0, (Date.now() - startMs) / 1000);
}

function projectNameFromCwd(cwd: string): string {
  const name = basename(cwd);
  return name || cwd || "unknown";
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + contentChars(part), 0);
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.length;
    if ("content" in record) return contentChars(record.content);
    if ("parts" in record) return contentChars(record.parts);
  }
  return 0;
}

function messageChars(message: { content?: unknown; text?: unknown }): number {
  if (message.content !== undefined) return contentChars(message.content);
  if (message.text !== undefined) return contentChars(message.text);
  return 0;
}

function extensionAttribute(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
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

function loadTraceConfig(): TraceConfig {
  const exporter = (
    process.env.PI_OTEL_TRACES_EXPORTER ?? "otlp"
  ).toLowerCase();
  return {
    exporter:
      exporter === "console" || exporter === "file" || exporter === "off"
        ? exporter
        : "otlp",
    endpoint: process.env.PI_OTEL_TRACES_ENDPOINT || DEFAULT_TRACE_ENDPOINT,
    headers: parseHeaders(process.env.PI_OTEL_TRACES_HEADERS),
    intervalMs: envInt("PI_OTEL_TRACES_INTERVAL_MS", 15_000),
    serviceName:
      process.env.PI_OTEL_TRACES_SERVICE_NAME ||
      process.env.PI_OTEL_METRICS_SERVICE_NAME ||
      "pi-coding-agent",
    serviceVersion:
      process.env.PI_OTEL_TRACES_SERVICE_VERSION ||
      process.env.PI_OTEL_METRICS_SERVICE_VERSION ||
      "unknown",
    file: expandPath(process.env.PI_OTEL_TRACES_FILE || DEFAULT_TRACE_FILE),
    debug: envFlag("PI_OTEL_TRACES_DEBUG"),
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

  recordHistogram(
    name: string,
    value: number,
    attributes: Attributes = {},
    unit = "1",
  ) {
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
        unit,
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

    const histogramGroups = new Map<
      string,
      { points: HistogramPoint[]; unit: string }
    >();
    for (const [key, point] of this.histograms) {
      const name = key.slice(0, key.indexOf(":"));
      const existing = histogramGroups.get(name);
      if (existing) {
        existing.points.push(point);
      } else {
        histogramGroups.set(name, { points: [point], unit: point.unit });
      }
    }
    for (const [name, group] of histogramGroups) {
      metrics.push({
        name,
        unit: group.unit,
        histogram: {
          aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
          dataPoints: group.points.map((point) => ({
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

class TraceStore {
  private readonly active = new Map<string, TraceSpan>();
  private finished: TraceSpan[] = [];

  start(key: string, span: TraceSpan) {
    const existing = this.active.get(key);
    if (existing) {
      this.end(key, {}, {
        code: "STATUS_CODE_ERROR",
        message: "replaced without end",
      });
    }
    this.active.set(key, { ...span, events: span.events ?? [] });
  }

  addEvent(key: string, name: string, attributes: Attributes = {}) {
    const span = this.active.get(key);
    if (!span) return;
    span.events.push({
      name,
      timeUnixNano: nowNs(),
      attributes: cleanAttributes(attributes),
    });
  }

  end(
    key: string,
    attributes: Attributes = {},
    status?: TraceSpan["status"],
  ) {
    const span = this.active.get(key);
    if (!span) return;
    span.attributes = {
      ...span.attributes,
      ...cleanAttributes(attributes),
    };
    if (status) span.status = status;
    span.endTimeUnixNano = nowNs();
    this.active.delete(key);
    this.finished.push(span);
  }

  drain(): TraceSpan[] {
    const spans = this.finished;
    this.finished = [];
    return spans;
  }

  reset() {
    this.active.clear();
    this.finished = [];
  }
}

function traceSpansToOtlp(resourceAttributes: Attributes, spans: TraceSpan[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otelAttributes(cleanAttributes(resourceAttributes)),
        },
        scopeSpans: [
          {
            scope: { name: "pi-otel-traces-extension", version: "1" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano ?? nowNs(),
              attributes: otelAttributes(span.attributes),
              status: span.status,
              events: span.events.map((event) => ({
                timeUnixNano: event.timeUnixNano,
                name: event.name,
                attributes: otelAttributes(event.attributes),
              })),
            })),
          },
        ],
      },
    ],
  };
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

async function exportTraces(config: TraceConfig, payload: unknown): Promise<void> {
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
          `OTLP traces export failed: HTTP ${response.status} ${response.statusText}`,
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
  const traceConfig = loadTraceConfig();
  const metrics = new MetricsStore();
  const traces = new TraceStore();
  const toolStarts = new Map<string, number>();
  const turnStarts = new Map<number | string, number>();
  let agentStart: number | undefined;
  let flushInFlight: Promise<void> = Promise.resolve();
  let lastMetricsExportError: string | undefined;
  let lastTraceExportError: string | undefined;
  let pendingTraceSpans: TraceSpan[] = [];
  let cwd = process.cwd();
  let sessionId = "unknown";
  let sessionTraceId: string | undefined;
  let sessionSpanId: string | undefined;
  let agentSpanId: string | undefined;
  let turnSpanId: string | undefined;
  let turnSpanKey: string | undefined;
  let currentTurnPromptChars = 0;
  let currentTurnResponseChars = 0;
  const providerSpanKeys: string[] = [];
  const compactionSpanKeys: string[] = [];

  const resourceAttributes = () => ({
    "service.name": config.serviceName,
    "service.version": config.serviceVersion,
    "process.pid": process.pid,
    "pi.cwd": cwd,
    "pi.project": projectNameFromCwd(cwd),
    "pi.session.id": sessionId,
  });

  const currentTraceId = () => sessionTraceId ?? randomHex(16);
  const currentParentSpanId = () => turnSpanId ?? agentSpanId ?? sessionSpanId;

  const startTraceSpan = (
    key: string,
    name: string,
    kind: SpanKind,
    attributes: Attributes = {},
    parentSpanId: string | undefined = currentParentSpanId(),
    traceId: string = currentTraceId(),
  ) => {
    const spanId = randomHex(8);
    traces.start(key, {
      traceId,
      spanId,
      parentSpanId,
      name,
      kind,
      startTimeUnixNano: nowNs(),
      attributes: cleanAttributes(attributes),
      events: [],
    });
    return spanId;
  };

  const endTraceSpan = (
    key: string | undefined,
    attributes: Attributes = {},
    status?: TraceSpan["status"],
  ) => {
    if (!key) return;
    traces.end(key, attributes, status);
  };

  const flush = async (_ctx?: ExtensionContext) => {
    if (config.exporter === "off" && traceConfig.exporter === "off") return;
    flushInFlight = flushInFlight.then(async () => {
      if (config.exporter !== "off") {
        try {
          const payload = metrics.toOtlp(resourceAttributes());
          await exportMetrics(config, payload);
          lastMetricsExportError = undefined;
        } catch (error) {
          lastMetricsExportError =
            error instanceof Error ? error.message : String(error);
          if (config.debug) {
            console.warn(`[otel-metrics] ${lastMetricsExportError}`);
          }
        }
      }

      if (traceConfig.exporter !== "off") {
        const drained = traces.drain();
        const spans = [...pendingTraceSpans, ...drained];
        pendingTraceSpans = [];
        if (spans.length) {
          try {
            await exportTraces(
              traceConfig,
              traceSpansToOtlp(resourceAttributes(), spans),
            );
            lastTraceExportError = undefined;
          } catch (error) {
            lastTraceExportError =
              error instanceof Error ? error.message : String(error);
            pendingTraceSpans = spans;
            if (traceConfig.debug) {
              console.warn(`[otel-traces] ${lastTraceExportError}`);
            }
          }
        }
      }
    });
    await flushInFlight;
  };

  const closeOpenTraces = (
    status: TraceSpan["status"] = { code: "STATUS_CODE_OK" },
  ) => {
    for (const toolCallId of Array.from(toolStarts.keys()).reverse()) {
      endTraceSpan(`tool:${toolCallId}`, {}, status);
      toolStarts.delete(toolCallId);
    }
    while (providerSpanKeys.length) {
      endTraceSpan(providerSpanKeys.pop(), {}, status);
    }
    while (compactionSpanKeys.length) {
      endTraceSpan(compactionSpanKeys.pop(), {}, status);
    }
    endTraceSpan(turnSpanKey, {}, status);
    turnSpanKey = undefined;
    turnSpanId = undefined;
    turnStarts.clear();
    currentTurnPromptChars = 0;
    currentTurnResponseChars = 0;
    agentStart = undefined;
    endTraceSpan(agentSpanId ? "agent" : undefined, {}, status);
    agentSpanId = undefined;
    endTraceSpan(sessionSpanId ? "session" : undefined, {}, status);
    sessionSpanId = undefined;
    sessionTraceId = undefined;
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  if (config.exporter !== "off" || traceConfig.exporter !== "off") {
    interval = setInterval(() => void flush(), Math.min(config.intervalMs, traceConfig.intervalMs));
    interval.unref?.();
  }

  pi.on("session_start", async (event, ctx) => {
    closeOpenTraces({ code: "STATUS_CODE_ERROR", message: "new session started" });
    await flush(ctx);
    cwd = ctx.cwd;
    sessionId =
      ctx.sessionManager.getSessionId?.() ??
      ctx.sessionManager.getSessionFile?.() ??
      "unknown";
    sessionTraceId = randomHex(16);
    sessionSpanId = startTraceSpan(
      "session",
      "pi session",
      "SPAN_KIND_INTERNAL",
      {
        reason: event.reason,
        cwd: ctx.cwd,
        session_id: sessionId,
      },
      undefined,
      sessionTraceId,
    );
    metrics.addCounter("pi.session.starts", 1, { reason: event.reason });
    metrics.setGauge("pi.up", 1);
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentStart = Date.now();
    metrics.addCounter("pi.agent.starts", 1, modelAttributes(ctx));
    agentSpanId = startTraceSpan(
      "agent",
      "pi agent run",
      "SPAN_KIND_INTERNAL",
      modelAttributes(ctx),
    );
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
        "s",
      );
      agentStart = undefined;
    }
    endTraceSpan(
      "agent",
      {
        ...modelAttributes(ctx),
        status: "ok",
      },
      { code: "STATUS_CODE_OK" },
    );
    agentSpanId = undefined;
  });

  pi.on("turn_start", async (event, ctx) => {
    const key = event.turnIndex ?? turnStarts.size;
    turnStarts.set(key, Date.now());
    metrics.addCounter("pi.turn.starts", 1, modelAttributes(ctx));
    currentTurnPromptChars = 0;
    currentTurnResponseChars = 0;
    turnSpanKey = `turn:${String(key)}`;
    turnSpanId = startTraceSpan(
      turnSpanKey,
      "pi turn",
      "SPAN_KIND_INTERNAL",
      modelAttributes(ctx),
    );
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
        "s",
      );
      turnStarts.delete(key);
    }
    metrics.addCounter("pi.turns", 1, modelAttributes(ctx));
    endTraceSpan(
      turnSpanKey,
      {
        ...modelAttributes(ctx),
        turn_index: String(key),
        prompt_chars: currentTurnPromptChars,
        response_chars: currentTurnResponseChars,
      },
      { code: "STATUS_CODE_OK" },
    );
    turnSpanKey = undefined;
    turnSpanId = undefined;
    currentTurnPromptChars = 0;
    currentTurnResponseChars = 0;
  });

  pi.on("message_end", async (event) => {
    const message = event.message as {
      role?: string;
      usage?: Usage;
      provider?: string;
      model?: string;
      stopReason?: string;
      content?: unknown;
      text?: unknown;
      fromExtension?: string;
    };

    const extension =
      extensionAttribute((event as { fromExtension?: unknown }).fromExtension) ??
      extensionAttribute(message.fromExtension);

    metrics.addCounter("pi.messages", 1, {
      role: message.role ?? "unknown",
      provider: message.provider,
      model: message.model,
      stop_reason: message.stopReason,
      extension,
    });

    const chars = messageChars(message);
    if (chars > 0) {
      const sizeAttributes = {
        role: message.role ?? "unknown",
        provider: message.provider,
        model: message.model,
        extension,
      };
      if (message.role === "assistant") {
        currentTurnResponseChars += chars;
        metrics.recordHistogram(
          "pi.response.chars",
          chars,
          sizeAttributes,
          "{character}",
        );
      } else {
        currentTurnPromptChars += chars;
        metrics.recordHistogram(
          "pi.prompt.chars",
          chars,
          sizeAttributes,
          "{character}",
        );
      }
    }

    if (message.role === "assistant" && message.usage) {
      recordUsage(metrics, message.usage, message);
    }
  });

  pi.on("tool_execution_start", async (event) => {
    toolStarts.set(event.toolCallId, Date.now());
    metrics.addCounter("pi.tool.starts", 1, { tool: event.toolName });
    const key = `tool:${event.toolCallId}`;
    startTraceSpan(key, "tool execution", "SPAN_KIND_CLIENT", {
      tool: event.toolName,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    const status = event.isError ? "error" : "ok";
    metrics.addCounter("pi.tool.executions", 1, {
      tool: event.toolName,
      status,
    });
    const start = toolStarts.get(event.toolCallId);
    if (start !== undefined) {
      metrics.recordHistogram(
        "pi.tool.duration",
        nowSeconds(start),
        {
          tool: event.toolName,
          status,
        },
        "s",
      );
      toolStarts.delete(event.toolCallId);
    }
    endTraceSpan(
      `tool:${event.toolCallId}`,
      {
        tool: event.toolName,
        status,
      },
      event.isError
        ? { code: "STATUS_CODE_ERROR", message: "tool execution failed" }
        : { code: "STATUS_CODE_OK" },
    );
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") {
      metrics.addCounter("pi.message.starts", 1, modelAttributes(ctx));
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role === "assistant" && event.assistantMessageEvent) {
      metrics.addCounter("pi.message.updates", 1, modelAttributes(ctx));
    }
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    metrics.addCounter("pi.provider.requests", 1, modelAttributes(ctx));
    const key = `provider:${randomHex(4)}`;
    providerSpanKeys.push(key);
    startTraceSpan(key, "provider request", "SPAN_KIND_CLIENT", modelAttributes(ctx));
  });

  pi.on("after_provider_response", async (event, ctx) => {
    metrics.addCounter("pi.provider.responses", 1, {
      ...modelAttributes(ctx),
      status_code: event.status,
    });
    const key = providerSpanKeys.pop();
    if (key) {
      endTraceSpan(
        key,
        {
          ...modelAttributes(ctx),
          status_code: event.status,
        },
        event.status >= 400
          ? { code: "STATUS_CODE_ERROR", message: `provider status ${event.status}` }
          : { code: "STATUS_CODE_OK" },
      );
    }
  });

  pi.on("session_before_compact", async () => {
    metrics.addCounter("pi.compaction.starts", 1);
    const key = `compaction:${randomHex(4)}`;
    compactionSpanKeys.push(key);
    startTraceSpan(key, "session compaction", "SPAN_KIND_INTERNAL");
  });

  pi.on("session_compact", async (event) => {
    const extension = extensionAttribute(event.fromExtension);
    metrics.addCounter("pi.compactions", 1, {
      from_extension: event.fromExtension,
      extension,
    });
    const key = compactionSpanKeys.pop();
    endTraceSpan(
      key,
      {
        from_extension: event.fromExtension,
        extension,
      },
      { code: "STATUS_CODE_OK" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    closeOpenTraces();
    metrics.setGauge("pi.up", 0);
    if (interval) clearInterval(interval);
    await flush(ctx);
  });

  pi.registerCommand("otel-metrics", {
    description:
      "Show or control OTel metrics/traces exporter. Args: status | flush | reset | config",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "flush") {
        await flush(ctx);
        const error = lastMetricsExportError ?? lastTraceExportError;
        ctx.ui.notify(
          error
            ? `OTel telemetry flush failed: ${error}`
            : "OTel telemetry flushed",
          error ? "error" : "info",
        );
        return;
      }
      if (command === "reset") {
        metrics.reset();
        traces.reset();
        pendingTraceSpans = [];
        toolStarts.clear();
        turnStarts.clear();
        currentTurnPromptChars = 0;
        currentTurnResponseChars = 0;
        agentStart = undefined;
        sessionTraceId = undefined;
        sessionSpanId = undefined;
        agentSpanId = undefined;
        turnSpanId = undefined;
        turnSpanKey = undefined;
        providerSpanKeys.length = 0;
        compactionSpanKeys.length = 0;
        ctx.ui.notify(
          "OTel telemetry state reset for this pi process",
          "info",
        );
        return;
      }
      if (command === "config") {
        pi.sendMessage({
          customType: "otel-metrics",
          display: true,
          content: [
            "OTel telemetry configuration",
            `metricsExporter=${config.exporter}`,
            `metricsEndpoint=${config.endpoint}`,
            `metricsIntervalMs=${config.intervalMs}`,
            `metricsServiceName=${config.serviceName}`,
            `metricsServiceVersion=${config.serviceVersion}`,
            `metricsFile=${config.file}`,
            `metricsHeaders=${Object.keys(config.headers).length ? Object.keys(config.headers).join(",") : "(none)"}`,
            "",
            `tracesExporter=${traceConfig.exporter}`,
            `tracesEndpoint=${traceConfig.endpoint}`,
            `tracesIntervalMs=${traceConfig.intervalMs}`,
            `tracesServiceName=${traceConfig.serviceName}`,
            `tracesServiceVersion=${traceConfig.serviceVersion}`,
            `tracesFile=${traceConfig.file}`,
            `tracesHeaders=${Object.keys(traceConfig.headers).length ? Object.keys(traceConfig.headers).join(",") : "(none)"}`,
            "",
            "Change destination with env vars, e.g.:",
            "PI_OTEL_METRICS_ENDPOINT=http://collector:4318/v1/metrics",
            "PI_OTEL_TRACES_ENDPOINT=http://collector:4318/v1/traces",
            "PI_OTEL_METRICS_EXPORTER=file PI_OTEL_METRICS_FILE=.tmp/pi-metrics.jsonl",
            "PI_OTEL_TRACES_EXPORTER=file PI_OTEL_TRACES_FILE=.tmp/pi-traces.jsonl",
          ].join("\n"),
        });
        return;
      }

      pi.sendMessage({
        customType: "otel-metrics",
        display: true,
        content: [
          "OTel telemetry status",
          metrics.summary(),
          `metricsExporter=${config.exporter}`,
          `metricsTarget=${config.exporter === "otlp" ? config.endpoint : config.exporter === "file" ? config.file : config.exporter}`,
          `metricsLastError=${lastMetricsExportError ?? "(none)"}`,
          `tracesExporter=${traceConfig.exporter}`,
          `tracesTarget=${traceConfig.exporter === "otlp" ? traceConfig.endpoint : traceConfig.exporter === "file" ? traceConfig.file : traceConfig.exporter}`,
          `tracesLastError=${lastTraceExportError ?? "(none)"}`,
          "",
          "Commands: /otel-metrics status | flush | reset | config",
        ].join("\n"),
      });
    },
  });
}
