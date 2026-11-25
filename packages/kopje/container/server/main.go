// Command mediasrv is the media processor's HTTP server, run in Kopje's container image (#1828). It offers fixed
// operations on one input at a time, never a command line:
//
//	POST /normalize?work_ms=<ms>&still_ms=<ms>  input -> H.264/AAC MP4 or MP3, by its streams
//	GET  /normalize/still                       the PNG still the last video normalize made
//	POST /still                                 input video -> one PNG still, long edge <= 640
//	GET  /healthz                               readiness
//
// The input is the request body, written to the container's disk (an MP4 whose moov is at the end needs the whole
// file) up to AV_UPLOAD_LIMIT. The output is the response body with its Content-Length. A normalize has one work
// deadline, work_ms from the request's arrival, by which its response starts, and holds still_ms of it for a video's
// still. Each stage's cut is computed when the stage begins, from the time then left (#1828 PR4 plan, P8): the probe's
// at the end of the input, the encode's after the probe (the envelope check uses that time), both before the still's
// reserve, and the still in its own context within its reserve. A stage past its cut is killed (ffmpeg's process group
// SIGKILLed) and answers timeout; /still ends at stillTimeout. ffmpeg reads
// only local files of the allowed demuxers. A failure answers a code (an "error" field and the Kopje-Error header),
// never ffmpeg's output. The container has no network: Kopje starts it with Internet access disabled.
//
// Every answer with a JSON code is an outcome of that input, a 500 (encode_failed, strip_failed, still_failed,
// no_output, output_size) included: the input could not be processed. Only no answer, a failed connection or an answer
// outside this contract means the processor is unavailable. A 422 is a refusal of the input: its limits, its format,
// a frame the decoder dropped over the pixel limit (pixels, whatever the output, as A5 of #1828 PR2 decides: an
// oversizeMarkers diagnostic on the encode's stderr), or an output shorter than the plan (truncated; checkOutput).
// The limit of A5: a decoder that drops an oversized later frame without a diagnostic recognised here can leave a
// shorter video track, published when the longest stream still passes checkOutput's duration check. That affects only
// the uploader's own over-limit file, never another user's data, and its cost stays bounded by -max_pixels.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
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
	// Bounds on the work deadline and the still's reserve a request may pass.
	minWorkMs  = 100
	maxWorkMs  = 60 * 60 * 1000
	maxStillMs = 60 * 1000
)

var (
	// The socket deadlines of a normalize's request body and of its response: a peer that stops sending or reading ends
	// the job instead of holding the server's one job slot. They are absolute, not idle: a steady transfer slower than
	// 0.75 MiB/s in (AV_UPLOAD_LIMIT, 90 MiB) or 0.52 MiB/s out (AV_OUTPUT_LIMIT, 63 MiB) is cut at them. The Durable
	// Object streams the input from R2 and the output into R2 inside Cloudflare's network (P27 measures that rate).
	inputTimeout  = 120 * time.Second
	outputTimeout = 120 * time.Second
	// The whole of a /still, from its request to the end of its response: its body (a socket deadline at the same
	// instant), the probe, the frame and the answer all end by then, so an upload of AV_UPLOAD_LIMIT must arrive faster
	// than 1.5 MiB/s.
	stillTimeout = 60 * time.Second
	workRoot     = envOr("MEDIASRV_WORK", "/tmp/work")
	stillPath    = filepath.Join(workRoot, "normalize-still.png")
	ffmpegBin    = envOr("FFMPEG", "/usr/local/bin/ffmpeg")
	probeBin     = envOr("FFPROBE", "/usr/local/bin/ffprobe")
	bootID       = newID()
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
		IdleTimeout:       60 * time.Second,
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

// The version of the protocol this server speaks, which /healthz answers and the Worker requires
// (src/media-processor.ts NORMALIZE_PROTOCOL): 2 is /normalize's one work deadline (work_ms, still_ms). The image before
// it, which took probe_ms and encode_ms, answers no version.
const normalizeProtocol = 2

// The server's routes. A request for any other path or method answers a code, as every failure does.
func newMux(threads threading) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "bootId": bootID, "protocol": normalizeProtocol})
	})
	mux.HandleFunc("POST /normalize", exclusive(func(w http.ResponseWriter, r *http.Request) {
		handleNormalize(w, r, threads)
	}))
	mux.HandleFunc("GET /normalize/still", handleNormalizeStill)
	mux.HandleFunc("POST /still", exclusive(handleStill))
	// Only the exact paths reach the mux (it would redirect a path it cleans, such as //healthz, with an HTML body);
	// anything else answers a code.
	methods := map[string]string{"/healthz": "GET", "/normalize": "POST", "/normalize/still": "GET", "/still": "POST"}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, ok := methods[r.URL.Path]
		switch {
		case !ok:
			writeFailure(w, fail(http.StatusNotFound, "not_found"))
		case r.Method != method && (method != "GET" || r.Method != "HEAD"):
			w.Header().Set("Allow", method)
			writeFailure(w, fail(http.StatusMethodNotAllowed, "method_not_allowed"))
		default:
			mux.ServeHTTP(w, r)
		}
	})
}

// deadlines sets the socket deadlines of a job's request: reading its body by `read`, and writing its response by
// what `write` answers when the response starts (setWrite). A server without them (a test's recorder) runs without.
func deadlines(w http.ResponseWriter, read time.Time, write func() time.Time) (setWrite func()) {
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(read)
	return func() { _ = rc.SetWriteDeadline(write()) }
}

// normalizeDeadlines: the body by inputTimeout from now and by `by`, the response by outputTimeout from its start.
func normalizeDeadlines(w http.ResponseWriter, by time.Time) (setWrite func()) {
	read := time.Now().Add(inputTimeout)
	if by.Before(read) {
		read = by
	}
	return deadlines(w, read, func() time.Time { return time.Now().Add(outputTimeout) })
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

// workTimes reads a normalize's work deadline and its still's reserve, in milliseconds: work_ms within
// minWorkMs..maxWorkMs, still_ms within 0..maxStillMs and shorter than work_ms.
func workTimes(r *http.Request) (work, still time.Duration, ok bool) {
	w, errWork := strconv.Atoi(r.URL.Query().Get("work_ms"))
	s, errStill := strconv.Atoi(r.URL.Query().Get("still_ms"))
	if errWork != nil || errStill != nil || w < minWorkMs || w > maxWorkMs || s < 0 || s > maxStillMs || s >= w {
		return 0, 0, false
	}
	return time.Duration(w) * time.Millisecond, time.Duration(s) * time.Millisecond, true
}

// Stage times reported to the Worker in headers, for its measurements.
type timings struct {
	header http.Header
}

func (t timings) set(name string, start time.Time) {
	t.header.Set("Kopje-"+name+"-Ms", strconv.FormatInt(time.Since(start).Milliseconds(), 10))
}

func handleNormalize(w http.ResponseWriter, r *http.Request, threads threading) {
	arrival := time.Now()
	// The still of an earlier normalize is never answered after this one, refused or not.
	_ = os.Remove(stillPath)
	work, stillReserve, ok := workTimes(r)
	if !ok {
		normalizeDeadlines(w, arrival.Add(inputTimeout))
		writeFailure(w, fail(http.StatusBadRequest, "bad_request"))
		return
	}
	end := arrival.Add(work)
	// The probe and the encode end before the still's reserve.
	workEnd := end.Add(-stillReserve)
	setWrite := normalizeDeadlines(w, end)
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

	// The probe's cut, at the end of the input: one for every probe call, the header probe and, once the limits passed,
	// the frame probe.
	start = time.Now()
	probeCtx, cancelProbe := context.WithDeadline(r.Context(), workEnd)
	defer cancelProbe()
	p, f := probe(probeCtx, in)
	if f != nil {
		t.set("Probe", start)
		writeFailure(w, f)
		return
	}
	// The encode's cut, after the probe: the time left before the still's reserve, which a video holds and audio does
	// not. The estimate must fit it.
	encodeEnd := workEnd
	video, audio := selectStreams(p)
	if video == nil {
		encodeEnd = end
	}
	pl, refused := planStreams(p, video, audio, float64(time.Until(encodeEnd).Milliseconds()))
	if refused != "" {
		t.set("Probe", start)
		writeFailure(w, refuse(refused))
		return
	}
	w.Header().Set("Kopje-Estimate-Ms", strconv.FormatInt(int64(pl.estimateMs), 10))
	// The plan's duration, which the Worker's verifier holds the output to (short_output).
	w.Header().Set("Kopje-Duration-Ms", strconv.FormatInt(int64(math.Round(pl.duration*1000)), 10))
	if pl.kind == "video" && !pl.icc {
		pl.icc = frameICC(probeCtx, in, pl.videoIndex)
	}
	t.set("Probe", start)

	encodeCtx, cancel := context.WithDeadline(r.Context(), encodeEnd)
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
	run, err := runEncode(encodeCtx, args)
	if err != nil && !run.oversized && pl.kind == "video" && (pl.icc || pl.primaries || pl.transfer) && encodeCtx.Err() == nil {
		// A profile iccdetect cannot use, or tags zscale still cannot convert from (the matrix supplied by matrixFor):
		// the last resort encodes the video as before, with no conversion and its profile dropped, under the BT.709
		// label. That is a colour-rendering detail, not a content one (design section 6, residual 5).
		pl.icc, pl.primaries, pl.transfer = false, false, false
		var more encodeRun
		more, err = runEncode(encodeCtx, videoArgs(pl, threads, in, out))
		run = encodeRun{cpu: run.cpu + more.cpu, oversized: more.oversized}
	}
	t.set("Encode", start)
	w.Header().Set("Kopje-Encode-Cpu-Ms", strconv.FormatInt(run.cpu.Milliseconds(), 10))
	// A frame dropped over the pixel limit refuses the input whatever the output, before the output is rewritten or
	// probed; an expired deadline answers its timeout first.
	if run.oversized {
		if encodeCtx.Err() != nil {
			writeFailure(w, ffmpegFailure(encodeCtx, "encode_failed"))
		} else {
			writeFailure(w, refuse(refusePixels))
		}
		return
	}
	if err != nil {
		writeFailure(w, ffmpegFailure(encodeCtx, "encode_failed"))
		return
	}
	if pl.kind == "video" {
		if _, err := stripMoovMetadata(out); err != nil {
			writeFailure(w, fail(http.StatusInternalServerError, "strip_failed"))
			return
		}
	}
	if f := checkOutput(encodeCtx, p, pl, out); f != nil {
		writeFailure(w, f)
		return
	}
	if pl.kind == "video" {
		// The still is best effort in its own context, within its reserve and the work deadline: a video without one is
		// still an output.
		start = time.Now()
		stillEnd := start.Add(stillReserve)
		if end.Before(stillEnd) {
			stillEnd = end
		}
		stillCtx, cancelStill := context.WithDeadline(r.Context(), stillEnd)
		w.Header().Set("Kopje-Still", strconv.FormatBool(makeStill(stillCtx, pl, in)))
		cancelStill()
		t.set("Still", start)
	}
	// The response starts by the work deadline, or not at all.
	if !time.Now().Before(end) {
		writeFailure(w, fail(http.StatusGatewayTimeout, "timeout"))
		return
	}
	setWrite()
	serveFile(w, out, contentType, avOutputLimit, pl.kind)
}

func handleNormalizeStill(w http.ResponseWriter, _ *http.Request) {
	if _, err := os.Stat(stillPath); err != nil {
		writeFailure(w, fail(http.StatusNotFound, "no_still"))
		return
	}
	normalizeDeadlines(w, time.Now().Add(inputTimeout))()
	serveFile(w, stillPath, "image/png", stillOutputLimit, "")
}

func handleStill(w http.ResponseWriter, r *http.Request) {
	// One deadline for the whole job: the body, the work and the response.
	job := time.Now().Add(stillTimeout)
	setWrite := deadlines(w, job, func() time.Time { return job })
	dir, err := os.MkdirTemp(workRoot, "job-")
	if err != nil {
		writeFailure(w, fail(http.StatusInternalServerError, "internal"))
		return
	}
	defer os.RemoveAll(dir)
	t := timings{w.Header()}
	in := filepath.Join(dir, "input")
	ctx, cancel := context.WithDeadline(r.Context(), job)
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
	p, f := probe(ctx, in)
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
	icc := streamICC(video) || frameICC(ctx, in, video.Index)
	err = runStill(ctx, video.Index, isHDR(video), icc, stillSeek(boundedDuration(p, video)), in, out)
	t.set("Encode", start)
	// A still that cannot be stripped is still_failed, as before the start and kill failures were told apart.
	if err == nil && stripPNG(out) != nil {
		writeFailure(w, ffmpegFailure(ctx, "still_failed"))
		return
	}
	// No frame at the seek nor at 0 from an input ffmpeg read without failing: the input has no still to give.
	if errors.Is(err, errNoFrame) && ctx.Err() == nil {
		writeFailure(w, refuse(refuseNoFrame))
		return
	}
	if err != nil {
		// ffmpeg exiting with a status is about the input; one that did not start, was killed by the host, or whose
		// output could not be read back is the container's.
		code := "still_failed"
		if !exitedWithStatus(err) {
			code = "internal"
		}
		writeFailure(w, ffmpegFailure(ctx, code))
		return
	}
	setWrite()
	serveFile(w, out, "image/png", stillOutputLimit, "")
}

// makeStill writes the video's still to stillPath, where GET /normalize/still finds it until the process ends.
func makeStill(ctx context.Context, pl *plan, in string) bool {
	tmp := stillPath + ".tmp"
	defer os.Remove(tmp)
	if runStill(ctx, pl.videoIndex, pl.hdr, pl.icc, stillSeek(pl.duration), in, tmp) != nil {
		return false
	}
	if stripPNG(tmp) != nil {
		return false
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() == 0 || st.Size() > stillOutputLimit {
		return false
	}
	return os.Rename(tmp, stillPath) == nil
}

// runStill writes the still, reading the frame's ICC profile when it has one, and runs again without it when ffmpeg
// exits with a status then (a profile iccdetect cannot use): the still is made as before, its profile dropped. Any
// other failure (ffmpeg not starting or killed, an output that cannot be read back) is returned as it is, so a later
// attempt cannot turn it into no frame.
//
// ffmpeg can succeed with no frame written: with another stream in the file, the seek can land past the video's only
// keyframe. The still is then taken at 0.
func runStill(ctx context.Context, videoIndex int, hdr, icc bool, seek float64, in, out string) error {
	attempt := func(icc bool) error {
		err := writeStill(ctx, stillArgs(videoIndex, hdr, icc, seek, in, out), out)
		if errors.Is(err, errNoFrame) && seek > 0 && ctx.Err() == nil {
			err = writeStill(ctx, stillArgs(videoIndex, hdr, icc, 0, in, out), out)
		}
		return err
	}
	err := attempt(icc)
	if exitedWithStatus(err) && icc && ctx.Err() == nil {
		err = attempt(false)
	}
	return err
}

var errNoFrame = errors.New("no frame written")

// statOutput reads an output's size (a variable so a test can fail it as the filesystem can).
var statOutput = os.Stat

// writeStill runs one still. errNoFrame only when ffmpeg succeeded and its output is absent or empty; an output that
// cannot be read back (an I/O error) is that error, which is not the input's.
func writeStill(ctx context.Context, args []string, out string) error {
	_ = os.Remove(out)
	if _, err := runFFmpeg(ctx, args); err != nil {
		return err
	}
	st, err := statOutput(out)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && st.Size() == 0) {
		return errNoFrame
	}
	return err
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

// receive writes the request body to path, refusing an empty one, more than avUploadLimit bytes, fewer than its
// Content-Length declared, or one still arriving at the read deadline.
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
	case errors.Is(err, os.ErrDeadlineExceeded):
		return n, fail(http.StatusRequestTimeout, "input_timeout")
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

// probe reads the input's streams and format from its headers, decoding nothing (probeArgs). Only when the headers
// leave a limit unknown (limitsUnknown: no duration, as a raw ADTS AAC; a video with no dimensions or frame rate) or
// the video's colour unknown (colourUnknown: no colr box) does it read again with stream discovery, which may decode,
// within the decoder's pixel limit and the same budget; the limits are checked on the answer as on any other. A
// discovery run only for the colour that fails other than by the budget (a frame over the pixel limit, say) leaves the
// header probe's answer, untagged: the encode then meets that frame and refuses the input as it would have.
func probe(ctx context.Context, path string) (*probeResult, *failure) {
	p, f := runProbe(ctx, probeArgs(path, false))
	if f != nil || (!limitsUnknown(p) && !colourUnknown(p)) {
		return p, f
	}
	found, f := runProbe(ctx, probeArgs(path, true))
	if f != nil && !limitsUnknown(p) && f.code != "timeout" {
		return p, nil
	}
	return found, f
}

func runProbe(ctx context.Context, args []string) (*probeResult, *failure) {
	cmd := exec.CommandContext(ctx, probeBin, args...)
	killGroup(cmd)
	var stdout limitedBuffer
	stdout.limit = 1 << 20
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fail(http.StatusGatewayTimeout, "timeout")
		}
		// Only ffprobe exiting with a status is about the input; one that did not start, or that the host killed, is not.
		if !exitedWithStatus(err) {
			return nil, fail(http.StatusInternalServerError, "internal")
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

// exitedWithStatus reports whether a command's error is the process exiting with a non-zero status: it started and
// ran to its own end. Not starting (a missing binary, no resources) and a signal from outside (the host's OOM killer;
// the job's own kill comes with its context's end, which callers check first) are not.
func exitedWithStatus(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.Exited()
}

// frameICC runs the frame probe, after the header probe's limits passed: whether the stream at index has an ICC
// profile on its first frame. A probe that fails or times out answers false (the still and the encode run without
// the profile then, as for a frame without one).
func frameICC(ctx context.Context, path string, index int) bool {
	cmd := exec.CommandContext(ctx, probeBin, frameProbeArgs(path, index)...)
	killGroup(cmd)
	var stdout limitedBuffer
	stdout.limit = 1 << 20
	cmd.Stdout = &stdout
	if cmd.Run() != nil || stdout.over {
		return false
	}
	return framesICC(stdout.buf, index)
}

// checkOutput refuses a short output (A5 of #1828 PR2) as truncated: a mapped source stream missing from the output,
// a mapped output stream short of its source stream's own declared duration, or the longest mapped output stream short
// of the plan's duration (boundedDuration). A stream without a declared duration of its own (a WebM's) is held only
// through that longest stream. Short means by more than a second or by more than 10 %. A probe that fails to read the
// output is the encode's failure.
func checkOutput(ctx context.Context, p *probeResult, pl *plan, out string) *failure {
	got, f := probe(ctx, out)
	if f != nil {
		return ffmpegFailure(ctx, "encode_failed")
	}
	short := func(planned, have float64) bool {
		return planned-have > 1 || planned-have > planned*0.1
	}
	video, audio := selectStreams(p)
	var outVideo, outAudio *probeStream
	for i := range got.Streams {
		s := &got.Streams[i]
		switch {
		case s.CodecType == "video" && outVideo == nil:
			outVideo = s
		case s.CodecType == "audio" && outAudio == nil:
			outAudio = s
		}
	}
	var pairs [][2]*probeStream
	if audio != nil && (pl.kind != "video" || pl.audioIndex >= 0) {
		pairs = append(pairs, [2]*probeStream{audio, outAudio})
	}
	if pl.kind == "video" && video != nil {
		pairs = append(pairs, [2]*probeStream{video, outVideo})
	}
	longest := 0.0
	for _, pair := range pairs {
		source, output := pair[0], pair[1]
		if output == nil {
			return refuse(refuseTruncated)
		}
		have := parsePositive(output.Duration)
		longest = math.Max(longest, have)
		if own := parsePositive(source.Duration); own > 0 && short(own, have) {
			return refuse(refuseTruncated)
		}
	}
	if short(pl.duration, longest) {
		return refuse(refuseTruncated)
	}
	return nil
}

// An encode's CPU time (user and system) and whether the decoder refused a frame over the pixel limit.
type encodeRun struct {
	cpu       time.Duration
	oversized bool
}

// oversizeMarkers match what the pinned ffmpeg prints when -max_pixels refuses a frame: its image utilities' (imgutils.c,
// the native decoders) and libdav1d's frame size diagnostic, which takes max_pixels as its limit ("Frame size WxH exceeds
// limit N", obu.c). Only that diagnostic: the AAC decoder's "Number of bands (…) exceeds limit (…)" is an audio error.
var oversizeMarkers = []*regexp.Regexp{
	regexp.MustCompile(`exceeds specified max pixel count`),
	regexp.MustCompile(`Frame size [0-9]+x[0-9]+ exceeds limit`),
}

// markerSpan bounds a marker's match (the dav1d diagnostic's numbers are at most 10 digits each): the bytes markerWriter
// keeps from one write to the next, so a marker split across writes is matched.
const markerSpan = 128

// markerWriter records whether a stream of bytes matches any of oversizeMarkers, keeping only the last markerSpan-1
// bytes: ffmpeg's stderr is scanned for them, never stored, answered or logged.
type markerWriter struct {
	tail  []byte
	found bool
}

func (m *markerWriter) Write(p []byte) (int, error) {
	if !m.found {
		window := append(m.tail, p...)
		for _, marker := range oversizeMarkers {
			m.found = m.found || marker.Match(window)
		}
		keep := min(len(window), markerSpan-1)
		m.tail = append(m.tail[:0], window[len(window)-keep:]...)
	}
	return len(p), nil
}

// runEncode runs an encode as runFFmpeg does, watching its stderr for the pixel limit's refusal.
func runEncode(ctx context.Context, args []string) (encodeRun, error) {
	watch := &markerWriter{}
	cpu, err := runFFmpegTo(ctx, args, watch)
	return encodeRun{cpu: cpu, oversized: watch.found}, err
}

// runFFmpeg runs ffmpeg until it exits or ctx ends, when its whole process group is killed. It returns the CPU time
// ffmpeg used (user and system).
func runFFmpeg(ctx context.Context, args []string) (time.Duration, error) {
	return runFFmpegTo(ctx, args, nil)
}

func runFFmpegTo(ctx context.Context, args []string, stderr io.Writer) (time.Duration, error) {
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	killGroup(cmd)
	cmd.Stderr = stderr
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
// discarded unless a caller scans it (runEncode), so no ffmpeg output reaches a response or a log.
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
