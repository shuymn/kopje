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
	"strings"
	"testing"
	"time"
)

// The fake ffprobe prints the probe JSON in the file $FAKE_PROBE; the fake ffmpeg copies the file $FAKE_OUT (for a PNG
// still, $FAKE_PNG) to its last argument (file:<path>), prints a marker on stderr, and exits $FAKE_EXIT (sleeping
// $FAKE_SLEEP seconds first).
const fakeProbe = `#!/bin/sh
echo "SECRET-PROBE-STDERR" >&2
cat "$FAKE_PROBE"
`

const fakeFFmpeg = `#!/bin/sh
echo "SECRET-FFMPEG-STDERR" >&2
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
	missing := do(t, mux, "GET", "/missing", nil)
	if missing.Code != 404 || missing.Body.String() != `{"error":"not_found"}`+"\n" {
		t.Fatalf("missing: %d %q", missing.Code, missing.Body.String())
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

	// Ingress: one byte of the two declared, then nothing.
	in, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	if _, err := io.WriteString(in, "POST /still HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nx"); err != nil {
		t.Fatal(err)
	}
	_ = in.SetReadDeadline(time.Now().Add(5 * time.Second))
	answer, _ := io.ReadAll(io.LimitReader(in, 4096))
	if !bytes.HasPrefix(answer, []byte("HTTP/1.1 408")) || !bytes.Contains(answer, []byte(`"input_timeout"`)) {
		t.Fatalf("stalled body: %q", answer)
	}
	if !slotFreed(2 * time.Second) {
		t.Fatal("job slot held after a stalled body")
	}

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
