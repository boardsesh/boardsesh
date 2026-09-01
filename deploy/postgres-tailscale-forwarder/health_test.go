package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthEndpoints(t *testing.T) {
	metrics := newForwarderMetrics([]routeConfig{{Name: "primary"}})
	tailnetError := error(nil)
	handler := healthHandler(metrics, func(context.Context) error { return tailnetError })

	assertStatus(t, handler, "/livez", http.StatusOK)
	assertStatus(t, handler, "/readyz", http.StatusServiceUnavailable)

	metrics.ready.Store(true)
	assertStatus(t, handler, "/readyz", http.StatusOK)

	tailnetError = errors.New("not running")
	assertStatus(t, handler, "/readyz", http.StatusServiceUnavailable)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "boardsesh_postgres_forwarder_ready") {
		t.Fatalf("metrics response = %d %q", recorder.Code, recorder.Body.String())
	}
}

func assertStatus(t *testing.T, handler http.Handler, path string, want int) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != want {
		t.Fatalf("GET %s = %d, want %d", path, recorder.Code, want)
	}
}
