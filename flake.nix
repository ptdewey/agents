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
              pkgs.gnused
              pkgs.grafana
              pkgs.opentelemetry-collector-contrib
              pkgs.prometheus
              pkgs.tempo
            ];
            text = ''
              set -euo pipefail

              root="$PWD"
              if [ ! -f "$root/observability/otel-collector-config.yaml" ]; then
                echo "Run this from the repository root (missing ./observability/otel-collector-config.yaml)." >&2
                exit 1
              fi

              state_dir="$(mktemp -d -t pi-observability-XXXXXX)"
              config_dir="$state_dir/observability"

              # shellcheck disable=SC2317
              cleanup() {
                echo "Shutting down observability stack..." >&2
                # shellcheck disable=SC2046
                kill $(jobs -p) 2>/dev/null || true
                rm -rf "$state_dir"
              }
              trap cleanup EXIT INT TERM

              cp -R "$root/observability" "$config_dir"

              sed -i \
                -e "s|0.0.0.0:4317|0.0.0.0:''${PI_OTEL_COLLECTOR_GRPC_PORT:-14317}|g" \
                -e "s|0.0.0.0:4318|0.0.0.0:''${PI_OTEL_COLLECTOR_HTTP_PORT:-14318}|g" \
                -e "s|0.0.0.0:9464|0.0.0.0:''${PI_OTEL_COLLECTOR_PROM_PORT:-19464}|g" \
                -e "s|tempo:4317|127.0.0.1:4317|g" \
                "$config_dir/otel-collector-config.yaml"

              sed -i \
                -e "s|otel-collector:9464|localhost:''${PI_OTEL_COLLECTOR_PROM_PORT:-19464}|g" \
                "$config_dir/prometheus.yml"

              sed -i \
                -e "s|http://prometheus:9090|http://localhost:''${PI_PROMETHEUS_PORT:-19090}|g" \
                -e "s|http://tempo:3200|http://localhost:''${PI_TEMPO_PORT:-13200}|g" \
                "$config_dir/grafana/provisioning/datasources/datasources.yml"

              sed -i \
                -e "s|http_listen_port: 3200|http_listen_port: ''${PI_TEMPO_PORT:-13200}|g" \
                "$config_dir/tempo.yml"

              sed -i \
                -e "s|/var/lib/grafana/dashboards|$config_dir/grafana/dashboards|g" \
                "$config_dir/grafana/provisioning/dashboards/dashboards.yml"

              mkdir -p \
                "$state_dir/prometheus" \
                "$state_dir/grafana/data" \
                "$state_dir/grafana/logs" \
                "$state_dir/grafana/plugins"

              export GF_SECURITY_ADMIN_USER="''${PI_GRAFANA_USER:-admin}"
              export GF_SECURITY_ADMIN_PASSWORD="''${PI_GRAFANA_PASSWORD:-admin}"
              export GF_AUTH_ANONYMOUS_ENABLED="true"
              export GF_AUTH_ANONYMOUS_ORG_ROLE="Viewer"
              export GF_PATHS_DATA="$state_dir/grafana/data"
              export GF_PATHS_LOGS="$state_dir/grafana/logs"
              export GF_PATHS_PLUGINS="$state_dir/grafana/plugins"
              export GF_PATHS_PROVISIONING="$config_dir/grafana/provisioning"
              export GF_SERVER_HTTP_ADDR="0.0.0.0"
              export GF_SERVER_HTTP_PORT="''${PI_GRAFANA_PORT:-13000}"

              "${pkgs.tempo}/bin/tempo" -config.file="$config_dir/tempo.yml" &

              "${pkgs.prometheus}/bin/prometheus" \
                --config.file="$config_dir/prometheus.yml" \
                --storage.tsdb.path="$state_dir/prometheus" \
                --web.enable-lifecycle \
                --web.listen-address="0.0.0.0:''${PI_PROMETHEUS_PORT:-19090}" &

              "${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib" \
                --config="$config_dir/otel-collector-config.yaml" &

              "${pkgs.grafana}/bin/grafana" server \
                --homepath "${pkgs.grafana}/share/grafana" \
                --config "${pkgs.grafana}/share/grafana/conf/defaults.ini" &

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
