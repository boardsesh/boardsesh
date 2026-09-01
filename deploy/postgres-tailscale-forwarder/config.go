package main

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	forwarderHostname = "boardsesh-db-forwarder"
	forwarderTag      = "tag:boardsesh-db-forwarder"
	targetDNSSuffix   = ".railway.internal"
)

type routeConfig struct {
	Name       string
	ListenPort uint16
	TargetAddr string
}

type config struct {
	ClientSecret   string
	StateDir       string
	HealthAddr     string
	MaxSessions    int
	DialTimeout    time.Duration
	StartupTimeout time.Duration
	ShutdownGrace  time.Duration
	Routes         []routeConfig
}

type getenvFunc func(string) string

func loadConfig(getenv getenvFunc) (config, error) {
	clientSecret := strings.TrimSpace(getenv("TS_CLIENT_SECRET"))
	if clientSecret == "" {
		return config{}, fmt.Errorf("TS_CLIENT_SECRET is required")
	}
	if !strings.HasPrefix(clientSecret, "tskey-client-") || strings.ContainsAny(clientSecret, "?&#") {
		return config{}, fmt.Errorf("TS_CLIENT_SECRET must be an unmodified Tailscale OAuth client secret")
	}
	if strings.TrimSpace(getenv("TS_AUTHKEY")) != "" || strings.TrimSpace(getenv("TS_AUTH_KEY")) != "" {
		return config{}, fmt.Errorf("TS_AUTHKEY and TS_AUTH_KEY are forbidden; use the tag-scoped TS_CLIENT_SECRET")
	}
	if strings.TrimSpace(getenv("TS_CONTROL_URL")) != "" {
		return config{}, fmt.Errorf("TS_CONTROL_URL is forbidden; the forwarder must use the official Tailscale control plane")
	}

	stateDir := strings.TrimSpace(getenv("TS_STATE_DIR"))
	if stateDir == "" {
		stateDir = "/var/lib/boardsesh-tsnet"
	}
	stateDir = filepath.Clean(stateDir)
	if !filepath.IsAbs(stateDir) || stateDir == string(filepath.Separator) {
		return config{}, fmt.Errorf("TS_STATE_DIR must be an absolute non-root path")
	}

	healthPort, err := parseBoundedInt("PORT", getenv("PORT"), 8080, 1, 65535)
	if err != nil {
		return config{}, err
	}
	if healthPort >= 5432 && healthPort <= 5434 {
		return config{}, fmt.Errorf("PORT must not overlap tailnet database ports 5432 through 5434")
	}
	maxSessions, err := parseBoundedInt("FORWARD_MAX_SESSIONS", getenv("FORWARD_MAX_SESSIONS"), 32, 1, 128)
	if err != nil {
		return config{}, err
	}
	dialTimeout, err := parseBoundedDuration("FORWARD_DIAL_TIMEOUT", getenv("FORWARD_DIAL_TIMEOUT"), 5*time.Second, time.Second, 30*time.Second)
	if err != nil {
		return config{}, err
	}
	startupTimeout, err := parseBoundedDuration("TS_STARTUP_TIMEOUT", getenv("TS_STARTUP_TIMEOUT"), 30*time.Second, 5*time.Second, 2*time.Minute)
	if err != nil {
		return config{}, err
	}
	shutdownGrace, err := parseBoundedDuration("FORWARD_SHUTDOWN_GRACE", getenv("FORWARD_SHUTDOWN_GRACE"), 20*time.Second, time.Second, time.Minute)
	if err != nil {
		return config{}, err
	}

	routeSpecs := []struct {
		name       string
		envName    string
		listenPort uint16
		required   bool
	}{
		{name: "primary", envName: "FORWARD_PRIMARY_ADDR", listenPort: 5432, required: true},
		{name: "candidate", envName: "FORWARD_CANDIDATE_ADDR", listenPort: 5433},
		{name: "forensic", envName: "FORWARD_FORENSIC_ADDR", listenPort: 5434},
	}

	routes := make([]routeConfig, 0, len(routeSpecs))
	seenTargets := make(map[string]string, len(routeSpecs))
	for _, routeSpec := range routeSpecs {
		targetAddr := strings.TrimSpace(getenv(routeSpec.envName))
		if targetAddr == "" {
			if routeSpec.required {
				return config{}, fmt.Errorf("%s is required", routeSpec.envName)
			}
			continue
		}
		canonicalTarget, err := validateTargetAddr(routeSpec.envName, targetAddr)
		if err != nil {
			return config{}, err
		}
		if existingRoute, exists := seenTargets[canonicalTarget]; exists {
			return config{}, fmt.Errorf("%s duplicates the %s route target", routeSpec.envName, existingRoute)
		}
		seenTargets[canonicalTarget] = routeSpec.name
		routes = append(routes, routeConfig{
			Name:       routeSpec.name,
			ListenPort: routeSpec.listenPort,
			TargetAddr: canonicalTarget,
		})
	}

	return config{
		// OAuth-generated auth keys default to ephemeral. Compile these options
		// here, rather than accepting secret suffixes from the environment, so the
		// volume-backed node has one stable, pre-approved tailnet identity.
		ClientSecret:   clientSecret + "?ephemeral=false&preauthorized=true",
		StateDir:       stateDir,
		HealthAddr:     net.JoinHostPort("0.0.0.0", strconv.Itoa(healthPort)),
		MaxSessions:    maxSessions,
		DialTimeout:    dialTimeout,
		StartupTimeout: startupTimeout,
		ShutdownGrace:  shutdownGrace,
		Routes:         routes,
	}, nil
}

func parseBoundedInt(name, raw string, defaultValue, minimum, maximum int) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultValue, nil
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be an integer from %d through %d", name, minimum, maximum)
	}
	return parsed, nil
}

func parseBoundedDuration(name, raw string, defaultValue, minimum, maximum time.Duration) (time.Duration, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultValue, nil
	}
	parsed, err := time.ParseDuration(trimmed)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be a duration from %s through %s", name, minimum, maximum)
	}
	return parsed, nil
}

func validateTargetAddr(name, raw string) (string, error) {
	if strings.Contains(raw, "://") || strings.ContainsAny(raw, "@/?#") {
		return "", fmt.Errorf("%s must be a bare Railway-private host:5432 address", name)
	}
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return "", fmt.Errorf("%s must be a bare Railway-private host:5432 address: %w", name, err)
	}
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if !strings.HasSuffix(host, targetDNSSuffix) || host == strings.TrimPrefix(targetDNSSuffix, ".") {
		return "", fmt.Errorf("%s host must end in %s", name, targetDNSSuffix)
	}
	for _, label := range strings.Split(host, ".") {
		if !validDNSLabel(label) {
			return "", fmt.Errorf("%s contains an invalid DNS label", name)
		}
	}
	serviceLabel := strings.SplitN(host, ".", 2)[0]
	if serviceLabel != "postgis" && !strings.HasPrefix(serviceLabel, "postgis-") {
		return "", fmt.Errorf("%s must target a PostGIS service, never the separate OTA Postgres service", name)
	}
	if port != "5432" {
		return "", fmt.Errorf("%s must target PostgreSQL port 5432", name)
	}
	return net.JoinHostPort(host, port), nil
}

func validDNSLabel(label string) bool {
	if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, character := range label {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}
