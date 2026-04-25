# Agents

A collection of agent skills, subagents, and general coding agent settings that I've made or found useful.

## Pi OTel metrics/traces extension

`extensions/otel-metrics.ts` exports process-local cumulative OpenTelemetry metrics and spans from Pi extension events. It defaults to OTLP/HTTP at `http://localhost:14318/v1/metrics` for metrics and `http://localhost:14318/v1/traces` for traces, and can be pointed elsewhere with environment variables.

Common setup:

```bash
# Send straight to an OTel Collector or any OTLP/HTTP metrics endpoint
export PI_OTEL_METRICS_ENDPOINT=http://localhost:14318/v1/metrics

# Or capture locally while testing
export PI_OTEL_METRICS_EXPORTER=file
export PI_OTEL_METRICS_FILE=.tmp/pi-otel-metrics.jsonl

pi -e ./extensions/otel-metrics.ts
```

Config knobs:

- `PI_OTEL_METRICS_EXPORTER=otlp|console|file|off` (default `otlp`)
- `PI_OTEL_METRICS_ENDPOINT` (default `http://localhost:14318/v1/metrics`)
- `PI_OTEL_METRICS_HEADERS` as JSON, e.g. `{"Authorization":"Bearer ..."}`
- `PI_OTEL_METRICS_INTERVAL_MS` (default `15000`)
- `PI_OTEL_METRICS_SERVICE_NAME` (default `pi-coding-agent`)
- `PI_OTEL_METRICS_SERVICE_VERSION` (default `unknown`)
- `PI_OTEL_METRICS_FILE` for the file exporter
- `PI_OTEL_METRICS_DEBUG=1` to log export failures
- `PI_OTEL_TRACES_EXPORTER=otlp|console|file|off` (default `otlp`)
- `PI_OTEL_TRACES_ENDPOINT` (default `http://localhost:14318/v1/traces`)
- `PI_OTEL_TRACES_HEADERS` as JSON, e.g. `{"Authorization":"Bearer ..."}`
- `PI_OTEL_TRACES_INTERVAL_MS` (default `15000`)
- `PI_OTEL_TRACES_SERVICE_NAME` (default falls back to the metrics service name)
- `PI_OTEL_TRACES_SERVICE_VERSION` (default falls back to the metrics service version)
- `PI_OTEL_TRACES_FILE` for the file exporter
- `PI_OTEL_TRACES_DEBUG=1` to log export failures

Interactive command: `/otel-metrics status | flush | reset | config`.

Telemetry emitted includes:
- `pi.prompt.chars` and `pi.response.chars` histograms (unit `{character}`)
- turn span attributes `prompt_chars` and `response_chars`
- resource attribute `pi.project` (derived from `cwd` basename)
- `extension` attribute where event context includes an originating extension

### Local observability stack (Nix run target)

A local Prometheus + Grafana + Tempo stack is included and runs natively via Nix.

```bash
# Starts: prometheus, tempo, grafana
nix run .#observability
```

Point Pi traces at Tempo's OTLP/HTTP receiver (matches the extension's default port):

```bash
export PI_OTEL_TRACES_ENDPOINT=http://localhost:14318/v1/traces
pi -e ./extensions/otel-metrics.ts
```

Open:

- Grafana: `http://localhost:13000` (default user/password `admin`/`admin`)
- Prometheus: `http://localhost:19090`
- Tempo: `http://localhost:13200`

The `Pi / Pi Usage` and `Pi / Pi Traces` dashboards are provisioned automatically in Grafana.

Port/user overrides are available via env vars before `nix run`:

```bash
PI_OTEL_OTLP_HTTP_PORT=24318 \
PI_OTEL_OTLP_GRPC_PORT=24317 \
PI_PROMETHEUS_PORT=29090 \
PI_PROMETHEUS_SCRAPE_TARGET=localhost:9101 \
PI_GRAFANA_PORT=23000 \
PI_GRAFANA_USER=admin \
PI_GRAFANA_PASSWORD=admin \
PI_TEMPO_PORT=23200 \
  nix run .#observability
```
