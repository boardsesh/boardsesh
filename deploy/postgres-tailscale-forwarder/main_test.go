package main

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestRunShutdownSharesGraceAcrossHealthAndSessions(t *testing.T) {
	ctx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	route := routeConfig{Name: "primary", TargetAddr: "unused"}
	metrics := newForwarderMetrics([]routeConfig{route})
	metrics.ready.Store(true)
	logger := log.New(io.Discard, "", 0)
	proxy := newForwarder(config{MaxSessions: 1}, metrics, logger)
	// Pause a real accepted connection before session registration. Closing a
	// listener cannot retract an Accept that has already obtained a connection.
	client, connection := net.Pipe()
	defer client.Close()
	listener := &pausedAcceptListener{connection: connection, accepted: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	proxy.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return nil, ctx.Err()
	}
	proxy.startServing(ctx, route, listener, make(chan error, 1))
	<-listener.accepted
	defer func() {
		listener.releaseOnce.Do(func() { close(listener.release) })
		_ = listener.Close()
		if !proxy.wait(time.Second) {
			t.Error("late accepted connection did not drain during cleanup")
		}
	}()

	healthStarted := make(chan struct{})
	releaseHealth := make(chan struct{})
	var releaseHealthOnce sync.Once
	healthServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		close(healthStarted)
		<-releaseHealth
		response.WriteHeader(http.StatusOK)
	}))
	defer healthServer.Close()
	defer releaseHealthOnce.Do(func() { close(releaseHealth) })
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		response, err := healthServer.Client().Get(healthServer.URL)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	<-healthStarted

	shutdownStarted := make(chan struct{})
	healthServer.Config.RegisterOnShutdown(func() { close(shutdownStarted) })
	shutdownDone := make(chan struct{})
	const grace = 500 * time.Millisecond
	started := time.Now()
	go func() {
		shutdownForwarder(cancelRun, []net.Listener{listener}, healthServer.Config, proxy, grace, logger)
		close(shutdownDone)
	}()
	<-shutdownStarted
	if ctx.Err() == nil || metrics.ready.Load() {
		t.Error("health shutdown started before session cancellation/readiness withdrawal")
	}
	select {
	case <-listener.closed:
	default:
		t.Error("health shutdown started before the route listener closed")
	}
	select {
	case <-shutdownDone:
		if time.Since(started) < grace {
			t.Error("shutdown returned before allowing the blocked health request its grace")
		}
	case <-time.After(grace + grace/2):
		t.Error("session drain received a second grace period after health exhausted the deadline")
	}
	// Release both held operations even on failure, so no server/session leaks.
	releaseHealthOnce.Do(func() { close(releaseHealth) })
	listener.releaseOnce.Do(func() { close(listener.release) })
	<-shutdownDone
	<-requestDone
}
