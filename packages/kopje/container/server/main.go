// Command mediasrv is the media processor's HTTP server, run in Kopje's container image (#1828). It offers fixed
// operations on one input at a time, never a command line:
//
//	POST /normalize?probe_ms=<ms>&encode_ms=<ms>  input -> H.264/AAC MP4 or MP3, by its streams
//	GET  /normalize/still                         the PNG still the last video normalize made
//	POST /still                                   input video -> one PNG still, long edge <= 640
//	GET  /healthz                                 readiness
//
// The input is the request body, written to the container's disk (an MP4 whose moov is at the end needs the whole
// file) up to AV_UPLOAD_LIMIT. The output is the response body with its Content-Length. The probe and encode stages
// are killed at the times the Worker passes (ffmpeg's process group SIGKILLed); /still at stillTimeout. ffmpeg reads
// only local files of the allowed demuxers. A failure answers a code (an "error" field and the Kopje-Error header),
// never ffmpeg's output. The container has no network: Kopje starts it with Internet access disabled.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const (
	// AV_UPLOAD_LIMIT: the largest input, the upload cap Kopje advertises.
	avUploadLimit = 94_371_840
	// AV_OUTPUT_LIMIT and STILL_OUTPUT_LIMIT: Kopje's readers refuse more; the server refuses first.
	avOutputLimit    = 63 << 20
	stillOutputLimit = 2 << 20
	stillTimeout     = 60 * time.Second
	// Bounds on the stage times a request may pass.
	minStageMs = 100
	maxStageMs = 60 * 60 * 1000
)

var (
	workRoot  = envOr("MEDIASRV_WORK", "/tmp/work")
	stillPath = filepath.Join(workRoot, "normalize-still.png")
	ffmpegBin = envOr("FFMPEG", "/usr/local/bin/ffmpeg")
	probeBin  = envOr("FFPROBE", "/usr/local/bin/ffprobe")
	bootID    = newID()
	// One job at a time per process.
	busy = make(chan struct{}, 1)
)

func main() {
	threads, err := parseThreading(os.Getenv("MEDIASRV_THREADS"))
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              ":" + envOr("PORT", "8080"),
		Handler:           newMux(threads),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("mediasrv boot=%s listening on %s", bootID, srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func newMux(threads threading) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "bootId": bootID})
	})
	mux.HandleFunc("POST /normalize", exclusive(func(w http.ResponseWriter, r *http.Request) {
		handleNormalize(w, r, threads)
	}))
	mux.HandleFunc("GET /normalize/still", handleNormalizeStill)
	mux.HandleFunc("POST /still", exclusive(handleStill))
	return mux
}

// A failure: the status and the code answered.
type failure struct {
	status int
	code   string
}

func (f *failure) Error() string { return f.code }

func fail(status int, code string) *failure { return &failure{status: status, code: code} }

func refuse(code refusal) *failure { return fail(http.StatusUnprocessableEntity, string(code)) }

func writeFailure(w http.ResponseWriter, f *failure) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Kopje-Error", f.code)
	w.WriteHeader(f.status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": f.code})
}

func exclusive(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
			h(w, r)
		default:
			writeFailure(w, fail(http.StatusTooManyRequests, "busy"))
		}
	}
}

// stageMs reads a stage time in milliseconds, within minStageMs..maxStageMs.
func stageMs(r *http.Request, name string) (time.Duration, bool) {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil || v < minStageMs || v > maxStageMs {
		return 0, false
	}
	return time.Duration(v) * time.Millisecond, true
}

// Stage times reported to the Worker in headers, for its measurements.
type timings struct {
	header http.Header
}

func (t timings) set(name string, start time.Time) {
	t.header.Set("Kopje-"+name+"-Ms", strconv.FormatInt(time.Since(start).Milliseconds(), 10))
}

func handleNormalize(w http.ResponseWriter, r *http.Request, threads threading) {
	probeTime, okProbe := stageMs(r, "probe_ms")
	encodeTime, okEncode := stageMs(r, "encode_ms")
	if !okProbe || !okEncode {
		writeFailure(w, fail(http.StatusBadRequest, "bad_request"))
		return
	}
	// The still of an earlier normalize is never answered for this one.
	_ = os.Remove(stillPath)
	dir, err := os.MkdirTemp(workRoot, "job-")
	if err != nil {
		writeFailure(w, fail(http.StatusInternalServerError, "internal"))
		return
	}
	defer os.RemoveAll(dir)
	t := timings{w.Header()}
	in := filepath.Join(dir, "input")

	start := time.Now()
	n, f := receive(r, in)
	t.set("Input", start)
	w.Header().Set("Kopje-Input-Bytes", strconv.FormatInt(n, 10))
	if f != nil {
		writeFailure(w, f)
		return
	}

	start = time.Now()
	p, f := probe(r.Context(), probeTime, in)
	t.set("Probe", start)
	if f != nil {
		writeFailure(w, f)
		return
	}
	pl, refused := planNormalize(p, float64(encodeTime.Milliseconds()))
	if refused != "" {
		writeFailure(w, refuse(refused))
		return
	}
	w.Header().Set("Kopje-Estimate-Ms", strconv.FormatInt(int64(pl.estimateMs), 10))

	encodeCtx, cancel := context.WithTimeout(r.Context(), encodeTime)
	defer cancel()
	start = time.Now()
	var out, contentType string
	var args []string
	if pl.kind == "video" {
		out, contentType = filepath.Join(dir, "output.mp4"), "video/mp4"
		args = videoArgs(pl, threads, in, out)
	} else {
		out, contentType = filepath.Join(dir, "output.mp3"), "audio/mpeg"
		args = audioArgs(pl, in, out)
	}
	cpu, err := runFFmpeg(encodeCtx, args)
	t.set("Encode", start)
	w.Header().Set("Kopje-Encode-Cpu-Ms", strconv.FormatInt(cpu.Milliseconds(), 10))
	if err != nil {
		writeFailure(w, ffmpegFailure(encodeCtx, "encode_failed"))
		return
	}
	if pl.kind == "video" {
		if _, err := stripMoovMetadata(out); err != nil {
			writeFailure(w, fail(http.StatusInternalServerError, "strip_failed"))
			return
		}
		// The still is best effort within the encode time left: a video without one is still an output.
		start = time.Now()
		w.Header().Set("Kopje-Still", strconv.FormatBool(makeStill(encodeCtx, pl, in)))
		t.set("Still", start)
	}
	serveFile(w, out, contentType, avOutputLimit, pl.kind)
}

func handleNormalizeStill(w http.ResponseWriter, _ *http.Request) {
	if _, err := os.Stat(stillPath); err != nil {
		writeFailure(w, fail(http.StatusNotFound, "no_still"))
		return
	}
	serveFile(w, stillPath, "image/png", stillOutputLimit, "")
}

func handleStill(w http.ResponseWriter, r *http.Request) {
	dir, err := os.MkdirTemp(workRoot, "job-")
	if err != nil {
		writeFailure(w, fail(http.StatusInternalServerError, "internal"))
		return
	}
	defer os.RemoveAll(dir)
	t := timings{w.Header()}
	in := filepath.Join(dir, "input")
	ctx, cancel := context.WithTimeout(r.Context(), stillTimeout)
	defer cancel()

	start := time.Now()
	n, f := receive(r, in)
	t.set("Input", start)
	w.Header().Set("Kopje-Input-Bytes", strconv.FormatInt(n, 10))
	if f != nil {
		writeFailure(w, f)
		return
	}
	start = time.Now()
	p, f := probe(ctx, stillTimeout, in)
	t.set("Probe", start)
	if f != nil {
		writeFailure(w, f)
		return
	}
	video, _ := selectStreams(p)
	if video == nil || video.CodecName == "" || video.Width <= 0 || video.Height <= 0 {
		writeFailure(w, refuse(refuseNoVideo))
		return
	}
	if video.Width*video.Height > maxSourcePixels {
		writeFailure(w, refuse(refusePixels))
		return
	}
	out := filepath.Join(dir, "still.png")
	start = time.Now()
	_, err = runFFmpeg(ctx, stillArgs(video.Index, isHDR(video), stillSeek(boundedDuration(p, video)), in, out))
	t.set("Encode", start)
	if err != nil {
		writeFailure(w, ffmpegFailure(ctx, "still_failed"))
		return
	}
	serveFile(w, out, "image/png", stillOutputLimit, "")
}

// makeStill writes the video's still to stillPath, where GET /normalize/still finds it until the process ends.
func makeStill(ctx context.Context, pl *plan, in string) bool {
	tmp := stillPath + ".tmp"
	defer os.Remove(tmp)
	if _, err := runFFmpeg(ctx, stillArgs(pl.videoIndex, pl.hdr, stillSeek(pl.duration), in, tmp)); err != nil {
		return false
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() == 0 || st.Size() > stillOutputLimit {
		return false
	}
	return os.Rename(tmp, stillPath) == nil
}

func ffmpegFailure(ctx context.Context, code string) *failure {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fail(http.StatusGatewayTimeout, "timeout")
	}
	return fail(http.StatusInternalServerError, code)
}

func serveFile(w http.ResponseWriter, path, contentType string, limit int64, kind string) {
	f, err := os.Open(path)
	if err != nil {
		writeFailure(w, fail(http.StatusInternalServerError, "no_output"))
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		writeFailure(w, fail(http.StatusInternalServerError, "no_output"))
		return
	}
	if st.Size() > limit {
		writeFailure(w, fail(http.StatusInternalServerError, "output_size"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	if kind != "" {
		h.Set("Kopje-Kind", kind)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// receive writes the request body to path, refusing an empty one, more than avUploadLimit bytes, or fewer than its
// Content-Length declared.
func receive(r *http.Request, path string) (int64, *failure) {
	if r.ContentLength > avUploadLimit {
		return 0, fail(http.StatusRequestEntityTooLarge, "too_large")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, fail(http.StatusInternalServerError, "internal")
	}
	defer f.Close()
	n, err := io.Copy(f, io.LimitReader(r.Body, avUploadLimit+1))
	switch {
	case n > avUploadLimit:
		return n, fail(http.StatusRequestEntityTooLarge, "too_large")
	case err != nil, r.ContentLength >= 0 && n != r.ContentLength:
		return n, fail(http.StatusBadRequest, "truncated")
	case n == 0:
		return 0, fail(http.StatusBadRequest, "empty")
	}
	if err := f.Close(); err != nil {
		return n, fail(http.StatusInternalServerError, "internal")
	}
	return n, nil
}

func probe(ctx context.Context, limit time.Duration, path string) (*probeResult, *failure) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, probeBin, probeArgs(path)...)
	killGroup(cmd)
	var stdout limitedBuffer
	stdout.limit = 1 << 20
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fail(http.StatusGatewayTimeout, "timeout")
		}
		return nil, refuse(refuseUnreadable)
	}
	var p probeResult
	if stdout.over || json.Unmarshal(stdout.buf, &p) != nil {
		return nil, refuse(refuseUnreadable)
	}
	if !allowedDemuxers[p.Format.FormatName] {
		return nil, refuse(refuseFormat)
	}
	return &p, nil
}

// runFFmpeg runs ffmpeg until it exits or ctx ends, when its whole process group is killed. It returns the CPU time
// ffmpeg used (user and system).
func runFFmpeg(ctx context.Context, args []string) (time.Duration, error) {
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	killGroup(cmd)
	err := cmd.Run()
	var cpu time.Duration
	if cmd.ProcessState != nil {
		cpu = cmd.ProcessState.UserTime() + cmd.ProcessState.SystemTime()
	}
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	return cpu, err
}

// killGroup runs the command in its own process group and kills the group when its context ends. Its stderr is
// discarded (nil), so no ffmpeg output reaches a response or a log.
func killGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
}

type limitedBuffer struct {
	buf   []byte
	limit int
	over  bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(b.buf)+len(p) > b.limit {
		b.over = true
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
