# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d

FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine3.23@sha256:3747dcba41c8b0db3211fda4db61638b980e17ac5bb3c94460a975a9cfe19395 AS build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build \
    -trimpath \
    -ldflags='-s -w -buildid=' \
    -o /out/postgres-tailscale-forwarder .

FROM gcr.io/distroless/static-debian13:nonroot@sha256:1c2c046bc09ed40fad370b599a0b1ae7987f55b01e247cf27a7c27cd97e5bbc7

COPY --from=build /out/postgres-tailscale-forwarder /usr/local/bin/postgres-tailscale-forwarder
COPY --chown=65532:65532 state/ /var/lib/boardsesh-tsnet/

USER nonroot:nonroot
EXPOSE 8080
VOLUME ["/var/lib/boardsesh-tsnet"]
ENTRYPOINT ["/usr/local/bin/postgres-tailscale-forwarder"]
