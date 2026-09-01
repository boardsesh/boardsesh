package main

import (
	"strings"
	"testing"
	"time"
)

func testEnv(overrides map[string]string) getenvFunc {
	values := map[string]string{
		"TS_CLIENT_SECRET":     "tskey-client-test",
		"TS_STATE_DIR":         "/tmp/boardsesh-forwarder-test",
		"FORWARD_PRIMARY_ADDR": "postgis.railway.internal:5432",
	}
	for name, value := range overrides {
		values[name] = value
	}
	return func(name string) string { return values[name] }
}

func TestLoadConfigDefaults(t *testing.T) {
	configuration, err := loadConfig(testEnv(nil))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if configuration.HealthAddr != "0.0.0.0:8080" {
		t.Fatalf("HealthAddr = %q", configuration.HealthAddr)
	}
	if configuration.MaxSessions != 32 {
		t.Fatalf("MaxSessions = %d", configuration.MaxSessions)
	}
	if configuration.DialTimeout != 5*time.Second {
		t.Fatalf("DialTimeout = %s", configuration.DialTimeout)
	}
	if configuration.ClientSecret != "tskey-client-test?ephemeral=false&preauthorized=true" {
		t.Fatal("OAuth client secret did not enforce stable pre-approved enrollment")
	}
	if len(configuration.Routes) != 1 || configuration.Routes[0].Name != "primary" {
		t.Fatalf("Routes = %#v", configuration.Routes)
	}
}

func TestLoadConfigAllRoutes(t *testing.T) {
	configuration, err := loadConfig(testEnv(map[string]string{
		"PORT":                   "9090",
		"FORWARD_MAX_SESSIONS":   "12",
		"FORWARD_DIAL_TIMEOUT":   "7s",
		"TS_STARTUP_TIMEOUT":     "45s",
		"FORWARD_SHUTDOWN_GRACE": "15s",
		"FORWARD_CANDIDATE_ADDR": "postgis-18.railway.internal:5432",
		"FORWARD_FORENSIC_ADDR":  "postgis-16.railway.internal:5432",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if configuration.HealthAddr != "0.0.0.0:9090" || configuration.MaxSessions != 12 {
		t.Fatalf("unexpected scalar config: %#v", configuration)
	}
	if len(configuration.Routes) != 3 {
		t.Fatalf("Routes = %#v", configuration.Routes)
	}
	if configuration.Routes[1].ListenPort != 5433 || configuration.Routes[2].ListenPort != 5434 {
		t.Fatalf("unexpected route ports: %#v", configuration.Routes)
	}
}

func TestLoadConfigRejectsUnsafeInputs(t *testing.T) {
	tests := []struct {
		name      string
		overrides map[string]string
		wantError string
	}{
		{name: "missing OAuth secret", overrides: map[string]string{"TS_CLIENT_SECRET": ""}, wantError: "TS_CLIENT_SECRET is required"},
		{name: "wrong credential type", overrides: map[string]string{"TS_CLIENT_SECRET": "tskey-auth-test"}, wantError: "unmodified Tailscale OAuth client secret"},
		{name: "operator OAuth options", overrides: map[string]string{"TS_CLIENT_SECRET": "tskey-client-test?ephemeral=true"}, wantError: "unmodified Tailscale OAuth client secret"},
		{name: "auth key precedence", overrides: map[string]string{"TS_AUTHKEY": "unexpected"}, wantError: "forbidden"},
		{name: "alternate control plane", overrides: map[string]string{"TS_CONTROL_URL": "https://control.example.com"}, wantError: "official Tailscale control plane"},
		{name: "relative state", overrides: map[string]string{"TS_STATE_DIR": "state"}, wantError: "absolute"},
		{name: "root state", overrides: map[string]string{"TS_STATE_DIR": "/"}, wantError: "absolute"},
		{name: "health port overlap", overrides: map[string]string{"PORT": "5433"}, wantError: "must not overlap"},
		{name: "public database", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "db.example.com:5432"}, wantError: targetDNSSuffix},
		{name: "OTA database", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "postgres.railway.internal:5432"}, wantError: "separate OTA Postgres service"},
		{name: "other private service", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "redis.railway.internal:5432"}, wantError: "must target a PostGIS service"},
		{name: "URL target", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "postgres://postgis.railway.internal:5432"}, wantError: "bare"},
		{name: "wrong target port", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "postgis.railway.internal:6432"}, wantError: "port 5432"},
		{name: "invalid target label", overrides: map[string]string{"FORWARD_PRIMARY_ADDR": "post_gis.railway.internal:5432"}, wantError: "invalid DNS label"},
		{name: "duplicate candidate", overrides: map[string]string{"FORWARD_CANDIDATE_ADDR": "POSTGIS.RAILWAY.INTERNAL:5432"}, wantError: "duplicates"},
		{name: "session cap too high", overrides: map[string]string{"FORWARD_MAX_SESSIONS": "129"}, wantError: "1 through 128"},
		{name: "dial timeout too low", overrides: map[string]string{"FORWARD_DIAL_TIMEOUT": "500ms"}, wantError: "1s through 30s"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := loadConfig(testEnv(test.overrides))
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("loadConfig error = %v, want substring %q", err, test.wantError)
			}
		})
	}
}
