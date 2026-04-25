{
  description = "Pi local observability stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f system);
    in {
      apps = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          observability = pkgs.writeShellApplication {
            name = "pi-observability";
            runtimeInputs = [
              pkgs.coreutils
              pkgs.grafana
              pkgs.opentelemetry-collector-contrib
              pkgs.prometheus
              pkgs.tempo
            ];
            text = ''
              set -euo pipefail

              OTLP_HTTP_PORT="''${PI_OTEL_OTLP_HTTP_PORT:-''${PI_OTEL_COLLECTOR_HTTP_PORT:-14318}}"
              OTLP_GRPC_PORT="''${PI_OTEL_OTLP_GRPC_PORT:-''${PI_OTEL_COLLECTOR_GRPC_PORT:-14317}}"
              COLLECTOR_PROM_PORT="''${PI_OTEL_COLLECTOR_PROM_PORT:-19464}"
              GRAFANA_PORT="''${PI_GRAFANA_PORT:-13000}"
              PROMETHEUS_PORT="''${PI_PROMETHEUS_PORT:-19090}"
              TEMPO_PORT="''${PI_TEMPO_PORT:-13200}"
              TEMPO_OTLP_GRPC_PORT="''${PI_TEMPO_OTLP_GRPC_PORT:-14327}"
              SCRAPE_TARGET="''${PI_PROMETHEUS_SCRAPE_TARGET:-localhost:9101}"

              if [ ! -d "$PWD/observability/grafana/dashboards" ]; then
                echo "Run this from repo root (missing ./observability/grafana/dashboards)" >&2
                exit 1
              fi

              state_dir="$(mktemp -d -t pi-observability-XXXXXX)"

              cleanup() {
                echo "Shutting down observability stack..." >&2
                # shellcheck disable=SC2046
                kill $(jobs -p) 2>/dev/null || true
                rm -rf "$state_dir"
              }
              trap cleanup EXIT INT TERM

              mkdir -p "$state_dir"/{grafana/{data,plugins,logs,provisioning/{datasources,dashboards}},prometheus,tempo,otel-collector}

              cat > "$state_dir/prometheus/prometheus.yml" <<EOF
              global:
                scrape_interval: 15s

              scrape_configs:
                - job_name: otel-collector
                  static_configs:
                    - targets: ['localhost:$COLLECTOR_PROM_PORT']
              EOF

              if [ -n "$SCRAPE_TARGET" ]; then
                cat >> "$state_dir/prometheus/prometheus.yml" <<EOF
                - job_name: app
                  static_configs:
                    - targets: ['$SCRAPE_TARGET']
              EOF
              fi

              cat > "$state_dir/tempo/tempo.yaml" <<EOF
              server:
                http_listen_port: $TEMPO_PORT
              distributor:
                receivers:
                  otlp:
                    protocols:
                      grpc:
                        endpoint: 127.0.0.1:$TEMPO_OTLP_GRPC_PORT
              storage:
                trace:
                  backend: local
                  local:
                    path: $state_dir/tempo/traces
                  wal:
                    path: $state_dir/tempo/wal
              EOF

              cat > "$state_dir/otel-collector/config.yaml" <<EOF
              receivers:
                otlp:
                  protocols:
                    grpc:
                      endpoint: 0.0.0.0:$OTLP_GRPC_PORT
                    http:
                      endpoint: 0.0.0.0:$OTLP_HTTP_PORT

              processors:
                batch: {}

              exporters:
                prometheus:
                  endpoint: 0.0.0.0:$COLLECTOR_PROM_PORT
                otlp/tempo:
                  endpoint: 127.0.0.1:$TEMPO_OTLP_GRPC_PORT
                  tls:
                    insecure: true

              service:
                pipelines:
                  metrics:
                    receivers: [otlp]
                    processors: [batch]
                    exporters: [prometheus]
                  traces:
                    receivers: [otlp]
                    processors: [batch]
                    exporters: [otlp/tempo]
              EOF

              cat > "$state_dir/grafana/provisioning/datasources/datasources.yaml" <<EOF
              apiVersion: 1
              datasources:
                - name: Prometheus
                  type: prometheus
                  uid: prometheus
                  url: http://localhost:$PROMETHEUS_PORT
                  isDefault: true
                - name: Tempo
                  type: tempo
                  uid: tempo
                  url: http://localhost:$TEMPO_PORT
                  jsonData:
                    serviceMap:
                      datasourceUid: prometheus
              EOF

              cat > "$state_dir/grafana/provisioning/dashboards/dashboards.yaml" <<EOF
              apiVersion: 1
              providers:
                - name: pi-observability
                  orgId: 1
                  folder: Pi
                  type: file
                  disableDeletion: false
                  updateIntervalSeconds: 10
                  allowUiUpdates: true
                  options:
                    path: $PWD/observability/grafana/dashboards
              EOF

              echo "Starting Tempo on :$TEMPO_PORT..."
              "${pkgs.tempo}/bin/tempo" \
                -config.file="$state_dir/tempo/tempo.yaml" \
                > "$state_dir/tempo.log" 2>&1 &

              echo "Starting OTel collector on OTLP HTTP :$OTLP_HTTP_PORT, OTLP gRPC :$OTLP_GRPC_PORT..."
              "${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib" \
                --config="$state_dir/otel-collector/config.yaml" \
                > "$state_dir/otel-collector.log" 2>&1 &

              echo "Starting Prometheus on :$PROMETHEUS_PORT..."
              "${pkgs.prometheus}/bin/prometheus" \
                --config.file="$state_dir/prometheus/prometheus.yml" \
                --storage.tsdb.path="$state_dir/prometheus/data" \
                --web.listen-address=":$PROMETHEUS_PORT" \
                > "$state_dir/prometheus.log" 2>&1 &

              echo "Starting Grafana on :$GRAFANA_PORT (admin/admin)..."
              GF_PATHS_DATA="$state_dir/grafana/data" \
              GF_PATHS_PLUGINS="$state_dir/grafana/plugins" \
              GF_PATHS_LOGS="$state_dir/grafana/logs" \
              GF_PATHS_PROVISIONING="$state_dir/grafana/provisioning" \
              GF_SERVER_HTTP_PORT="$GRAFANA_PORT" \
              GF_SECURITY_ADMIN_USER="''${PI_GRAFANA_USER:-admin}" \
              GF_SECURITY_ADMIN_PASSWORD="''${PI_GRAFANA_PASSWORD:-admin}" \
              GF_AUTH_ANONYMOUS_ENABLED=true \
              GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
                "${pkgs.grafana}/bin/grafana" server \
                --homepath=${pkgs.grafana}/share/grafana \
                > "$state_dir/grafana.log" 2>&1 &

              echo ""
              echo "Monitoring stack running:"
              echo "  Grafana:    http://localhost:$GRAFANA_PORT"
              echo "  Prometheus: http://localhost:$PROMETHEUS_PORT"
              echo "  Tempo:      http://localhost:$TEMPO_PORT"
              echo ""
              echo "Use with pi extension:"
              echo "  export PI_OTEL_METRICS_ENDPOINT=http://localhost:$OTLP_HTTP_PORT/v1/metrics"
              echo "  export PI_OTEL_TRACES_ENDPOINT=http://localhost:$OTLP_HTTP_PORT/v1/traces"
              echo ""
              echo "Press Ctrl+C to stop."
              wait
            '';
          };
        in {
          observability = {
            type = "app";
            program = "${observability}/bin/pi-observability";
          };
          default = self.apps.${system}.observability;
        });
    };
}
