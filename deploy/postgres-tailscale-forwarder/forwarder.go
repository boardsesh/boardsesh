package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"syscall"
	"time"
)

type dialContextFunc func(context.Context, string, string) (net.Conn, error)

type copyResult struct {
	direction string
	bytes     int64
	err       error
}

type forwarder struct {
	dial       dialContextFunc
	logger     *log.Logger
	metrics    *forwarderMetrics
	sessionCap chan struct{}
	sessions   sync.WaitGroup
}

func newForwarder(config config, metrics *forwarderMetrics, logger *log.Logger) *forwarder {
	dialer := &net.Dialer{Timeout: config.DialTimeout, KeepAlive: 30 * time.Second}
	return &forwarder{
		dial:       dialer.DialContext,
		logger:     logger,
		metrics:    metrics,
		sessionCap: make(chan struct{}, config.MaxSessions),
	}
}

func (forwarder *forwarder) serve(ctx context.Context, route routeConfig, listener net.Listener) error {
	for {
		client, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept %s route: %w", route.Name, err)
		}

		routeMetrics := forwarder.metrics.route(route.Name)
		select {
		case forwarder.sessionCap <- struct{}{}:
			routeMetrics.sessionsTotal.Add(1)
			routeMetrics.activeSessions.Add(1)
			forwarder.sessions.Add(1)
			go func() {
				defer forwarder.sessions.Done()
				defer func() {
					<-forwarder.sessionCap
					routeMetrics.activeSessions.Add(-1)
				}()
				forwarder.proxy(ctx, route, client, routeMetrics)
			}()
		default:
			routeMetrics.rejectionsTotal.Add(1)
			forwarder.logger.Printf("event=session_rejected route=%s reason=max_sessions", route.Name)
			_ = client.Close()
		}
	}
}

func (forwarder *forwarder) proxy(ctx context.Context, route routeConfig, client net.Conn, routeMetrics *routeMetrics) {
	defer client.Close()

	upstream, err := forwarder.dial(ctx, "tcp", route.TargetAddr)
	if err != nil {
		routeMetrics.dialErrorsTotal.Add(1)
		forwarder.logger.Printf("event=target_dial_failed route=%s error_class=%s", route.Name, networkErrorClass(err))
		return
	}
	defer upstream.Close()

	copyContext, cancelCopy := context.WithCancel(ctx)
	defer cancelCopy()
	go func() {
		<-copyContext.Done()
		_ = client.Close()
		_ = upstream.Close()
	}()

	results := make(chan copyResult, 2)
	go copyStream(results, "client_to_server", upstream, client)
	go copyStream(results, "server_to_client", client, upstream)

	for copyIndex := 0; copyIndex < 2; copyIndex++ {
		result := <-results
		switch result.direction {
		case "client_to_server":
			routeMetrics.clientBytesTotal.Add(uint64(result.bytes))
			closeWrite(upstream)
		case "server_to_client":
			routeMetrics.serverBytesTotal.Add(uint64(result.bytes))
			closeWrite(client)
		}
		if result.err != nil && !errors.Is(result.err, net.ErrClosed) && ctx.Err() == nil {
			forwarder.logger.Printf("event=copy_failed route=%s direction=%s error_class=%s", route.Name, result.direction, networkErrorClass(result.err))
		}
		if result.err != nil {
			// A failed direction cannot make useful progress. Close both sides now so
			// the opposite io.Copy cannot hold a global session slot indefinitely.
			cancelCopy()
			_ = client.Close()
			_ = upstream.Close()
		}
	}
}

func copyStream(results chan<- copyResult, direction string, destination io.Writer, source io.Reader) {
	bytesCopied, err := io.Copy(destination, source)
	results <- copyResult{direction: direction, bytes: bytesCopied, err: err}
}

func closeWrite(connection net.Conn) {
	type closeWriter interface {
		CloseWrite() error
	}
	if writer, ok := connection.(closeWriter); ok {
		_ = writer.CloseWrite()
	}
}

func networkErrorClass(err error) string {
	var dnsError *net.DNSError
	var networkError net.Error
	switch {
	case errors.As(err, &dnsError):
		return "dns"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &networkError) && networkError.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset"
	case errors.Is(err, syscall.EPIPE):
		return "broken_pipe"
	default:
		return "other"
	}
}

func (forwarder *forwarder) wait(timeout time.Duration) bool {
	completed := make(chan struct{})
	go func() {
		forwarder.sessions.Wait()
		close(completed)
	}()
	select {
	case <-completed:
		return true
	case <-time.After(timeout):
		return false
	}
}
