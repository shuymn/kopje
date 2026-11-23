package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The fake ffprobe prints the probe JSON in the file $FAKE_PROBE; the fake ffmpeg copies the file $FAKE_OUT to its last
// argument (file:<path>), prints a marker on stderr, and exits $FAKE_EXIT (sleeping $FAKE_SLEEP seconds first).
const fakeProbe = `#!/bin/sh
echo "SECRET-PROBE-STDERR" >&2
cat "$FAKE_PROBE"
`

const fakeFFmpeg = `#!/bin/sh
echo "SECRET-FFMPEG-STDERR" >&2
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
for last; do :; done
cat "$FAKE_OUT" > "${last#file:}"
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
