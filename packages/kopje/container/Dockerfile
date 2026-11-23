# syntax=docker/dockerfile:1.29@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# Kopje's media processor (#1828): a pinned static ffmpeg/ffprobe build and the Go server of server/, which offers
# fixed operations only. An instance's Workers Builds (or `wrangler deploy`) builds this file from
# node_modules/kopje/container, so the image is the installed kopje version's. Every base is pinned by digest
# (test-node/container-image.test.ts).

# Go 1.27.4 (golang:1.27.4-alpine, multi-arch index digest). The server is cross-compiled on the build platform.
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/mediasrv .

# FFmpeg 9.0.2 static build (musl; libx264, libx265, libvpx, libopus, libvorbis, libmp3lame, libzimg),
# mwader/static-ffmpeg:9.0.2-1, multi-arch index digest.
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

# Runtime: distroless static (no shell, no package manager), Debian 13, nonroot.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:8ce6dd87e9823c5b48dcfb2c8604714ccb351ce59607327bcc4957448da279b5
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=build /out/mediasrv /usr/local/bin/mediasrv
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/mediasrv"]
