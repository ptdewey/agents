import os from "node:os";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Usage } from "@mariozechner/pi-ai";

type OTelAttr = { key: string; value: { stringValue: string } };
type OTelDataPoint = {
	attributes: OTelAttr[];
	startTimeUnixNano: string;
	timeUnixNano: string;
	asDouble: number;
};

type OTelMetric = {
	name: string;
	description: string;
	unit: string;
	sum: {
		aggregationTemporality: 1;
		isMonotonic: true;
		dataPoints: OTelDataPoint[];
	};
};

const ENABLED = process.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1";
const EXPORTER = process.env.OTEL_METRICS_EXPORTER;
const PROTOCOL = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const RAW_HEADERS = process.env.OTEL_EXPORTER_OTLP_HEADERS;
const DEBUG = process.env.DEBUG_TELEMETRY === "1";

// Keep these aligned with captured Claude Code payloads.
const SERVICE_NAME = "claude-code";
const SERVICE_VERSION = process.env.CLAUDE_CODE_VERSION ?? process.env.PI_VERSION ?? "pi-extension";
const SCOPE_NAME = "com.anthropic.claude_code";

const stringAttr = (key: string, value: string): OTelAttr => ({ key, value: { stringValue: value } });

const nowUnixNanoString = (): string => `${Date.now()}000000`;

const parseOtelHeaders = (raw: string | undefined): Record<string, string> => {
	if (!raw) return {};
	const headers: Record<string, string> = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const idx = trimmed.indexOf("=");
		if (idx <= 0) continue;
		const key = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim();
		if (key && value) headers[key] = value;
	}
	return headers;
};

const metric = (name: string, description: string, unit: string, dataPoints: OTelDataPoint[]): OTelMetric => ({
	name,
	description,
	unit,
	sum: {
		aggregationTemporality: 1,
		isMonotonic: true,
		dataPoints,
	},
});

const buildIdentityAttrs = (sessionId: string): OTelAttr[] => {
	const attrs: OTelAttr[] = [stringAttr("session.id", sessionId)];

	const fromEnv: Array<[string, string | undefined]> = [
		["user.id", process.env.JELLYFISH_USER_ID],
		["organization.id", process.env.JELLYFISH_ORGANIZATION_ID],
		["user.email", process.env.JELLYFISH_USER_EMAIL],
		["user.account_uuid", process.env.JELLYFISH_USER_ACCOUNT_UUID],
		["user.account_id", process.env.JELLYFISH_USER_ACCOUNT_ID],
	];

	for (const [key, value] of fromEnv) {
		if (value) attrs.push(stringAttr(key, value));
	}

	const terminalType = process.env.TMUX ? "tmux" : "cli";
	attrs.push(stringAttr("terminal.type", terminalType));

	return attrs;
};

export default function jellyfishOtelExtension(pi: ExtensionAPI) {
	if (!ENABLED || EXPORTER !== "otlp" || PROTOCOL !== "http/json" || !ENDPOINT) {
		return;
	}

	let sessionId = randomUUID();
	let sessionStartNs = nowUnixNanoString();
	let activeTurnStartNs: string | undefined;

	const resourceAttrs: OTelAttr[] = [
		stringAttr("host.arch", os.arch()),
		stringAttr("os.type", os.platform()),
		stringAttr("os.version", os.release()),
		stringAttr("service.name", SERVICE_NAME),
		stringAttr("service.version", SERVICE_VERSION),
	];

	const baseHeaders = {
		"Content-Type": "application/json",
		Accept: "*/*",
		"User-Agent": "OTel-OTLP-Exporter-JavaScript/0.208.0",
		...parseOtelHeaders(RAW_HEADERS),
	};

	const sendMetrics = async (metrics: OTelMetric[]) => {
		const payload = {
			resourceMetrics: [
				{
					resource: {
						attributes: resourceAttrs,
						droppedAttributesCount: 0,
					},
					scopeMetrics: [
						{
							scope: {
								name: SCOPE_NAME,
								version: SERVICE_VERSION,
							},
							metrics,
						},
					],
				},
			],
		};

		try {
			await fetch(ENDPOINT, {
				method: "POST",
				headers: baseHeaders,
				body: JSON.stringify(payload),
			});
			if (DEBUG) console.log(`[jellyfish-otel] sent ${metrics.length} metric(s)`);
		} catch (err) {
			console.warn(`[jellyfish-otel] export failed: ${String(err)}`);
		}
	};

	const dp = (value: number, attrs: OTelAttr[], startNs: string, nowNs: string): OTelDataPoint => ({
		attributes: attrs,
		startTimeUnixNano: startNs,
		timeUnixNano: nowNs,
		asDouble: value,
	});

	pi.on("session_start", () => {
		sessionId = randomUUID();
		sessionStartNs = nowUnixNanoString();
		activeTurnStartNs = undefined;
	});

	pi.on("before_agent_start", () => {
		activeTurnStartNs = nowUnixNanoString();
	});

	pi.on("agent_end", async () => {
		if (!activeTurnStartNs) return;
		const nowNs = nowUnixNanoString();
		const activeSeconds = Math.max(0, (Number(nowNs) - Number(activeTurnStartNs)) / 1_000_000_000);

		const attrs = [...buildIdentityAttrs(sessionId), stringAttr("type", "user")];
		await sendMetrics([
			metric(
				"claude_code.active_time.total",
				"Total active time in seconds",
				"s",
				[dp(activeSeconds, attrs, activeTurnStartNs, nowNs)],
			),
		]);
		activeTurnStartNs = undefined;
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as {
			role?: string;
			usage?: Usage;
			model?: string;
			provider?: string;
		};

		if (msg.role !== "assistant" || !msg.usage) return;

		const usage = msg.usage;
		const nowNs = nowUnixNanoString();
		const model = msg.model ?? "unknown";
		// Claude Code exports "query_source=main" for normal assistant turns.
		// Keep this exact to match Jellyfish's expected dimensions.
		const querySource = "main";

		const base = [
			...buildIdentityAttrs(sessionId),
			stringAttr("model", model),
			stringAttr("query_source", querySource),
		];

		const costMetric = metric("claude_code.cost.usage", "Cost of the Claude Code session", "USD", [
			dp(usage.cost?.total ?? 0, base, sessionStartNs, nowNs),
		]);

		const tokenMetric = metric("claude_code.token.usage", "Number of tokens used", "tokens", [
			dp(usage.input ?? 0, [...base, stringAttr("type", "input")], sessionStartNs, nowNs),
			dp(usage.output ?? 0, [...base, stringAttr("type", "output")], sessionStartNs, nowNs),
			dp(usage.cacheRead ?? 0, [...base, stringAttr("type", "cacheRead")], sessionStartNs, nowNs),
			dp(usage.cacheWrite ?? 0, [...base, stringAttr("type", "cacheCreation")], sessionStartNs, nowNs),
		]);

		await sendMetrics([costMetric, tokenMetric]);
	});

	pi.registerCommand("jellyfish-telemetry", {
		description: "Show Jellyfish OTEL exporter status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`enabled=${ENABLED} endpoint=${ENDPOINT ?? "(none)"} session=${sessionId.slice(0, 8)}…`,
				"info",
			);
		},
	});
}
