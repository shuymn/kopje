package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The fake ffprobe appends its arguments to $FAKE_PROBE_LOG and prints the probe JSON in the file $FAKE_PROBE (for the
// header probe, $FAKE_HEADERS when set; for the frame probe, $FAKE_FRAMES; for a probe of the output,
// $FAKE_OUTPUT_PROBE when set), sleeping $FAKE_PROBE_SLEEP (frame probe:
// $FAKE_FRAME_SLEEP) seconds first, or killing itself when $FAKE_PROBE_KILL is set. The fake ffmpeg appends its arguments to $FAKE_LOG, fails when they contain
// $FAKE_FAIL_ON (printing the pixel limit's refusal first when $FAKE_OVERSIZE is set), succeeds writing nothing when they contain $FAKE_EMPTY_ON, copies the file $FAKE_OUT (for a PNG
// still, $FAKE_PNG) to its last argument (file:<path>), prints a marker on stderr, and exits $FAKE_EXIT (sleeping
// $FAKE_SLEEP seconds first).
const fakeProbe = `#!/bin/sh
echo "SECRET-PROBE-STDERR" >&2
[ -n "$FAKE_PROBE_LOG" ] && echo "$*" >> "$FAKE_PROBE_LOG"
case "$*" in *output.*) [ -n "$FAKE_OUTPUT_PROBE" ] && { cat "$FAKE_OUTPUT_PROBE"; exit 0; } ;; esac
case "$*" in *-show_frames*) [ -n "$FAKE_FRAME_SLEEP" ] && sleep "$FAKE_FRAME_SLEEP"; cat "${FAKE_FRAMES:-/dev/null}"; exit 0 ;; esac
[ -n "$FAKE_PROBE_KILL" ] && kill -KILL $$
[ -n "$FAKE_PROBE_SLEEP" ] && sleep "$FAKE_PROBE_SLEEP"
case "$*" in *-nofind_stream_info*) ;; */input) [ -n "$FAKE_DISCOVERY_FAIL" ] && exit 1 ;; esac
case "$*" in *-nofind_stream_info*) [ -n "$FAKE_HEADERS" ] && { cat "$FAKE_HEADERS"; exit 0; } ;; esac
cat "$FAKE_PROBE"
`

const fakeFFmpeg = `#!/bin/sh
echo "SECRET-FFMPEG-STDERR" >&2
[ -n "$FAKE_LOG" ] && echo "$*" >> "$FAKE_LOG"
[ -n "$FAKE_FFMPEG_KILL" ] && case "$*" in *"$FAKE_FFMPEG_KILL"*) kill -KILL $$ ;; esac
case "$FAKE_OVERSIZE" in
  dav1d) echo "[libdav1d @ 0x1] Frame size 4096x2160 exceeds limit 8294400" >&2 ;;
  ?*) echo "[IMGUTILS @ 0x1] Picture size 4096x2160 exceeds specified max pixel count 8294400" >&2 ;;
esac
[ -n "$FAKE_FAIL_ON" ] && case "$*" in *"$FAKE_FAIL_ON"*) exit 1 ;; esac
[ -n "$FAKE_EMPTY_ON" ] && case "$*" in *"$FAKE_EMPTY_ON"*) exit 0 ;; esac
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
for last; do :; done
case "$*" in *"-c:v png"*) src="$FAKE_PNG" ;; *) src="$FAKE_OUT" ;; esac
cat "$src" > "${last#file:}"
exit "${FAKE_EXIT:-0}"
`

func fakeTools(t *testing.T, probe *probeResult) {
	t.Helper()
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	encoded, err := json.Marshal(probe)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_PROBE", write("probe.json", string(encoded)))
	t.Setenv("FAKE_OUT", write("output", "OUTPUT"))
	t.Setenv("FAKE_PNG", write("still.png", string(seededPNG(t))))
	t.Setenv("FAKE_EXIT", "0")
	t.Setenv("FAKE_SLEEP", "")
	t.Setenv("FAKE_LOG", "")
	t.Setenv("FAKE_FAIL_ON", "")
	t.Setenv("FAKE_EMPTY_ON", "")
	t.Setenv("FAKE_PROBE_LOG", "")
	t.Setenv("FAKE_FRAMES", "")
	t.Setenv("FAKE_HEADERS", "")
	t.Setenv("FAKE_PROBE_SLEEP", "")
	t.Setenv("FAKE_FRAME_SLEEP", "")
	t.Setenv("FAKE_OUTPUT_PROBE", "")
	t.Setenv("FAKE_OVERSIZE", "")
	t.Setenv("FAKE_DISCOVERY_FAIL", "")
	t.Setenv("FAKE_PROBE_KILL", "")
	t.Setenv("FAKE_FFMPEG_KILL", "")
	oldProbe, oldFF, oldWork, oldStill := probeBin, ffmpegBin, workRoot, stillPath
	probeBin, ffmpegBin = write("ffprobe", fakeProbe), write("ffmpeg", fakeFFmpeg)
	workRoot = filepath.Join(dir, "work")
	stillPath = filepath.Join(workRoot, "normalize-still.png")
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { probeBin, ffmpegBin, workRoot, stillPath = oldProbe, oldFF, oldWork, oldStill })
}

// A video output goes through the strip step, which needs a real box layout.
func fakeMP4(t *testing.T) string {
	file, _ := faststart(func(d int) []uint32 { return []uint32{uint32(d)} }, true)
	path := filepath.Join(t.TempDir(), "output.mp4")
	if err := os.WriteFile(path, file, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func do(t *testing.T, h http.Handler, method, target string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func videoProbe() *probeResult {
	return probeOf("2", stream("video", "h264", 320, 240, "15/1", "2"), stream("audio", "aac", 0, 0, "0/0", "2"))
}

const normalizeURL = "/normalize?probe_ms=5000&encode_ms=60000"

func TestNormalizeAnswersTheOutputAndKeepsTheStill(t *testing.T) {
	fakeTools(t, videoProbe())
	t.Setenv("FAKE_OUT", fakeMP4(t))
	mux := newMux(threadsDefault)
	rec := do(t, mux, "POST", normalizeURL, []byte("input"))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "video/mp4" || rec.Header().Get("Kopje-Kind") != "video" ||
		rec.Header().Get("Kopje-Still") != "true" {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
	// The plan's duration, for the Worker's verifier.
	if rec.Header().Get("Kopje-Duration-Ms") != "2000" {
		t.Fatalf("Kopje-Duration-Ms %q", rec.Header().Get("Kopje-Duration-Ms"))
	}
	if rec.Header().Get("Content-Length") != itoa(rec.Body.Len()) || bytes.Contains(rec.Body.Bytes(), []byte("udta")) {
		t.Fatalf("body %d bytes, Content-Length %s", rec.Body.Len(), rec.Header().Get("Content-Length"))
	}
	still := do(t, mux, "GET", "/normalize/still", nil)
	if still.Code != 200 || still.Header().Get("Content-Type") != "image/png" || still.Body.Len() == 0 {
		t.Fatalf("still %d", still.Code)
	}
	// A later normalize never answers the earlier one's still.
	encoded, err := json.Marshal(probeOf("2", stream("audio", "aac", 0, 0, "0/0", "2")))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("FAKE_PROBE"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_OUT", filepath.Join(filepath.Dir(os.Getenv("FAKE_PROBE")), "output"))
	audio := do(t, mux, "POST", normalizeURL, []byte("input"))
	if audio.Code != 200 || audio.Header().Get("Content-Type") != "audio/mpeg" || audio.Body.String() != "OUTPUT" {
		t.Fatalf("audio %d %q", audio.Code, audio.Body.String())
	}
	if gone := do(t, mux, "GET", "/normalize/still", nil); gone.Code != 404 {
		t.Fatalf("still after audio: %d", gone.Code)
	}
}

func TestFailuresAnswerCodesOnly(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(t *testing.T)
		target string
		body   []byte
		status int
		code   string
	}{
		{"stage times missing", func(t *testing.T) { fakeTools(t, videoProbe()) }, "/normalize", []byte("x"), 400,
			"bad_request"},
		{"stage time out of range", func(t *testing.T) { fakeTools(t, videoProbe()) },
			"/normalize?probe_ms=99&encode_ms=60000", []byte("x"), 400, "bad_request"},
		{"empty input", func(t *testing.T) { fakeTools(t, videoProbe()) }, normalizeURL, nil, 400, "empty"},
		{"format not allowed", func(t *testing.T) {
			p := videoProbe()
			p.Format.FormatName = "image2"
			fakeTools(t, p)
		}, normalizeURL, []byte("x"), 422, "format"},
		{"unreadable", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_PROBE", "/nonexistent")
		}, normalizeURL, []byte("x"), 422, "unreadable"},
		{"outside the envelope", func(t *testing.T) { fakeTools(t, videoProbe()) },
			"/normalize?probe_ms=5000&encode_ms=100", []byte("x"), 422, "envelope"},
		{"encoder fails", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_EXIT", "1")
		}, normalizeURL, []byte("x"), 500, "encode_failed"},
		{"encode passes its time", func(t *testing.T) {
			fakeTools(t, probeOf("2", stream("audio", "aac", 0, 0, "0/0", "2")))
			t.Setenv("FAKE_SLEEP", "3")
		}, "/normalize?probe_ms=5000&encode_ms=2500", []byte("x"), 504, "timeout"},
		{"still without video", func(t *testing.T) { fakeTools(t, probeOf("2", stream("audio", "aac", 0, 0, "0/0", "2"))) },
			"/still", []byte("x"), 422, "no_video"},
		// Not the input's: ffprobe that does not start, or that the host kills, is the container's failure.
		{"probe does not start", func(t *testing.T) {
			fakeTools(t, videoProbe())
			probeBin = filepath.Join(t.TempDir(), "missing")
		}, "/still", []byte("x"), 500, "internal"},
		{"probe killed", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_PROBE_KILL", "1")
		}, "/still", []byte("x"), 500, "internal"},
		// The input's: ffmpeg reads it and writes no frame, at the seek nor at 0.
		{"still with no frame", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_EMPTY_ON", "-c:v png")
		}, "/still", []byte("x"), 422, "no_frame"},
		{"still that ffmpeg fails", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_FAIL_ON", "-c:v png")
		}, "/still", []byte("x"), 500, "still_failed"},
		// Not the input's: ffmpeg that does not start, that the host kills, or whose output cannot be read back.
		{"still whose ffmpeg does not start", func(t *testing.T) {
			fakeTools(t, videoProbe())
			ffmpegBin = filepath.Join(t.TempDir(), "missing")
		}, "/still", []byte("x"), 500, "internal"},
		{"still whose ffmpeg is killed", func(t *testing.T) {
			fakeTools(t, videoProbe())
			t.Setenv("FAKE_FFMPEG_KILL", "-c:v png")
		}, "/still", []byte("x"), 500, "internal"},
		{"still whose output cannot be read back", func(t *testing.T) {
			fakeTools(t, videoProbe())
			old := statOutput
			statOutput = func(string) (os.FileInfo, error) { return nil, syscall.EIO }
			t.Cleanup(func() { statOutput = old })
		}, "/still", []byte("x"), 500, "internal"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.setup(t)
			rec := do(t, newMux(threadsDefault), "POST", c.target, c.body)
			body := rec.Body.String()
			if rec.Code != c.status || rec.Header().Get("Kopje-Error") != c.code || body != `{"error":"`+c.code+`"}`+"\n" {
				t.Fatalf("%d %q %q", rec.Code, rec.Header().Get("Kopje-Error"), body)
			}
			for _, v := range rec.Header() {
				if strings.Contains(strings.Join(v, ""), "SECRET") {
					t.Fatal("ffmpeg output in a header")
				}
			}
		})
	}
}

func TestReceiveRefusesTooLargeAndTruncatedInputs(t *testing.T) {
	path := func() string { return filepath.Join(t.TempDir(), "input") }
	declared := httptest.NewRequest("POST", "/", strings.NewReader("x"))
	declared.ContentLength = avUploadLimit + 1
	if _, f := receive(declared, path()); f == nil || f.code != "too_large" {
		t.Fatalf("declared over the cap: %v", f)
	}
	// An undeclared length is cut at the cap + 1 bytes read.
	over := httptest.NewRequest("POST", "/", io.LimitReader(zeros{}, avUploadLimit+10))
	over.ContentLength = -1
	if n, f := receive(over, path()); f == nil || f.code != "too_large" || n != avUploadLimit+1 {
		t.Fatalf("read over the cap: %d %v", n, f)
	}
	at := httptest.NewRequest("POST", "/", io.LimitReader(zeros{}, avUploadLimit))
	at.ContentLength = -1
	if n, f := receive(at, path()); f != nil || n != avUploadLimit {
		t.Fatalf("at the cap: %d %v", n, f)
	}
	short := httptest.NewRequest("POST", "/", strings.NewReader("abc"))
	short.ContentLength = 4
	if _, f := receive(short, path()); f == nil || f.code != "truncated" {
		t.Fatalf("truncated: %v", f)
	}
}

func TestOneJobAtATime(t *testing.T) {
	busy <- struct{}{}
	defer func() { <-busy }()
	for _, target := range []string{normalizeURL, "/still"} {
		if rec := do(t, newMux(threadsDefault), "POST", target, []byte("x")); rec.Code != 429 ||
			rec.Header().Get("Kopje-Error") != "busy" {
			t.Fatalf("%s: %d", target, rec.Code)
		}
	}
	if rec := do(t, newMux(threadsDefault), "GET", "/healthz", nil); rec.Code != 200 {
		t.Fatalf("healthz while busy: %d", rec.Code)
	}
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func pngChunk(typ string, data []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	out = append(append(out, typ...), data...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(append([]byte(typ), data...)))
}

// A PNG as the encoder writes it from a frame that carries metadata: an eXIf chunk with a camera make, and a tEXt
// comment, around a 2x2 image with a colour profile (the one the still's chain generates).
func seededPNG(t *testing.T) []byte {
	t.Helper()
	ihdr := binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32(nil, 2), 2)
	ihdr = append(ihdr, 8, 2, 0, 0, 0)
	return bytes.Join([][]byte{
		pngSignature,
		pngChunk("IHDR", ihdr),
		pngChunk("iCCP", []byte("icc\x00\x00generated")),
		pngChunk("sRGB", []byte{0}),
		pngChunk("eXIf", []byte("II*\x00\x08\x00\x00\x00KOPJEMARK_EXIF_MAKE")),
		pngChunk("tEXt", []byte("Comment\x00KOPJEMARK_TEXT")),
		pngChunk("IDAT", []byte("compressed pixels")),
		pngChunk("tIME", []byte{7, 232, 5, 1, 12, 0, 0}),
		pngChunk("IEND", nil),
	}, nil)
}

// The chunk types of a PNG, in order.
func pngChunks(t *testing.T, png []byte) []string {
	t.Helper()
	if !bytes.HasPrefix(png, pngSignature) {
		t.Fatalf("not a PNG: %q", png[:min(len(png), 16)])
	}
	var types []string
	for p := len(pngSignature); p+12 <= len(png); {
		n := int(binary.BigEndian.Uint32(png[p:]))
		types = append(types, string(png[p+4:p+8]))
		p += 12 + n
	}
	return types
}

// A frame's EXIF and text never reach a still, on either still path (the PNG encoder writes them back otherwise).
func TestStillsCarryNoFrameMetadata(t *testing.T) {
	fakeTools(t, videoProbe())
	t.Setenv("FAKE_OUT", fakeMP4(t))
	mux := newMux(threadsDefault)
	if rec := do(t, mux, "POST", normalizeURL, []byte("input")); rec.Code != 200 || rec.Header().Get("Kopje-Still") != "true" {
		t.Fatalf("normalize %d %v", rec.Code, rec.Header())
	}
	kept := do(t, mux, "GET", "/normalize/still", nil)
	direct := do(t, mux, "POST", "/still", []byte("input"))
	want := []string{"IHDR", "iCCP", "sRGB", "IDAT", "IEND"}
	for name, rec := range map[string]*httptest.ResponseRecorder{"normalize": kept, "still": direct} {
		if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" ||
			rec.Header().Get("Content-Length") != itoa(rec.Body.Len()) {
			t.Fatalf("%s: %d %v", name, rec.Code, rec.Header())
		}
		if got := pngChunks(t, rec.Body.Bytes()); !slices.Equal(got, want) || bytes.Contains(rec.Body.Bytes(), []byte("KOPJEMARK")) {
			t.Fatalf("%s: chunks %v", name, got)
		}
	}
}

func TestStrippedPNGRefusesMalformedFiles(t *testing.T) {
	good := seededPNG(t)
	if out, err := strippedPNG(good); err != nil || !bytes.HasSuffix(out, pngChunk("IEND", nil)) {
		t.Fatalf("good: %v", err)
	}
	badCRC := append([]byte{}, good...)
	badCRC[len(pngSignature)+20] ^= 1
	ihdrLen := 12 + 13
	notFirst := append(append([]byte{}, pngSignature...), good[len(pngSignature)+ihdrLen:]...)
	cases := map[string][]byte{
		"bad CRC":         badCRC,
		"no IEND":         good[:len(good)-12],
		"after IEND":      append(append([]byte{}, good...), 0),
		"IHDR not first":  notFirst,
		"not a PNG":       []byte("OUTPUT"),
		"length past end": append(append([]byte{}, pngSignature...), 0xff, 0xff, 0xff, 0xff, 'I', 'H', 'D', 'R', 0, 0, 0, 0),
	}
	for name, in := range cases {
		if _, err := strippedPNG(in); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

// A refused normalize also removes the still of the one before it.
func TestARefusedNormalizeRemovesTheEarlierStill(t *testing.T) {
	fakeTools(t, videoProbe())
	t.Setenv("FAKE_OUT", fakeMP4(t))
	mux := newMux(threadsDefault)
	if rec := do(t, mux, "POST", normalizeURL, []byte("input")); rec.Code != 200 {
		t.Fatalf("normalize %d", rec.Code)
	}
	if rec := do(t, mux, "POST", "/normalize?probe_ms=99&encode_ms=60000", []byte("input")); rec.Code != 400 {
		t.Fatalf("refused normalize %d", rec.Code)
	}
	if rec := do(t, mux, "GET", "/normalize/still", nil); rec.Code != 404 {
		t.Fatalf("still after a refused normalize: %d", rec.Code)
	}
}

func TestOtherRoutesAnswerCodes(t *testing.T) {
	mux := newMux(threadsDefault)
	for _, path := range []string{"/missing", "//healthz", "/healthz/", "/./healthz", "/normalize/../healthz"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.URL.Path = path
		missing := httptest.NewRecorder()
		mux.ServeHTTP(missing, r)
		if missing.Code != 404 || missing.Body.String() != `{"error":"not_found"}`+"\n" {
			t.Fatalf("%s: %d %q", path, missing.Code, missing.Body.String())
		}
	}
	wrong := do(t, mux, "POST", "/healthz", nil)
	if wrong.Code != 405 || wrong.Header().Get("Allow") != "GET" ||
		wrong.Body.String() != `{"error":"method_not_allowed"}`+"\n" {
		t.Fatalf("POST /healthz: %d %q", wrong.Code, wrong.Body.String())
	}
}

// A peer that stops sending its body, or stops reading the response, ends the job at the socket deadline and frees the
// job slot.
func TestStalledSocketsEndTheJob(t *testing.T) {
	fakeTools(t, probeOf("2", stream("audio", "aac", 0, 0, "0/0", "2")))
	big := filepath.Join(t.TempDir(), "big.mp3")
	if err := os.WriteFile(big, bytes.Repeat([]byte{0xff}, 48<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_OUT", big)
	oldIn, oldOut := inputTimeout, outputTimeout
	inputTimeout, outputTimeout = 300*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { inputTimeout, outputTimeout = oldIn, oldOut })
	srv := httptest.NewServer(newMux(threadsDefault))
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")
	slotFreed := func(within time.Duration) bool {
		for end := time.Now().Add(within); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
			if len(busy) == 0 {
				return true
			}
		}
		return false
	}

	// Ingress: one byte of the two declared, then nothing; normalize's body ends at inputTimeout.
	stalledBody := func(path string) {
		t.Helper()
		in, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		defer in.Close()
		if _, err := io.WriteString(in, "POST "+path+" HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nx"); err != nil {
			t.Fatal(err)
		}
		_ = in.SetReadDeadline(time.Now().Add(5 * time.Second))
		answer, _ := io.ReadAll(io.LimitReader(in, 4096))
		if !bytes.HasPrefix(answer, []byte("HTTP/1.1 408")) || !bytes.Contains(answer, []byte(`"input_timeout"`)) {
			t.Fatalf("%s stalled body: %q", path, answer)
		}
		if !slotFreed(2 * time.Second) {
			t.Fatalf("%s: job slot held after a stalled body", path)
		}
	}
	stalledBody(normalizeURL)

	// A /still's body ends with its job at stillTimeout, however long normalize's socket deadlines are.
	oldStill := stillTimeout
	inputTimeout, outputTimeout, stillTimeout = time.Minute, time.Minute, 300*time.Millisecond
	t.Cleanup(func() { stillTimeout = oldStill })
	stalledBody("/still")
	inputTimeout, outputTimeout = 300*time.Millisecond, 300*time.Millisecond

	// Egress: the whole request, then the response never read.
	out, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	if _, err := io.WriteString(out, "POST "+normalizeURL+" HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\nx"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if !slotFreed(5 * time.Second) {
		t.Fatal("job slot held by a peer that does not read")
	}
}

// A frame whose ICC profile iccdetect cannot use (a grayscale one) is encoded and stilled as before, its profile
// dropped, rather than failing.
func TestAnUnusableProfileFallsBackToDroppingIt(t *testing.T) {
	fakeTools(t, videoProbe())
	frames := filepath.Join(t.TempDir(), "frames.json")
	if err := os.WriteFile(frames, []byte(`{"frames":[{"stream_index":0,"side_data_list":[{"side_data_type":"ICC profile"}]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_FRAMES", frames)
	t.Setenv("FAKE_OUT", fakeMP4(t))
	t.Setenv("FAKE_FAIL_ON", "iccdetect")
	log := filepath.Join(t.TempDir(), "ffmpeg.log")
	t.Setenv("FAKE_LOG", log)
	mux := newMux(threadsDefault)
	if rec := do(t, mux, "POST", normalizeURL, []byte("input")); rec.Code != 200 || rec.Header().Get("Kopje-Still") != "true" {
		t.Fatalf("normalize %d %v", rec.Code, rec.Header())
	}
	if rec := do(t, mux, "POST", "/still", []byte("input")); rec.Code != 200 {
		t.Fatalf("still %d %v", rec.Code, rec.Header())
	}
	runs, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	// The encode and /still each tried with the profile, then without it; normalize's still, after its encode found
	// the profile unusable, without it at once.
	lines := strings.Split(strings.TrimSpace(string(runs)), "\n")
	want := []bool{true, false, false, true, false}
	if len(lines) != len(want) {
		t.Fatalf("runs: %q", lines)
	}
	for i, detect := range want {
		if strings.Contains(lines[i], "iccdetect") != detect || !detect && !strings.Contains(lines[i], iccDrop) {
			t.Fatalf("run %d (iccdetect %v): %q", i, detect, lines[i])
		}
	}
}

// Tags zscale cannot convert from (an unknown range, say) end in the encode as before, not a failure.
func TestUnconvertiblePrimariesFallBack(t *testing.T) {
	probe := videoProbe()
	probe.Streams[0].ColorPrimaries, probe.Streams[0].ColorTransfer = "smpte432", "bt709"
	fakeTools(t, probe)
	t.Setenv("FAKE_OUT", fakeMP4(t))
	t.Setenv("FAKE_FAIL_ON", toBT709)
	log := filepath.Join(t.TempDir(), "ffmpeg.log")
	t.Setenv("FAKE_LOG", log)
	if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != 200 {
		t.Fatalf("normalize %d %v", rec.Code, rec.Header())
	}
	runs, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(runs)), "\n")
	if len(lines) < 2 || !strings.Contains(lines[0], toBT709) || strings.Contains(lines[1], toBT709) {
		t.Fatalf("runs: %q", lines)
	}
	// A transfer zscale cannot convert from falls back the same way.
	probe = videoProbe()
	probe.Streams[0].ColorTransfer = "log100"
	fakeTools(t, probe)
	t.Setenv("FAKE_OUT", fakeMP4(t))
	t.Setenv("FAKE_FAIL_ON", trcToBT709)
	t.Setenv("FAKE_LOG", log)
	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != 200 {
		t.Fatalf("transfer normalize %d %v", rec.Code, rec.Header())
	}
	runs, _ = os.ReadFile(log)
	lines = strings.Split(strings.TrimSpace(string(runs)), "\n")
	if len(lines) < 2 || !strings.Contains(lines[0], trcToBT709) || strings.Contains(lines[1], trcToBT709) {
		t.Fatalf("transfer runs: %q", lines)
	}
}

// The header probe's limits come first: an input over maxSourcePixels is refused before any frame is decoded. One
// within them gets the frame probe, with the decoder's own pixel limit.
func TestTheFrameProbeRunsOnlyWithinTheLimits(t *testing.T) {
	for _, c := range []struct {
		name       string
		w, h, code int
		frames     bool
	}{{"oversized", 16384, 16384, 422, false}, {"within", 320, 240, 200, true}} {
		fakeTools(t, probeOf("2", stream("video", "hevc", c.w, c.h, "15/1", "2")))
		t.Setenv("FAKE_OUT", fakeMP4(t))
		log := filepath.Join(t.TempDir(), "ffprobe.log")
		t.Setenv("FAKE_PROBE_LOG", log)
		mux := newMux(threadsDefault)
		for _, path := range []string{normalizeURL, "/still"} {
			if rec := do(t, mux, "POST", path, []byte("input")); rec.Code != c.code ||
				c.code == 422 && rec.Header().Get("Kopje-Error") != "pixels" {
				t.Fatalf("%s %s: %d %q", c.name, path, rec.Code, rec.Body.String())
			}
		}
		runs, err := os.ReadFile(log)
		if err != nil {
			t.Fatal(err)
		}
		framed := 0
		for _, line := range strings.Split(strings.TrimSpace(string(runs)), "\n") {
			if strings.Contains(line, "-show_frames") {
				framed++
				if !strings.Contains(line, "-max_pixels "+itoa(maxSourcePixels)) {
					t.Fatalf("frame probe without a pixel limit: %q", line)
				}
			}
		}
		if (framed == 2) != c.frames || (framed != 0) != c.frames {
			t.Fatalf("%s: %d frame probes in %q", c.name, framed, runs)
		}
	}
}

// Headers that declare no duration (a raw ADTS AAC) are read again with stream discovery; otherwise the header probe
// is the only one before the limits.
func TestTheProbeDiscoversOnlyWithoutADeclaredDuration(t *testing.T) {
	fakeTools(t, probeOf("3", stream("audio", "aac", 0, 0, "0/0", "3")))
	headers := probeOf("", stream("audio", "aac", 0, 0, "0/0", ""))
	encoded, err := json.Marshal(headers)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "headers.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_HEADERS", path)
	log := filepath.Join(t.TempDir(), "ffprobe.log")
	t.Setenv("FAKE_PROBE_LOG", log)
	if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != 200 {
		t.Fatalf("normalize %d %q", rec.Code, rec.Body.String())
	}
	runs, _ := os.ReadFile(log)
	// The probes of the input (the output's own probe, checkOutput, follows them).
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(string(runs)), "\n") {
		if strings.HasSuffix(line, "/input") {
			lines = append(lines, line)
		}
	}
	if len(lines) != 2 || !strings.Contains(lines[0], "-nofind_stream_info") ||
		strings.Contains(lines[1], "-nofind_stream_info") || !strings.Contains(lines[1], "-max_pixels") {
		t.Fatalf("probes: %q", lines)
	}
}

// Headers that leave the video's dimensions or frame rate unknown (0) send the probe to discovery, and the limits apply
// to what discovery found: an input it still leaves unknown is refused, one over a limit is refused by that limit.
func TestUnknownVideoHeadersAreDiscoveredThenLimited(t *testing.T) {
	// A VFR clip's header: no r_frame_rate, an average under the limit.
	averageOnly := stream("video", "h264", 320, 240, "0/0", "2")
	averageOnly.AvgFrameRate = "98/1"
	cases := []struct {
		name               string
		header, discovered probeStream
		code               int
		refusal            string
	}{
		{"no dimensions", stream("video", "h264", 0, 0, "15/1", "2"), stream("video", "h264", 320, 240, "15/1", "2"), 200, ""},
		{"no frame rate", stream("video", "h264", 320, 240, "0/0", "2"), stream("video", "h264", 320, 240, "15/1", "2"), 200, ""},
		{"still no dimensions", stream("video", "h264", 0, 0, "15/1", "2"), stream("video", "h264", 0, 0, "15/1", "2"), 422, "no_video"},
		{"still no frame rate", stream("video", "h264", 320, 240, "0/0", "2"), stream("video", "h264", 320, 240, "0/0", "2"), 422, "fps"},
		{"an average rate only", averageOnly, stream("video", "h264", 320, 240, "240/1", "2"), 422, "fps"},
		{"still an average rate only", averageOnly, averageOnly, 422, "fps"},
		{"larger than declared", stream("video", "h264", 0, 0, "15/1", "2"), stream("video", "h264", 3840, 2161, "15/1", "2"), 422, "pixels"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fakeTools(t, probeOf("2", c.discovered))
			t.Setenv("FAKE_OUT", fakeMP4(t))
			encoded, err := json.Marshal(probeOf("2", c.header))
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "headers.json")
			if err := os.WriteFile(path, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_HEADERS", path)
			log := filepath.Join(t.TempDir(), "ffprobe.log")
			t.Setenv("FAKE_PROBE_LOG", log)
			rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input"))
			if rec.Code != c.code || rec.Header().Get("Kopje-Error") != c.refusal {
				t.Fatalf("normalize %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
			runs, _ := os.ReadFile(log)
			lines := strings.Split(strings.TrimSpace(string(runs)), "\n")
			if len(lines) < 2 || !strings.Contains(lines[0], "-nofind_stream_info") ||
				strings.Contains(lines[1], "-nofind_stream_info") || !strings.Contains(lines[1], "-max_pixels") {
				t.Fatalf("probes: %q", lines)
			}
		})
	}
}

// probe_ms bounds the header and frame probes together, and Kopje-Probe-Ms reports both.
func TestOneProbeBudgetForBothProbes(t *testing.T) {
	fakeTools(t, videoProbe())
	t.Setenv("FAKE_OUT", fakeMP4(t))
	t.Setenv("FAKE_PROBE_SLEEP", "0.45")
	t.Setenv("FAKE_FRAME_SLEEP", "0.45")
	rec := do(t, newMux(threadsDefault), "POST", "/normalize?probe_ms=600&encode_ms=60000", []byte("input"))
	ms, _ := strconv.Atoi(rec.Header().Get("Kopje-Probe-Ms"))
	if rec.Code != 200 || ms < 550 || ms > 800 {
		t.Fatalf("normalize %d, probe %d ms", rec.Code, ms)
	}
}

// ffmpeg can succeed with no frame written when the seek lands past the video's only keyframe (another stream in the
// file moved it): the still is taken at 0 then, on both still paths.
func TestAStillWithNothingAtItsSeekIsTakenAtZero(t *testing.T) {
	fakeTools(t, videoProbe())
	t.Setenv("FAKE_OUT", fakeMP4(t))
	t.Setenv("FAKE_EMPTY_ON", "-ss 0.200")
	mux := newMux(threadsDefault)
	if rec := do(t, mux, "POST", normalizeURL, []byte("input")); rec.Code != 200 || rec.Header().Get("Kopje-Still") != "true" {
		t.Fatalf("normalize %d %v", rec.Code, rec.Header())
	}
	if rec := do(t, mux, "POST", "/still", []byte("input")); rec.Code != 200 {
		t.Fatalf("still %d %q", rec.Code, rec.Body.String())
	}
}

// An output shorter than the plan is refused as the input's, never answered (#1828 PR2, A5): pixels when the decoder
// dropped a frame over the pixel limit, truncated otherwise; a stream that keeps its length passes.
func TestNormalizeRefusesAShortOutput(t *testing.T) {
	cases := []struct {
		name      string
		video     string
		audio     string
		oversized bool
		fail      bool
		code      int
		refusal   string
	}{
		{"whole", "10", "10", false, false, 200, ""},
		{"within a second", "9.1", "10", false, false, 200, ""},
		{"video short", "8.9", "10", false, false, 422, "truncated"},
		{"audio short", "10", "8", false, false, 422, "truncated"},
		// The frames after a dropped one are lost, whatever the length the output still has.
		{"a frame dropped for size, the output whole", "10", "10", true, false, 422, "pixels"},
		// ffmpeg failing after the decoder refused a frame is the input's refusal too, not encode_failed.
		{"failed after a frame dropped for size", "", "", true, true, 422, "pixels"},
		{"failed", "", "", false, true, 500, "encode_failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fakeTools(t, probeOf("10", stream("video", "h264", 320, 240, "30/1", "10"),
				stream("audio", "aac", 0, 0, "0/0", "10")))
			t.Setenv("FAKE_OUT", fakeMP4(t))
			out := probeOf("10", stream("video", "h264", 320, 240, "30/1", c.video), stream("audio", "aac", 0, 0, "0/0", c.audio))
			encoded, _ := json.Marshal(out)
			path := filepath.Join(t.TempDir(), "output.json")
			if err := os.WriteFile(path, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_OUTPUT_PROBE", path)
			if c.oversized {
				t.Setenv("FAKE_OVERSIZE", "1")
			}
			if c.fail {
				t.Setenv("FAKE_FAIL_ON", "libx264")
			}
			rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input"))
			if rec.Code != c.code || rec.Header().Get("Kopje-Error") != c.refusal {
				t.Fatalf("%d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
			if c.code != 200 && strings.Contains(rec.Body.String(), "Picture size") {
				t.Fatal("ffmpeg's output answered")
			}
		})
	}
	// An output the probe cannot read after the decoder refused a frame over the pixel limit is that refusal too.
	fakeTools(t, probeOf("10", stream("video", "h264", 320, 240, "30/1", "10")))
	t.Setenv("FAKE_OUT", fakeMP4(t))
	unreadable := filepath.Join(t.TempDir(), "output.json")
	if err := os.WriteFile(unreadable, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_OUTPUT_PROBE", unreadable)
	for _, c := range []struct {
		oversized string
		code      int
		refusal   string
	}{{"1", 422, "pixels"}, {"", 500, "encode_failed"}} {
		t.Setenv("FAKE_OVERSIZE", c.oversized)
		if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != c.code ||
			rec.Header().Get("Kopje-Error") != c.refusal {
			t.Fatalf("unreadable output, oversized %q: %d %q", c.oversized, rec.Code, rec.Header().Get("Kopje-Error"))
		}
	}
	t.Setenv("FAKE_OVERSIZE", "")
	// An audio output (MP3) is held to its source too.
	fakeTools(t, probeOf("10", stream("audio", "flac", 0, 0, "0/0", "10")))
	short := probeOf("5", stream("audio", "mp3", 0, 0, "0/0", "5"))
	short.Format.FormatName = "mp3"
	encoded, _ := json.Marshal(short)
	path := filepath.Join(t.TempDir(), "output.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_OUTPUT_PROBE", path)
	if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != 422 ||
		rec.Header().Get("Kopje-Error") != "truncated" {
		t.Fatalf("audio: %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
	}
}

// Complete outputs of inputs whose streams differ in length are accepted: a WebM whose 2 s video declares no duration
// of its own beside 4 s of audio and a 4 s segment, and an MP4 whose 10 s video track (300 samples, which nb_frames
// counts before the edits) is edited to present 2 s, encoded as 60 frames.
func TestNormalizeAcceptsCompleteOutputsOfUnequalStreams(t *testing.T) {
	webmVideo := stream("video", "vp9", 320, 240, "30/1", "")
	webmAudio := stream("audio", "opus", 0, 0, "0/0", "")
	webm := probeOf("4", webmVideo, webmAudio)
	webm.Format.FormatName = "matroska,webm"
	edited := stream("video", "h264", 320, 240, "30/1", "2")
	edited.NbFrames = "300"
	outVideo := func(duration, frames string) probeStream {
		s := stream("video", "h264", 320, 240, "30/1", duration)
		s.NbFrames = frames
		return s
	}
	for _, c := range []struct {
		name   string
		source *probeResult
		output *probeResult
	}{
		{"webm", webm, probeOf("4", outVideo("2", "60"), stream("audio", "aac", 0, 0, "0/0", "4"))},
		{"edited mp4", probeOf("2", edited), probeOf("2", outVideo("2", "60"))},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeTools(t, c.source)
			t.Setenv("FAKE_OUT", fakeMP4(t))
			encoded, _ := json.Marshal(c.output)
			path := filepath.Join(t.TempDir(), "output.json")
			if err := os.WriteFile(path, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_OUTPUT_PROBE", path)
			if rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input")); rec.Code != 200 {
				t.Fatalf("%d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
		})
	}
}

// The pixel limit's refusal comes before the output is rewritten or probed, whichever decoder reported it: AV1's
// (libdav1d) with a whole output, and an output the MP4 rewrite cannot read; an expired deadline answers first.
func TestTheSizeMarkerComesFirst(t *testing.T) {
	for _, c := range []struct {
		name, oversize, emptyOn, sleep, url string
		code                                int
		refusal                             string
	}{
		{"libdav1d's diagnostic, the output whole", "dav1d", "", "", normalizeURL, 422, "pixels"},
		{"an output the rewrite cannot read", "1", "libx264", "", normalizeURL, 422, "pixels"},
		{"the same without the marker", "", "libx264", "", normalizeURL, 500, "strip_failed"},
		{"the deadline expired", "1", "", "3", "/normalize?probe_ms=5000&encode_ms=2500", 504, "timeout"},
	} {
		t.Run(c.name, func(t *testing.T) {
			// A short AV1 video, its estimate within every case's encode time.
			fakeTools(t, probeOf("2", stream("video", "av1", 320, 240, "15/1", "2"), stream("audio", "opus", 0, 0, "0/0", "2")))
			t.Setenv("FAKE_OUT", fakeMP4(t))
			t.Setenv("FAKE_OVERSIZE", c.oversize)
			t.Setenv("FAKE_EMPTY_ON", c.emptyOn)
			t.Setenv("FAKE_SLEEP", c.sleep)
			rec := do(t, newMux(threadsDefault), "POST", c.url, []byte("input"))
			if rec.Code != c.code || rec.Header().Get("Kopje-Error") != c.refusal {
				t.Fatalf("%d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
		})
	}
}

func TestMarkerWriterFindsTheMarkerAcrossWrites(t *testing.T) {
	// The native decoders' diagnostic (imgutils.c) and libdav1d's (obu.c), each split across writes.
	for _, parts := range [][]string{
		{"[h264] Picture size 4096x2160 exc", "eeds specified max ", "pixel count 8294400\n"},
		{"[libdav1d @ 0x1] Frame size 4096x2160 exc", "eeds lim", "it 8294400\n"},
	} {
		m := &markerWriter{}
		for _, part := range parts {
			_, _ = m.Write([]byte(part))
		}
		if !m.found || len(m.tail) >= markerSpan {
			t.Fatalf("%q: found %v, tail %d bytes", parts, m.found, len(m.tail))
		}
	}
	// Other errors, the pinned AAC decoder's "exceeds limit" among them, are not the pixel limit's.
	for _, line := range []string{
		"Error while decoding stream",
		"[aac @ 0x1] Number of bands (60) exceeds limit (51).\n",
	} {
		other := &markerWriter{}
		_, _ = other.Write([]byte(line))
		if other.found {
			t.Fatalf("found in %q", line)
		}
	}
}
