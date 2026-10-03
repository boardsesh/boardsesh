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
	signalContext, cancelSignal := context.WithCancel(context.Background())
	defer cancelSignal()
	acceptContext, cancelAccept := context.WithCancel(signalContext)
	defer cancelAccept()
	sessionContext, cancelSessions := context.WithCancel(context.Background())
	defer cancelSessions()
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
		<-ctx.Done()
		return nil, ctx.Err()
	}
	proxy.startServingWithContexts(acceptContext, sessionContext, route, listener, make(chan error, 1))
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
	// NotifyContext cancellation reaches the real run/accept context before
	// shutdown starts; active sessions deliberately have a separate lifetime.
	cancelSignal()
	go func() {
		shutdownForwarder(cancelAccept, cancelSessions, []net.Listener{listener}, healthServer.Config, proxy, grace, logger)
		close(shutdownDone)
	}()
	<-shutdownStarted
	listener.releaseOnce.Do(func() { close(listener.release) })
	if acceptContext.Err() == nil || sessionContext.Err() != nil || metrics.ready.Load() {
		t.Error("shutdown did not stop admission while preserving active sessions and withdrawing readiness")
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

func TestShutdownDrainsLiveTCPUntilSharedDeadlineThenClosesIt(t *testing.T) {
	const grace = 600 * time.Millisecond

	routeListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for forwarded client: %v", err)
	}
	defer routeListener.Close()
	upstreamListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for upstream: %v", err)
	}
	defer upstreamListener.Close()

	upstreamReady := make(chan net.Conn, 1)
	upstreamDone := make(chan struct{})
	go func() {
		defer close(upstreamDone)
		upstreamConnection, acceptErr := upstreamListener.Accept()
		if acceptErr != nil {
			return
		}
		upstreamReady <- upstreamConnection
		_, _ = io.Copy(upstreamConnection, upstreamConnection)
		_ = upstreamConnection.Close()
	}()

	signalContext, cancelSignal := context.WithCancel(context.Background())
	defer cancelSignal()
	acceptContext, cancelAccept := context.WithCancel(signalContext)
	defer cancelAccept()
	sessionContext, cancelSessions := context.WithCancel(context.Background())
	defer cancelSessions()

	route := routeConfig{Name: "primary", TargetAddr: upstreamListener.Addr().String()}
	metrics := newForwarderMetrics([]routeConfig{route})
	metrics.ready.Store(true)
	proxy := newForwarder(config{MaxSessions: 1, DialTimeout: time.Second}, metrics, log.New(io.Discard, "", 0))
	proxy.startServingWithContexts(acceptContext, sessionContext, route, routeListener, make(chan error, 1))

	clientConnection, err := net.DialTimeout("tcp", routeListener.Addr().String(), time.Second)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer clientConnection.Close()
	var upstreamConnection net.Conn
	select {
	case upstreamConnection = <-upstreamReady:
	case <-time.After(time.Second):
		t.Fatal("forwarder did not dial the real upstream listener")
	}
	defer upstreamConnection.Close()
	waitForMetric(t, time.Second, func() bool { return metrics.route("primary").activeSessions.Load() == 1 })

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
	healthDone := make(chan error, 1)
	go func() {
		response, requestErr := healthServer.Client().Get(healthServer.URL)
		if requestErr == nil {
			requestErr = response.Body.Close()
		}
		healthDone <- requestErr
	}()
	<-healthStarted
	shutdownStarted := make(chan struct{})
	healthServer.Config.RegisterOnShutdown(func() { close(shutdownStarted) })
	shutdownDone := make(chan struct{})
	started := time.Now()
	// This is the same cancellation NotifyContext sends on SIGTERM.
	cancelSignal()
	go func() {
		shutdownForwarder(cancelAccept, cancelSessions, []net.Listener{routeListener}, healthServer.Config, proxy, grace, log.New(io.Discard, "", 0))
		close(shutdownDone)
	}()
	<-shutdownStarted
	if sessionContext.Err() != nil || metrics.ready.Load() {
		t.Fatal("SIGTERM canceled active proxy sessions before draining")
	}

	if err := clientConnection.SetDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatalf("set drain exchange deadline: %v", err)
	}
	if _, err := io.WriteString(clientConnection, "during-drain"); err != nil {
		t.Fatalf("write during graceful drain: %v", err)
	}
	response := make([]byte, len("during-drain"))
	if _, err := io.ReadFull(clientConnection, response); err != nil {
		t.Fatalf("read response during graceful drain: %v", err)
	}
	if string(response) != "during-drain" {
		t.Fatalf("upstream response during drain = %q", response)
	}
	_ = clientConnection.SetDeadline(time.Time{})

	time.Sleep(grace * 3 / 5)
	releaseHealthOnce.Do(func() { close(releaseHealth) })
	select {
	case <-shutdownDone:
	case <-time.After(grace + 300*time.Millisecond):
		t.Fatal("shutdown exceeded its single shared drain deadline")
	}
	if elapsed := time.Since(started); elapsed < grace-40*time.Millisecond || elapsed > grace+300*time.Millisecond {
		t.Fatalf("shutdown elapsed %s, want one %s shared deadline", elapsed, grace)
	}
	if sessionContext.Err() == nil {
		t.Fatal("shutdown did not force-cancel the session remaining at the deadline")
	}
	if err := <-healthDone; err != nil {
		t.Fatalf("health request: %v", err)
	}
	if !proxy.wait(time.Second) {
		t.Fatal("force-canceled TCP session did not finish")
	}
	if _, err := clientConnection.Read(make([]byte, 1)); err == nil {
		t.Fatal("TCP client remained open after the shared drain deadline")
	}
	select {
	case <-upstreamDone:
	case <-time.After(time.Second):
		t.Fatal("upstream TCP socket remained open after forced session cancellation")
	}
}

func TestShutdownJoinsPendingDialAfterSessionCancellation(t *testing.T) {
	const grace = 40 * time.Millisecond

	signalContext, cancelSignal := context.WithCancel(context.Background())
	defer cancelSignal()
	acceptContext, cancelAccept := context.WithCancel(signalContext)
	defer cancelAccept()
	sessionContext, cancelSessions := context.WithCancel(context.Background())
	defer cancelSessions()

	route := routeConfig{Name: "primary", TargetAddr: "pending"}
	metrics := newForwarderMetrics([]routeConfig{route})
	metrics.ready.Store(true)
	proxy := newForwarder(config{MaxSessions: 1}, metrics, log.New(io.Discard, "", 0))
	listener := newChannelListener()
	defer listener.Close()
	dialStarted := make(chan struct{})
	dialCanceled := make(chan struct{})
	releaseDial := make(chan struct{})
	var releaseDialOnce sync.Once
	defer releaseDialOnce.Do(func() { close(releaseDial) })
	dialFinished := make(chan struct{})
	proxy.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		close(dialStarted)
		<-ctx.Done()
		close(dialCanceled)
		<-releaseDial
		close(dialFinished)
		return nil, ctx.Err()
	}
	proxy.startServingWithContexts(acceptContext, sessionContext, route, listener, make(chan error, 1))
	client, server := net.Pipe()
	defer client.Close()
	listener.connections <- server
	select {
	case <-dialStarted:
	case <-time.After(time.Second):
		t.Fatal("forwarder did not begin its pending upstream dial")
	}

	healthServer := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer healthServer.Close()
	shutdownDone := make(chan struct{})
	started := time.Now()
	cancelSignal()
	go func() {
		shutdownForwarder(cancelAccept, cancelSessions, []net.Listener{listener}, healthServer.Config, proxy, grace, log.New(io.Discard, "", 0))
		close(shutdownDone)
	}()
	select {
	case <-dialCanceled:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel the pending dial at the shared deadline")
	}
	select {
	case <-shutdownDone:
		t.Fatal("shutdown closed the tailnet before the canceled dial released its session")
	case <-time.After(20 * time.Millisecond):
	}
	releaseDialOnce.Do(func() { close(releaseDial) })
	select {
	case <-shutdownDone:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish after the canceled dial returned")
	}
	if elapsed := time.Since(started); elapsed < grace-10*time.Millisecond || elapsed > grace+250*time.Millisecond {
		t.Fatalf("shutdown elapsed %s, want deadline cancellation followed by dial cleanup", elapsed)
	}
	select {
	case <-dialFinished:
	default:
		t.Fatal("shutdown returned before the dial goroutine completed")
	}
	if sessionContext.Err() == nil || metrics.route("primary").activeSessions.Load() != 0 {
		t.Fatal("forced dial cancellation left an active session")
	}
}
