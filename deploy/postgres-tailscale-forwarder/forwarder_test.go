package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestForwarderRejectsUnregisteredRouteBeforeAccept(t *testing.T) {
	listener := newChannelListener()
	defer listener.Close()
	proxy := newForwarder(config{MaxSessions: 1}, newForwarderMetrics(nil), log.New(io.Discard, "", 0))
	completed := make(chan error, 1)
	go func() {
		completed <- proxy.serve(context.Background(), routeConfig{Name: "missing"}, listener)
	}()
	select {
	case err := <-completed:
		if err == nil || !strings.Contains(err.Error(), `metrics are not registered for route "missing"`) {
			t.Fatalf("expected a registration error, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("unregistered route waited for a connection")
	}
}

func TestForwarderCancellationDrainsAnOpenSessionAfterWaitTimeout(t *testing.T) {
	listener := newChannelListener()
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	route := routeConfig{Name: "primary", TargetAddr: "unused"}
	metrics := newForwarderMetrics([]routeConfig{route})
	proxy := newForwarder(config{MaxSessions: 1}, metrics, log.New(io.Discard, "", 0))
	upstreamConnection, upstreamPeer := net.Pipe()
	defer upstreamPeer.Close()
	dialed := make(chan struct{})
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		close(dialed)
		return upstreamConnection, nil
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- proxy.serve(ctx, route, listener) }()
	client, server := net.Pipe()
	defer client.Close()
	listener.connections <- server
	<-dialed
	if proxy.wait(time.Millisecond) {
		t.Fatal("open session unexpectedly drained")
	}
	cancel()
	_ = listener.Close()
	if err := <-serveDone; err != nil {
		t.Fatalf("serve: %v", err)
	}
	if !proxy.wait(time.Second) {
		t.Fatal("cancelled session did not drain")
	}
	if metrics.route("primary").activeSessions.Load() != 0 {
		t.Fatal("cancelled session retained its capacity")
	}
}

func TestForwarderDrainWaitsForLateAcceptRegistration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	route := routeConfig{Name: "primary", TargetAddr: "unused"}
	metrics := newForwarderMetrics([]routeConfig{route})
	proxy := newForwarder(config{MaxSessions: 1}, metrics, log.New(io.Discard, "", 0))
	client, server := net.Pipe()
	defer client.Close()
	listener := &pausedAcceptListener{connection: server, accepted: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	dialStarted := make(chan struct{})
	releaseDial := make(chan struct{})
	var releaseDialOnce sync.Once
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		close(dialStarted)
		<-releaseDial
		return nil, context.Canceled
	}
	defer func() {
		listener.releaseOnce.Do(func() { close(listener.release) })
		releaseDialOnce.Do(func() { close(releaseDial) })
		_ = listener.Close()
	}()
	proxy.startServing(ctx, route, listener, make(chan error, 1))
	<-listener.accepted
	cancel()
	_ = listener.Close()
	// Accept has obtained a connection but has not returned it for session
	// registration. A zero session count must not mean shutdown is complete.
	if proxy.wait(20 * time.Millisecond) {
		t.Fatal("drain completed before the accepted connection was registered")
	}
	listener.releaseOnce.Do(func() { close(listener.release) })
	select {
	case <-dialStarted:
	case <-time.After(time.Second):
		t.Fatal("late accepted connection was not registered")
	}
	if proxy.wait(20 * time.Millisecond) {
		t.Fatal("drain completed before the late session finished")
	}
	releaseDialOnce.Do(func() { close(releaseDial) })
	if !proxy.wait(time.Second) {
		t.Fatal("late accepted session did not drain")
	}
	if metrics.route("primary").activeSessions.Load() != 0 {
		t.Fatal("drained late session retained capacity")
	}
}

type pausedAcceptListener struct {
	connection  net.Conn
	accepted    chan struct{}
	release     chan struct{}
	closed      chan struct{}
	releaseOnce sync.Once
	closeOnce   sync.Once
	acceptOnce  sync.Once
}

func (listener *pausedAcceptListener) Accept() (net.Conn, error) {
	first := false
	listener.acceptOnce.Do(func() { first = true })
	if first {
		close(listener.accepted)
		<-listener.release
		return listener.connection, nil
	}
	<-listener.closed
	return nil, net.ErrClosed
}

func (listener *pausedAcceptListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.closed) })
	return nil
}

func (listener *pausedAcceptListener) Addr() net.Addr { return testAddr("paused") }

func TestForwarderCopiesBothDirections(t *testing.T) {
	listener := newChannelListener()
	upstreamDone := make(chan error, 1)
	dialUpstream := func(_ context.Context, _, _ string) (net.Conn, error) {
		client, connection := net.Pipe()
		go func() {
			defer connection.Close()
			request := make([]byte, len("ping"))
			if _, readErr := io.ReadFull(connection, request); readErr != nil {
				upstreamDone <- readErr
				return
			}
			if string(request) != "ping" {
				upstreamDone <- io.ErrUnexpectedEOF
				return
			}
			_, writeErr := connection.Write([]byte("pong"))
			upstreamDone <- writeErr
		}()
		return client, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	route := routeConfig{Name: "primary", ListenPort: 5432, TargetAddr: "unused"}
	configuration := config{MaxSessions: 2, DialTimeout: time.Second}
	metrics := newForwarderMetrics([]routeConfig{route})
	proxy := newForwarder(configuration, metrics, log.New(io.Discard, "", 0))
	proxy.dial = dialUpstream
	serveDone := make(chan error, 1)
	go func() { serveDone <- proxy.serve(ctx, route, listener) }()

	client, server := net.Pipe()
	listener.connections <- server
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatalf("write request: %v", err)
	}
	response := make([]byte, len("pong"))
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(response) != "pong" {
		t.Fatalf("response = %q", response)
	}
	_ = client.Close()

	if err := <-upstreamDone; err != nil {
		t.Fatalf("upstream: %v", err)
	}
	if !proxy.wait(time.Second) {
		t.Fatal("session did not drain")
	}
	cancel()
	_ = listener.Close()
	if err := <-serveDone; err != nil {
		t.Fatalf("serve: %v", err)
	}

	routeMetrics := metrics.route("primary")
	if routeMetrics.sessionsTotal.Load() != 1 || routeMetrics.activeSessions.Load() != 0 {
		t.Fatalf("unexpected session metrics: total=%d active=%d", routeMetrics.sessionsTotal.Load(), routeMetrics.activeSessions.Load())
	}
	if routeMetrics.clientBytesTotal.Load() != 4 || routeMetrics.serverBytesTotal.Load() != 4 {
		t.Fatalf("unexpected byte metrics: client=%d server=%d", routeMetrics.clientBytesTotal.Load(), routeMetrics.serverBytesTotal.Load())
	}
}

func TestForwarderRejectsSessionsOverGlobalCap(t *testing.T) {
	listener := newChannelListener()
	forensicListener := newChannelListener()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	upstreamClients := make(chan net.Conn, 2)
	route := routeConfig{Name: "primary", ListenPort: 5432, TargetAddr: "unused"}
	configuration := config{MaxSessions: 1, DialTimeout: time.Second}
	forensicRoute := routeConfig{Name: "forensic", ListenPort: 5434, TargetAddr: "unused"}
	metrics := newForwarderMetrics([]routeConfig{route, forensicRoute})
	proxy := newForwarder(configuration, metrics, log.New(io.Discard, "", 0))
	proxy.dial = func(_ context.Context, _, _ string) (net.Conn, error) {
		client, server := net.Pipe()
		upstreamClients <- server
		return client, nil
	}
	serveDone := make(chan error, 2)
	go func() { serveDone <- proxy.serve(ctx, route, listener) }()
	go func() { serveDone <- proxy.serve(ctx, forensicRoute, forensicListener) }()

	first, firstServer := net.Pipe()
	listener.connections <- firstServer
	upstream := <-upstreamClients
	waitForMetric(t, time.Second, func() bool { return metrics.route("primary").activeSessions.Load() == 1 })

	second, secondServer := net.Pipe()
	forensicListener.connections <- secondServer
	_ = second.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 1)
	if _, err := second.Read(buffer); err == nil {
		t.Fatal("second session was not closed")
	}
	waitForMetric(t, time.Second, func() bool { return metrics.route("forensic").rejectionsTotal.Load() == 1 })

	_ = second.Close()
	_ = first.Close()
	_ = upstream.Close()
	cancel()
	_ = listener.Close()
	_ = forensicListener.Close()
	for range 2 {
		if err := <-serveDone; err != nil {
			t.Fatalf("serve: %v", err)
		}
	}
}

func TestForwarderClosesBothSidesAfterOneSidedCopyFailure(t *testing.T) {
	clientConnection, clientPeer := net.Pipe()
	defer clientPeer.Close()
	upstreamConnection, upstreamPeer := net.Pipe()
	defer upstreamPeer.Close()

	route := routeConfig{Name: "primary", TargetAddr: "unused"}
	metrics := newForwarderMetrics([]routeConfig{route})
	var logs bytes.Buffer
	proxy := newForwarder(config{MaxSessions: 1, DialTimeout: time.Second}, metrics, log.New(&logs, "", 0))
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		return upstreamConnection, nil
	}

	copyFailure := errors.New("forced client read failure")
	done := make(chan struct{})
	go func() {
		proxy.proxy(
			context.Background(),
			route,
			&failingReadConn{Conn: clientConnection, err: copyFailure},
			metrics.route("primary"),
		)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy did not close the blocked opposite direction")
	}
	if !strings.Contains(logs.String(), "event=copy_failed route=primary direction=client_to_server") {
		t.Fatalf("unexpected log: %s", logs.String())
	}
}

func TestMetricsContainNoTargetAddresses(t *testing.T) {
	routes := []routeConfig{{Name: "primary", TargetAddr: "secret-name.railway.internal:5432"}}
	metrics := newForwarderMetrics(routes)
	metrics.ready.Store(true)
	metrics.route("primary").sessionsTotal.Add(2)
	var output bytes.Buffer
	if err := metrics.writePrometheus(&output); err != nil {
		t.Fatalf("writePrometheus: %v", err)
	}
	metricsText := output.String()
	if !strings.Contains(metricsText, "boardsesh_postgres_forwarder_ready 1") || !strings.Contains(metricsText, `sessions_total{route="primary"} 2`) {
		t.Fatalf("metrics missing expected values:\n%s", metricsText)
	}
	if strings.Contains(metricsText, "secret-name") || strings.Contains(metricsText, "railway.internal") {
		t.Fatalf("metrics disclosed target address:\n%s", metricsText)
	}
}

func TestDialFailureLogContainsNoTargetAddress(t *testing.T) {
	route := routeConfig{Name: "primary", TargetAddr: "secret-name.railway.internal:5432"}
	metrics := newForwarderMetrics([]routeConfig{route})
	var logs bytes.Buffer
	proxy := newForwarder(config{MaxSessions: 1, DialTimeout: time.Second}, metrics, log.New(&logs, "", 0))
	proxy.dial = func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("dial tcp secret-name.railway.internal:5432: refused")
	}
	client, server := net.Pipe()
	_ = client.Close()
	proxy.proxy(context.Background(), route, server, metrics.route("primary"))

	if strings.Contains(logs.String(), "secret-name") || strings.Contains(logs.String(), "railway.internal") {
		t.Fatalf("log disclosed target address: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "event=target_dial_failed route=primary error_class=other") {
		t.Fatalf("unexpected log: %s", logs.String())
	}
}

func waitForMetric(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("metric condition did not become true")
}

type channelListener struct {
	connections chan net.Conn
	closed      chan struct{}
	closeOnce   sync.Once
}

func newChannelListener() *channelListener {
	return &channelListener{connections: make(chan net.Conn), closed: make(chan struct{})}
}

func (listener *channelListener) Accept() (net.Conn, error) {
	select {
	case connection := <-listener.connections:
		return connection, nil
	case <-listener.closed:
		return nil, net.ErrClosed
	}
}

func (listener *channelListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.closed) })
	return nil
}

func (listener *channelListener) Addr() net.Addr { return testAddr("tailnet") }

type testAddr string

func (address testAddr) Network() string { return string(address) }
func (address testAddr) String() string  { return string(address) }

type failingReadConn struct {
	net.Conn
	err error
}

func (connection *failingReadConn) Read([]byte) (int, error) {
	return 0, connection.err
}
