package main

import (
	"math"
	"strconv"
	"testing"
)

// A stream as the header probe reads it; a video tagged BT.709 (colour known, so no discovery for it).
func stream(codecType, codec string, w, h int, rate, duration string) probeStream {
	s := probeStream{CodecType: codecType, CodecName: codec, Width: w, Height: h, RFrameRate: rate, AvgFrameRate: rate,
		Duration: duration}
	if codecType == "video" {
		s.ColorTransfer, s.ColorPrimaries = "bt709", "bt709"
	}
	return s
}

func probeOf(format string, streams ...probeStream) *probeResult {
	p := &probeResult{Streams: streams}
	p.Format.FormatName = "mov,mp4,m4a,3gp,3g2,mj2"
	p.Format.Duration = format
	for i := range p.Streams {
		p.Streams[i].Index = i
	}
	return p
}

// Generous encode time, so only the limits under test refuse.
const roomy = 60 * 60 * 1000.0

func TestPlanChoosesTheOperationByStreams(t *testing.T) {
	cover := stream("video", "png", 600, 600, "90000/1", "")
	cover.Disposition.AttachedPic = 1
	cases := []struct {
		name  string
		probe *probeResult
		kind  string
		video int
		audio int
	}{
		{"video with audio", probeOf("60", stream("video", "h264", 1920, 1080, "30/1", "60"),
			stream("audio", "aac", 0, 0, "0/0", "60")), "video", 0, 1},
		{"silent video", probeOf("60", stream("video", "h264", 1920, 1080, "30/1", "60")), "video", 0, -1},
		{"audio with cover art", probeOf("60", stream("audio", "aac", 0, 0, "0/0", "60"), cover), "audio", -1, 0},
		{"cover art first, then the video", probeOf("60", cover, stream("video", "h264", 1280, 720, "30/1", "60"),
			stream("audio", "aac", 0, 0, "0/0", "60")), "video", 1, 2},
		{"opus-only webm", probeOf("30", stream("audio", "opus", 0, 0, "0/0", "")), "audio", -1, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, refused := planNormalize(c.probe, roomy)
			if refused != "" {
				t.Fatalf("refused %s", refused)
			}
			if p.kind != c.kind || p.videoIndex != c.video || p.audioIndex != c.audio {
				t.Fatalf("got %s video %d audio %d", p.kind, p.videoIndex, p.audioIndex)
			}
		})
	}
}

func TestPlanRefusesOutsideTheLimits(t *testing.T) {
	video := func(w, h int, rate, duration, frames string) *probeResult {
		s := stream("video", "h264", w, h, rate, duration)
		s.NbFrames = frames
		return probeOf(duration, s)
	}
	unbounded := probeOf("", stream("video", "h264", 640, 480, "30/1", ""))
	audioOnly := func(d string) *probeResult { return probeOf(d, stream("audio", "flac", 0, 0, "0/0", d)) }
	cases := []struct {
		name  string
		probe *probeResult
		want  refusal
	}{
		{"no stream", probeOf("10", stream("subtitle", "mov_text", 0, 0, "0/0", "10")), refuseNoStream},
		{"undecodable video", probeOf("10", stream("video", "", 0, 0, "30/1", "10")), refuseNoVideo},
		{"over 8,294,400 pixels", video(3840, 2161, "30/1", "10", ""), refusePixels},
		{"at 8,294,400 pixels", video(3840, 2160, "30/1", "10", ""), ""},
		{"over 120 fps", video(640, 480, "121/1", "10", ""), refuseFPS},
		{"at 120 fps", video(640, 480, "120/1", "10", ""), ""},
		{"no frame rate", video(640, 480, "0/0", "10", ""), refuseFPS},
		{"an average rate only", func() *probeResult {
			p := video(640, 480, "0/0", "10", "")
			p.Streams[0].AvgFrameRate = "98/1"
			return p
		}(), refuseFPS},
		{"over 600 s", video(640, 480, "24/1", "600.001", ""), refuseDuration},
		{"at 600 s", video(640, 480, "24/1", "600", ""), ""},
		{"over 36,000 frames by duration and rate", video(640, 480, "100/1", "400", ""), refuseFrames},
		{"at 36,000 frames", video(640, 480, "60/1", "600", ""), ""},
		{"over 36,000 frames by the declared count", video(640, 480, "30/1", "100", "36001"), refuseFrames},
		{"no duration anywhere", unbounded, refuseUnbounded},
		{"audio over 20 minutes", audioOnly("1200.5"), refuseDuration},
		{"audio at 20 minutes", audioOnly("1200"), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, refused := planNormalize(c.probe, roomy)
			if refused != c.want {
				t.Fatalf("got %q, want %q", refused, c.want)
			}
		})
	}
}

// A WebM's duration is on the segment only: the container's duration bounds the stream that declares none.
func TestPlanBoundsAStreamWithoutDurationByTheContainer(t *testing.T) {
	p, refused := planNormalize(probeOf("90", stream("video", "vp9", 1920, 1080, "30/1", ""),
		stream("audio", "opus", 0, 0, "0/0", "")), roomy)
	if refused != "" || p.duration != 90 {
		t.Fatalf("got %v %q", p, refused)
	}
}

// VFR and contradictory headers count at their largest: the larger rate, the larger frame count, the longer stream.
func TestPlanCountsContradictoryHeadersAtTheirLargest(t *testing.T) {
	v := stream("video", "h264", 640, 480, "30/1", "10")
	v.AvgFrameRate = "120/1"
	a := stream("audio", "aac", 0, 0, "0/0", "40")
	p, refused := planNormalize(probeOf("10", v, a), roomy)
	if refused != "" {
		t.Fatalf("refused %s", refused)
	}
	if p.duration != 40 {
		t.Fatalf("duration %v, want the audio's 40", p.duration)
	}
	// 40 s at 120 fps = 4,800 frames decoded.
	slower, _ := planNormalize(probeOf("10", stream("video", "h264", 640, 480, "30/1", "10"), a), roomy)
	if !(p.estimateMs > slower.estimateMs) {
		t.Fatalf("estimate %v not above the 30 fps one %v", p.estimateMs, slower.estimateMs)
	}
}

func TestPlanRefusesAnEstimateOverTheEncodeTime(t *testing.T) {
	input := probeOf("60", stream("video", "h264", 1920, 1080, "30/1", "60"), stream("audio", "aac", 0, 0, "0/0", "60"))
	p, refused := planNormalize(input, roomy)
	if refused != "" {
		t.Fatalf("refused %s", refused)
	}
	// Admitted while the estimate is within estimateSafety of the encode time, refused just past it.
	limit := p.estimateMs / estimateSafety
	if _, refused := planNormalize(input, math.Ceil(limit)); refused != "" {
		t.Fatalf("refused at the limit: %s", refused)
	}
	if _, refused := planNormalize(input, math.Floor(limit)-1); refused != refuseEnvelope {
		t.Fatalf("got %q below the limit", refused)
	}
	hdr := probeOf("60", stream("video", "hevc", 1920, 1080, "30/1", "60"))
	hdr.Streams[0].ColorTransfer = "arib-std-b67"
	tonemapped, _ := planNormalize(hdr, roomy)
	sdr, _ := planNormalize(probeOf("60", stream("video", "hevc", 1920, 1080, "30/1", "60")), roomy)
	if !tonemapped.hdr || !(tonemapped.estimateMs > sdr.estimateMs) {
		t.Fatalf("HDR %v estimate %v, SDR %v", tonemapped.hdr, tonemapped.estimateMs, sdr.estimateMs)
	}
}

func TestLadderAndBitrateCap(t *testing.T) {
	cases := []struct {
		duration  float64
		long      int
		fps       int
		audioRate int
	}{
		{120, 1920, 60, 192_000},
		{120.001, 1280, 30, 192_000},
		{300, 1280, 30, 192_000},
		{300.001, 854, 30, 128_000},
		{600, 854, 30, 128_000},
	}
	for _, c := range cases {
		r := rungFor(c.duration)
		if r.longEdge != c.long || r.fps != c.fps || r.audioBitrate != c.audioRate {
			t.Fatalf("%v s: got %+v", c.duration, r)
		}
	}
	if got := videoMaxrate(2, 192_000); got != maxVideoMaxrate {
		t.Fatalf("short clip maxrate %d", got)
	}
	// 56 MiB over 600 s, less the 480p rung's audio.
	if got, want := videoMaxrate(600, 128_000), 654_936; got != want {
		t.Fatalf("600 s maxrate %d, want %d", got, want)
	}
	// At the cap, a whole file stays below AV_OUTPUT_LIMIT with one second of overshoot.
	for _, d := range []float64{60, 120, 300, 600} {
		r := rungFor(d)
		total := (float64(videoMaxrate(d, r.audioBitrate)+r.audioBitrate)*d + float64(videoMaxrate(d, r.audioBitrate))) / 8
		if total >= avOutputLimit {
			t.Fatalf("%v s: %v bytes at the cap", d, total)
		}
	}
}

func TestFitWithin(t *testing.T) {
	cases := []struct{ w, h, long, short, ow, oh int }{
		{3840, 2160, 1920, 1080, 1920, 1080},
		{2160, 3840, 1920, 1080, 1080, 1920},
		{640, 480, 1920, 1080, 640, 480},
		{1920, 1080, 854, 480, 852, 480},
		{1001, 1001, 640, 640, 640, 640},
	}
	for _, c := range cases {
		if w, h := fitWithin(c.w, c.h, c.long, c.short); w != c.ow || h != c.oh {
			t.Fatalf("%dx%d within %d/%d: %dx%d", c.w, c.h, c.long, c.short, w, h)
		}
	}
}

func TestParseRate(t *testing.T) {
	cases := map[string]float64{"30/1": 30, "30000/1001": 30000.0 / 1001, "0/0": 0, "25": 25, "x/1": 0, "1/0": 0,
		"-30/1": 0, "": 0, "NaN/1": 0, "Inf/1": 0}
	for in, want := range cases {
		if got := parseRate(in); got != want {
			t.Fatalf("%q: %v, want %v", in, got, want)
		}
	}
}

func TestStillSeek(t *testing.T) {
	if stillSeek(0) != 0 || stillSeek(math.Inf(1)) != 0 || stillSeek(60) != 6 {
		t.Fatal("still seek")
	}
}

// Which colour work a video needs, from the probe: a profile on the stream or on its first frame, and primaries other
// than BT.709 with a known transfer on SDR.
func TestPlanReadsTheColourTags(t *testing.T) {
	video := func(primaries, transfer string) *probeResult {
		s := stream("video", "h264", 320, 240, "30/1", "2")
		s.ColorPrimaries, s.ColorTransfer = primaries, transfer
		return probeOf("2", s)
	}
	for _, c := range []struct {
		primaries, transfer string
		want                bool
	}{
		{"smpte432", "bt709", true}, {"bt2020", "bt709", true}, {"bt709", "bt709", false}, {"", "", false},
		{"unknown", "bt709", false}, {"smpte432", "unknown", false}, {"bt2020", "smpte2084", false},
	} {
		pl, r := planNormalize(video(c.primaries, c.transfer), roomy)
		if r != "" || pl.primaries != c.want || pl.icc {
			t.Fatalf("%s/%s: %+v %q", c.primaries, c.transfer, pl, r)
		}
	}
	onStream := video("", "")
	onStream.Streams[0].SideDataList = []sideData{{"ICC Profile"}}
	if pl, _ := planNormalize(onStream, roomy); !pl.icc {
		t.Fatal("a profile on the stream is not seen")
	}
	// The frame probe's answer: a profile on a frame of the stream, not of another.
	frames := `{"frames":[{"stream_index":1,"side_data_list":[{"side_data_type":"ICC profile"}]}]}`
	if !framesICC([]byte(frames), 1) || framesICC([]byte(frames), 0) || framesICC([]byte("not json"), 1) {
		t.Fatal("frame probe misread")
	}
}

// The envelope's decisions (#1828 PR2, A1) at the rungs' boundaries and at each endpoint's edge, for the inputs P27
// measured. The expected estimate is derived here from A1's coefficients and the encode time from design 4.7's
// starting stage times, never copied from the plan, so a changed coefficient, rung or allocation fails this test.
func TestTheEnvelopeAtTheBoundaries(t *testing.T) {
	// A1's provisional coefficients (ns per pixel, ms per second of audio), fixed work and safety factor.
	decode := map[string]float64{"h264": 1.0, "hevc": 1.5, "vp9": 3.5}
	const tonemap, encode, audioMs, fixedMs, safety = 10.0, 9.0, 40.0, 1500.0, 0.7
	// Design 4.7's starting stage times (s): dispatch, start, probe, still and Images, commit, v1's reply; an assumed
	// input streaming time and, for v1, ingress.
	const dispatch, start, probeS, still, commit, reply, input, ingress = 2.0, 5.0, 3.0, 8.0, 6.0, 2.0, 3.2, 10.0
	fixed := dispatch + start + probeS + still + commit
	endpoints := []struct {
		name     string
		encodeMs float64
	}{
		{"v2 (480 s)", (480 - fixed - input) * 1000},
		{"v1 at 90 s", (90 - ingress - input - fixed - reply) * 1000},
		{"v1 at 300 s", (300 - ingress - input - fixed - reply) * 1000},
	}
	// The ladder as A2 keeps it: the duration each rung takes, its geometry and frame rate.
	rungs := []struct{ upTo, long, short, fps float64 }{{120, 1920, 1080, 60}, {300, 1280, 720, 30}, {600, 854, 480, 30}}
	expected := func(w, h, fps, d float64, codec string, hdr, audio bool) float64 {
		r := rungs[len(rungs)-1]
		for _, c := range rungs {
			if d <= c.upTo {
				r = c
				break
			}
		}
		ow, oh := fitWithin(int(w), int(h), int(r.long), int(r.short))
		perPixel := decode[codec]
		if hdr {
			perPixel += tonemap
		}
		est := fixedMs + w*h*d*fps*perPixel/1e6 + float64(ow*oh)*math.Min(d*fps, math.Ceil(d*r.fps))*encode/1e6
		if audio {
			est += d * audioMs
		}
		return est
	}
	inputs := []struct {
		name      string
		codec     string
		w, h, fps float64
		transfer  string
		audio     bool
		duration  float64
	}{
		{"1080p H.264 below 120 s", "h264", 1920, 1080, 30, "", true, 119.9},
		{"1080p H.264 above 120 s", "h264", 1920, 1080, 30, "", true, 120.1},
		{"1080p H.264 below 300 s", "h264", 1920, 1080, 30, "", true, 299.9},
		{"1080p H.264 above 300 s", "h264", 1920, 1080, 30, "", true, 300.1},
		{"1080p H.264 60 s", "h264", 1920, 1080, 30, "", true, 60},
		{"4K HEVC SDR below 120 s", "hevc", 3840, 2160, 30, "", true, 119.9},
		{"4K HEVC SDR above 120 s", "hevc", 3840, 2160, 30, "", true, 120.1},
		{"4K HEVC SDR below 300 s", "hevc", 3840, 2160, 30, "", true, 299.9},
		{"4K HEVC SDR above 300 s", "hevc", 3840, 2160, 30, "", true, 300.1},
		{"4K HEVC SDR 600 s", "hevc", 3840, 2160, 30, "", true, 600},
		{"4K HEVC HLG 30 s", "hevc", 3840, 2160, 30, "arib-std-b67", true, 30},
		{"4K HEVC PQ 30 s", "hevc", 3840, 2160, 30, "smpte2084", true, 30},
		{"4K HEVC HLG below 120 s", "hevc", 3840, 2160, 30, "arib-std-b67", true, 119.9},
		{"4K HEVC PQ above 120 s", "hevc", 3840, 2160, 30, "smpte2084", true, 120.1},
		// Not HEVC: HDR costs the tone map over the codec's own decode (A1).
		{"1080p VP9 HLG 30 s", "vp9", 1920, 1080, 30, "arib-std-b67", true, 30},
	}
	for _, in := range inputs {
		d := strconv.FormatFloat(in.duration, 'f', -1, 64)
		v := stream("video", in.codec, int(in.w), int(in.h), strconv.FormatFloat(in.fps, 'f', -1, 64)+"/1", d)
		v.ColorTransfer = in.transfer
		streams := []probeStream{v}
		if in.audio {
			streams = append(streams, stream("audio", "aac", 0, 0, "0/0", d))
		}
		probe := probeOf(d, streams...)
		want := expected(in.w, in.h, in.fps, in.duration, in.codec, in.transfer != "", in.audio)
		for _, e := range endpoints {
			pl, refused := planNormalize(probe, e.encodeMs)
			admitted := want <= safety*e.encodeMs
			if admitted != (refused == "") || (!admitted && refused != refuseEnvelope) {
				t.Fatalf("%s on %s: estimate %.0f ms against %.0f ms, got %q", in.name, e.name, want, e.encodeMs, refused)
			}
			if admitted && math.Abs(pl.estimateMs-want) > 1e-6 {
				t.Fatalf("%s: estimate %v, want %v", in.name, pl.estimateMs, want)
			}
		}
		// Each input's own edge: admitted with the encode time its estimate needs, refused a millisecond under it.
		edge := want / safety
		if _, refused := planNormalize(probe, math.Ceil(edge)); refused != "" {
			t.Fatalf("%s refused at its edge %.0f ms: %q", in.name, edge, refused)
		}
		if _, refused := planNormalize(probe, math.Floor(edge)-1); refused != refuseEnvelope {
			t.Fatalf("%s admitted under its edge %.0f ms: %q", in.name, edge, refused)
		}
	}
	// The published comparisons A1 states: 30 s 1080p VP9 HLG with audio estimates 44.7 s; 600 s 4K HEVC SDR 315.7 s,
	// admitted on v2's 452.8 s of encode time; a 60 s 1080p H.264 clip (41.2 s) refused on v1 at 90 s.
	vp9 := expected(1920, 1080, 30, 30, "vp9", true, true)
	hevc := expected(3840, 2160, 30, 600, "hevc", false, true)
	h264 := expected(1920, 1080, 30, 60, "h264", false, true)
	if math.Round(vp9/100) != 447 || math.Round(hevc/100) != 3157 || math.Round(h264/100) != 412 {
		t.Fatalf("estimates %v %v %v", vp9, hevc, h264)
	}
	if !(hevc <= safety*endpoints[0].encodeMs) || h264 <= safety*endpoints[1].encodeMs {
		t.Fatal("A1's stated decisions do not hold")
	}
}
