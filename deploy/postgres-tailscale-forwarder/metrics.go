package main

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"sync/atomic"
)

type routeMetrics struct {
	activeSessions   atomic.Int64
	sessionsTotal    atomic.Uint64
	rejectionsTotal  atomic.Uint64
	dialErrorsTotal  atomic.Uint64
	clientBytesTotal atomic.Uint64
	serverBytesTotal atomic.Uint64
}

type forwarderMetrics struct {
	ready  atomic.Bool
	mu     sync.RWMutex
	routes map[string]*routeMetrics
}

func newForwarderMetrics(routes []routeConfig) *forwarderMetrics {
	metrics := &forwarderMetrics{routes: make(map[string]*routeMetrics, len(routes))}
	for _, route := range routes {
		metrics.routes[route.Name] = &routeMetrics{}
	}
	return metrics
}

func (metrics *forwarderMetrics) route(name string) *routeMetrics {
	metrics.mu.RLock()
	route := metrics.routes[name]
	metrics.mu.RUnlock()
	return route
}

func (metrics *forwarderMetrics) writePrometheus(output io.Writer) error {
	ready := 0
	if metrics.ready.Load() {
		ready = 1
	}
	if _, err := fmt.Fprintf(output, "# HELP boardsesh_postgres_forwarder_ready Whether listeners and tsnet are ready.\n# TYPE boardsesh_postgres_forwarder_ready gauge\nboardsesh_postgres_forwarder_ready %d\n", ready); err != nil {
		return err
	}

	metrics.mu.RLock()
	routeNames := make([]string, 0, len(metrics.routes))
	for routeName := range metrics.routes {
		routeNames = append(routeNames, routeName)
	}
	sort.Strings(routeNames)
	routes := make(map[string]*routeMetrics, len(metrics.routes))
	for _, routeName := range routeNames {
		routes[routeName] = metrics.routes[routeName]
	}
	metrics.mu.RUnlock()

	metricDefinitions := []struct {
		name string
		help string
		kind string
		read func(*routeMetrics) uint64
	}{
		{
			name: "boardsesh_postgres_forwarder_active_sessions",
			help: "Current proxied sessions.",
			kind: "gauge",
			read: func(route *routeMetrics) uint64 { return uint64(route.activeSessions.Load()) },
		},
		{
			name: "boardsesh_postgres_forwarder_sessions_total",
			help: "Accepted proxied sessions.",
			kind: "counter",
			read: func(route *routeMetrics) uint64 { return route.sessionsTotal.Load() },
		},
		{
			name: "boardsesh_postgres_forwarder_rejections_total",
			help: "Sessions rejected by the global cap.",
			kind: "counter",
			read: func(route *routeMetrics) uint64 { return route.rejectionsTotal.Load() },
		},
		{
			name: "boardsesh_postgres_forwarder_dial_errors_total",
			help: "Private target dial failures.",
			kind: "counter",
			read: func(route *routeMetrics) uint64 { return route.dialErrorsTotal.Load() },
		},
	}

	for _, definition := range metricDefinitions {
		if _, err := fmt.Fprintf(output, "# HELP %s %s\n# TYPE %s %s\n", definition.name, definition.help, definition.name, definition.kind); err != nil {
			return err
		}
		for _, routeName := range routeNames {
			if _, err := fmt.Fprintf(output, "%s{route=%q} %d\n", definition.name, routeName, definition.read(routes[routeName])); err != nil {
				return err
			}
		}
	}

	if _, err := fmt.Fprint(output, "# HELP boardsesh_postgres_forwarder_bytes_total Bytes copied through the forwarder.\n# TYPE boardsesh_postgres_forwarder_bytes_total counter\n"); err != nil {
		return err
	}
	for _, routeName := range routeNames {
		route := routes[routeName]
		if _, err := fmt.Fprintf(output, "boardsesh_postgres_forwarder_bytes_total{route=%q,direction=%q} %d\n", routeName, "client_to_server", route.clientBytesTotal.Load()); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(output, "boardsesh_postgres_forwarder_bytes_total{route=%q,direction=%q} %d\n", routeName, "server_to_client", route.serverBytesTotal.Load()); err != nil {
			return err
		}
	}
	return nil
}
