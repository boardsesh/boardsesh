package main

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

type tailnetReadyFunc func(context.Context) error

func healthHandler(metrics *forwarderMetrics, tailnetReady tailnetReadyFunc) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /readyz", func(response http.ResponseWriter, request *http.Request) {
		if !metrics.ready.Load() {
			http.Error(response, "listeners are not ready", http.StatusServiceUnavailable)
			return
		}
		statusContext, cancelStatus := context.WithTimeout(request.Context(), time.Second)
		defer cancelStatus()
		if err := tailnetReady(statusContext); err != nil {
			http.Error(response, "tailnet is not ready", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /metrics", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		if err := metrics.writePrometheus(response); err != nil {
			http.Error(response, fmt.Sprintf("write metrics: %v", err), http.StatusInternalServerError)
		}
	})
	return mux
}
