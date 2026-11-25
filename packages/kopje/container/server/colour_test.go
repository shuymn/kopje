package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A video whose colour is only in its bitstream (no colr box: the header probe reads its transfer and primaries as
// unknown) is read again with stream discovery, under the pixel limit and the probe budget, and planned from what that
// found: HLG and PQ are tone mapped and estimated as HDR, on normalize and on the still; untagged SDR stays SDR.
func TestColourOnlyInTheBitstreamIsDiscovered(t *testing.T) {
	headerOnly := stream("video", "hevc", 320, 240, "30/1", "2")
	headerOnly.ColorTransfer, headerOnly.ColorPrimaries = "unknown", "unknown"
	discovered := func(transfer, primaries string) probeStream {
		s := headerOnly
		s.ColorTransfer, s.ColorPrimaries = transfer, primaries
		return s
	}
	cases := []struct {
		name       string
		header     probeStream
		found      probeStream
		hdr        bool
		discovered bool
	}{
		{"HLG in the VUI", headerOnly, discovered("arib-std-b67", "bt2020"), true, true},
		{"PQ in the VUI", headerOnly, discovered("smpte2084", "bt2020"), true, true},
		{"untagged SDR", headerOnly, headerOnly, false, true},
		{"transfer known, primaries not", discovered("bt709", ""), discovered("bt709", "bt709"), false, true},
		{"tagged by colr", discovered("arib-std-b67", "bt2020"), discovered("arib-std-b67", "bt2020"), true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			found := probeOf("2", c.found, stream("audio", "aac", 0, 0, "0/0", "2"))
			fakeTools(t, found)
			t.Setenv("FAKE_OUT", fakeMP4(t))
			encoded, err := json.Marshal(probeOf("2", c.header, stream("audio", "aac", 0, 0, "0/0", "2")))
			if err != nil {
				t.Fatal(err)
			}
			headers := filepath.Join(t.TempDir(), "headers.json")
			if err := os.WriteFile(headers, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_HEADERS", headers)
			probeLog := filepath.Join(t.TempDir(), "ffprobe.log")
			t.Setenv("FAKE_PROBE_LOG", probeLog)
			ffmpegLog := filepath.Join(t.TempDir(), "ffmpeg.log")
			t.Setenv("FAKE_LOG", ffmpegLog)
			mux := newMux(threadsDefault)
			rec := do(t, mux, "POST", normalizeURL, []byte("input"))
			if rec.Code != 200 {
				t.Fatalf("normalize %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
			// The estimate is the plan of what discovery found.
			want, refused := planNormalize(found, 60_000)
			if refused != "" || rec.Header().Get("Kopje-Estimate-Ms") != strconv.FormatInt(int64(want.estimateMs), 10) {
				t.Fatalf("estimate %s, plan %v %q", rec.Header().Get("Kopje-Estimate-Ms"), want, refused)
			}
			if rec := do(t, mux, "POST", "/still", []byte("input")); rec.Code != 200 {
				t.Fatalf("still %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
			// Every ffmpeg run of the input (the encode, the normalize still and the /still) tone maps an HDR video.
			runs, _ := os.ReadFile(ffmpegLog)
			var encodes int
			for _, line := range strings.Split(strings.TrimSpace(string(runs)), "\n") {
				if !strings.Contains(line, "/input") {
					continue
				}
				encodes++
				if strings.Contains(line, tonemap) != c.hdr {
					t.Fatalf("tone map %v in %q", !c.hdr, line)
				}
			}
			if encodes < 3 {
				t.Fatalf("ffmpeg runs: %q", runs)
			}
			// Discovery: the second probe of the input, with frames decoded under the pixel limit.
			probes, _ := os.ReadFile(probeLog)
			var inputProbes []string
			for _, line := range strings.Split(strings.TrimSpace(string(probes)), "\n") {
				if strings.HasSuffix(line, "/input") && !strings.Contains(line, "-show_frames") {
					inputProbes = append(inputProbes, line)
				}
			}
			// One request each: normalize and /still.
			perRequest := 1
			if c.discovered {
				perRequest = 2
			}
			if len(inputProbes) != 2*perRequest {
				t.Fatalf("probes: %q", inputProbes)
			}
			for i, line := range inputProbes {
				header := i%perRequest == 0
				if header != strings.Contains(line, "-nofind_stream_info") || !strings.Contains(line, "-max_pixels") {
					t.Fatalf("probe %d: %q", i, line)
				}
			}
		})
	}
}

// A discovery run only for the colour that fails (a frame over the pixel limit, as lie.mp4's) leaves the header probe's
// answer, planned untagged; one run for an unknown limit is the input's refusal.
func TestAFailedColourDiscoveryLeavesTheHeaders(t *testing.T) {
	untagged := stream("video", "h264", 320, 240, "30/1", "2")
	untagged.ColorTransfer, untagged.ColorPrimaries = "", ""
	noRate := untagged
	noRate.RFrameRate = "0/0"
	for _, c := range []struct {
		name    string
		header  probeStream
		code    int
		refusal string
	}{
		{"colour unknown", untagged, 200, ""},
		{"a limit unknown", noRate, 422, "unreadable"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeTools(t, probeOf("2", untagged))
			t.Setenv("FAKE_OUT", fakeMP4(t))
			encoded, err := json.Marshal(probeOf("2", c.header))
			if err != nil {
				t.Fatal(err)
			}
			headers := filepath.Join(t.TempDir(), "headers.json")
			if err := os.WriteFile(headers, encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FAKE_HEADERS", headers)
			t.Setenv("FAKE_DISCOVERY_FAIL", "1")
			ffmpegLog := filepath.Join(t.TempDir(), "ffmpeg.log")
			t.Setenv("FAKE_LOG", ffmpegLog)
			rec := do(t, newMux(threadsDefault), "POST", normalizeURL, []byte("input"))
			if rec.Code != c.code || rec.Header().Get("Kopje-Error") != c.refusal {
				t.Fatalf("normalize %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
			}
			if runs, _ := os.ReadFile(ffmpegLog); strings.Contains(string(runs), tonemap) {
				t.Fatalf("tone mapped: %q", runs)
			}
		})
	}
}

// The colour discovery shares the header probe's cut: a cut the two together pass answers the timeout.
func TestColourDiscoveryIsWithinTheProbeBudget(t *testing.T) {
	headerOnly := stream("video", "hevc", 320, 240, "30/1", "2")
	headerOnly.ColorTransfer, headerOnly.ColorPrimaries = "unknown", "unknown"
	fakeTools(t, probeOf("2", headerOnly))
	t.Setenv("FAKE_OUT", fakeMP4(t))
	encoded, err := json.Marshal(probeOf("2", headerOnly))
	if err != nil {
		t.Fatal(err)
	}
	headers := filepath.Join(t.TempDir(), "headers.json")
	if err := os.WriteFile(headers, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_HEADERS", headers)
	t.Setenv("FAKE_PROBE_SLEEP", "0.4")
	rec := do(t, newMux(threadsDefault), "POST", "/normalize?work_ms=60600&still_ms=60000", []byte("input"))
	if rec.Code != 504 || rec.Header().Get("Kopje-Error") != "timeout" {
		t.Fatalf("normalize %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
	}
	// The control: the same input tagged by colr needs no discovery, so its probe ends within the cut, and the envelope
	// check then meets the little time left.
	tagged := headerOnly
	tagged.ColorTransfer, tagged.ColorPrimaries = "bt709", "bt709"
	encoded, err = json.Marshal(probeOf("2", tagged))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(headers, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := do(t, newMux(threadsDefault), "POST", "/normalize?work_ms=60600&still_ms=60000", []byte("input")); rec.Code != 422 {
		t.Fatalf("tagged normalize %d %q", rec.Code, rec.Header().Get("Kopje-Error"))
	}
}
