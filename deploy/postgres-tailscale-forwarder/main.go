package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

func main() {
	ctx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	if err := run(ctx, os.Getenv, logger); err != nil {
		logger.Printf("event=forwarder_stopped error=%q", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv getenvFunc, logger *log.Logger) error {
	runContext, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	config, err := loadConfig(getenv)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	if err := os.MkdirAll(config.StateDir, 0o700); err != nil {
		return fmt.Errorf("create tsnet state directory: %w", err)
	}

	metrics := newForwarderMetrics(config.Routes)
	proxy := newForwarder(config, metrics, logger)
	tailnet := &tsnet.Server{
		Dir:           config.StateDir,
		Hostname:      forwarderHostname,
		ClientSecret:  config.ClientSecret,
		AdvertiseTags: []string{forwarderTag},
		Ephemeral:     false,
		UserLogf: func(format string, arguments ...interface{}) {
			logger.Printf("component=tsnet message=%q", fmt.Sprintf(format, arguments...))
		},
	}
	_ = os.Unsetenv("TS_CLIENT_SECRET")
	defer tailnet.Close()

	startupContext, cancelStartup := context.WithTimeout(runContext, config.StartupTimeout)
	status, err := tailnet.Up(startupContext)
	cancelStartup()
	if err != nil {
		return fmt.Errorf("join tailnet: %w", err)
	}
	if status.BackendState != ipn.Running.String() {
		return fmt.Errorf("join tailnet: unexpected backend state %q", status.BackendState)
	}
	localClient, err := tailnet.LocalClient()
	if err != nil {
		return fmt.Errorf("create local tailnet client: %w", err)
	}

	listeners := make([]net.Listener, 0, len(config.Routes))
	serveErrors := make(chan error, len(config.Routes)+1)
	for _, route := range config.Routes {
		listener, err := tailnet.Listen("tcp", ":"+strconv.Itoa(int(route.ListenPort)))
		if err != nil {
			closeListeners(listeners)
			return fmt.Errorf("listen on tailnet route %s: %w", route.Name, err)
		}
		listeners = append(listeners, listener)
		go func(route routeConfig, listener net.Listener) {
			if err := proxy.serve(runContext, route, listener); err != nil {
				serveErrors <- err
			}
		}(route, listener)
		logger.Printf("event=route_listening route=%s tailnet_port=%d", route.Name, route.ListenPort)
	}

	tailnetReady := func(statusContext context.Context) error {
		status, err := localClient.StatusWithoutPeers(statusContext)
		if err != nil {
			return err
		}
		if status.BackendState != ipn.Running.String() {
			return fmt.Errorf("backend state is %q", status.BackendState)
		}
		return nil
	}
	healthServer := &http.Server{
		Addr:              config.HealthAddr,
		Handler:           healthHandler(metrics, tailnetReady),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	healthListener, err := net.Listen("tcp", config.HealthAddr)
	if err != nil {
		closeListeners(listeners)
		return fmt.Errorf("listen for health checks: %w", err)
	}
	go func() {
		if err := healthServer.Serve(healthListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrors <- fmt.Errorf("serve health checks: %w", err)
		}
	}()

	metrics.ready.Store(true)
	logger.Printf("event=forwarder_ready routes=%d max_sessions=%d", len(config.Routes), config.MaxSessions)

	var runError error
	select {
	case <-runContext.Done():
	case runError = <-serveErrors:
	}

	cancelRun()
	metrics.ready.Store(false)
	closeListeners(listeners)
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), config.ShutdownGrace)
	defer cancelShutdown()
	if err := healthServer.Shutdown(shutdownContext); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		logger.Printf("event=health_shutdown_failed error=%q", err)
	}
	if !proxy.wait(config.ShutdownGrace) {
		logger.Printf("event=session_drain_timed_out grace=%s", config.ShutdownGrace)
	}
	logger.Printf("event=forwarder_shutdown")
	return runError
}

func closeListeners(listeners []net.Listener) {
	for _, listener := range listeners {
		_ = listener.Close()
	}
}
