# Agents

A collection of agent skills, subagents, and general coding agent settings that I've made or found useful.

## Pi OTel metrics extension

`extensions/otel-metrics.ts` exports process-local cumulative OpenTelemetry metrics from Pi extension events. It defaults to OTLP/HTTP at `http://localhost:4318/v1/metrics` and can be pointed elsewhere with environment variables.

Common setup:

```bash
# Send straight to an OTel Collector or any OTLP/HTTP metrics endpoint
export PI_OTEL_METRICS_ENDPOINT=http://localhost:4318/v1/metrics

# Or capture locally while testing
export PI_OTEL_METRICS_EXPORTER=file
export PI_OTEL_METRICS_FILE=.tmp/pi-otel-metrics.jsonl

pi -e ./extensions/otel-metrics.ts
```

Config knobs:

- `PI_OTEL_METRICS_EXPORTER=otlp|console|file|off` (default `otlp`)
- `PI_OTEL_METRICS_ENDPOINT` (default `http://localhost:4318/v1/metrics`)
- `PI_OTEL_METRICS_HEADERS` as JSON, e.g. `{"Authorization":"Bearer ..."}`
- `PI_OTEL_METRICS_INTERVAL_MS` (default `15000`)
- `PI_OTEL_METRICS_SERVICE_NAME` (default `pi-coding-agent`)
- `PI_OTEL_METRICS_SERVICE_VERSION` (default `unknown`)
- `PI_OTEL_METRICS_FILE` for the file exporter
- `PI_OTEL_METRICS_DEBUG=1` to log export failures

Interactive command: `/otel-metrics status | flush | reset | config`.

### Local collector

A small local collector setup is included for smoke testing:

```bash
# Defaults use high host ports to avoid colliding with a local Tempo on 4317/4318.
docker compose -f otel-collector-compose.yml up

# Point Pi at the collector's OTLP/HTTP host port.
export PI_OTEL_METRICS_ENDPOINT=http://localhost:14318/v1/metrics
pi -e ./extensions/otel-metrics.ts
```

Adjust host ports with env vars if needed:

```bash
PI_OTEL_COLLECTOR_HTTP_PORT=24318 \
PI_OTEL_COLLECTOR_GRPC_PORT=24317 \
PI_OTEL_COLLECTOR_PROM_PORT=29464 \
  docker compose -f otel-collector-compose.yml up

export PI_OTEL_METRICS_ENDPOINT=http://localhost:24318/v1/metrics
```

The collector logs received telemetry and exposes collected metrics in Prometheus format at `http://localhost:19464/metrics` by default.
