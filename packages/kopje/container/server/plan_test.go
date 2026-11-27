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

// A video refused for its estimate: no rung from its duration's down fits. A source smaller than every rung (640x480 at
// 30 fps) estimates the same on each, so missing the top rung by a millisecond misses them all.
func TestPlanRefusesAnEstimateOverTheEncodeTime(t *testing.T) {
	input := probeOf("60", stream("video", "h264", 640, 480, "30/1", "60"), stream("audio", "aac", 0, 0, "0/0", "60"))
	p, refused := planNormalize(input, roomy)
	if refused != "" || p.rung != ladder[0] {
		t.Fatalf("got %+v %q", p, refused)
	}
	// Admitted while the estimate is within estimateSafety of the encode time, refused just past it.
	limit := math.Ceil(p.estimateMs / estimateSafety)
	if at, refused := planNormalize(input, limit); refused != "" || at.rung != ladder[0] {
		t.Fatalf("at the limit: %+v %q", at, refused)
	}
	if _, refused := planNormalize(input, limit-1); refused != refuseEnvelope {
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

// 60 s of 1080p60 H.264 with AAC takes 1080p60 (its duration's rung) from 240,185 ms of encode time, 720p30 from
// 66,003 ms and 480p30 from 38,320 ms, and is refused below that. The edges are the estimates over estimateSafety,
// worked by hand: decoding 3,600 frames of 1920x1080 at 1 ns a pixel (7,465 ms), the audio (2,400 ms) and the fixed
// 1,500 ms, with encoding 3,600 frames of 1920x1080 (156,764 ms), 1,800 of 1280x720 (34,836 ms) or 1,800 of 852x480
// (15,459 ms) at 21 ns a pixel.
func TestPlanFallsToTheFirstLowerRungThatFits(t *testing.T) {
	input := probeOf("60", stream("video", "h264", 1920, 1080, "60/1", "60"), stream("audio", "aac", 0, 0, "0/0", "60"))
	edges := []struct {
		encodeMs float64
		long     int
	}{{240_185, 1920}, {66_003, 1280}, {38_320, 854}}
	for i, e := range edges {
		p, refused := planNormalize(input, e.encodeMs)
		if refused != "" || p.rung.longEdge != e.long {
			t.Fatalf("at %v ms: %+v %q, want the %d rung", e.encodeMs, p, refused, e.long)
		}
		below, refused := planNormalize(input, e.encodeMs-1)
		switch {
		case i == len(edges)-1:
			if refused != refuseEnvelope {
				t.Fatalf("at %v ms: %+v %q, want envelope", e.encodeMs-1, below, refused)
			}
		case refused != "" || below.rung.longEdge != edges[i+1].long:
			t.Fatalf("at %v ms: %+v %q, want the %d rung", e.encodeMs-1, below, refused, edges[i+1].long)
		}
	}
	// Never a rung above the duration's: 121 s of 1080p30 takes 720p30 however much time is left.
	long := probeOf("121", stream("video", "h264", 1920, 1080, "30/1", "121"))
	if p, refused := planNormalize(long, roomy); refused != "" || p.rung != ladder[1] {
		t.Fatalf("121 s: %+v %q", p, refused)
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
		r := ladder[durationRung(c.duration)]
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
	// The nominal size at the cap, with one second of overshoot, stays within AV_OUTPUT_TARGET and that second at
	// maxVideoMaxrate, whichever AAC bitrate a rung (its own or a lower one's) or a silent video gives, at durations
	// around the 8 Mb/s knee (57.3 s to 58.7 s) and past it. The hard limit is the container's file-size check and the
	// Worker's reader.
	for _, aac := range []int{192_000, 128_000, 0} {
		for _, d := range []float64{57, 57.3, 57.5, 57.8, 58, 58.7, 60, 120, 300, 600} {
			maxrate := videoMaxrate(d, aac)
			total := (float64(maxrate+aac)*d + float64(maxrate)) / 8
			if total > avOutputTarget+maxVideoMaxrate/8 {
				t.Fatalf("%v s with %d b/s of audio: %v bytes at the cap", d, aac, total)
			}
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
		// Each dimension at least 2, as the scale filter keeps it: a thin source's short edge does not reach 0.
		{1920, 4, 854, 480, 854, 2},
		{1, 640, 1920, 1080, 2, 640},
	}
	for _, c := range cases {
		if w, h := fitWithin(c.w, c.h, c.long, c.short); w != c.ow || h != c.oh {
			t.Fatalf("%dx%d within %d/%d: %dx%d", c.w, c.h, c.long, c.short, w, h)
		}
	}
	// The estimate does not grow down the ladder, which the walk from the duration's rung relies on: here 1920x4 at
	// 60 fps, then 1280x2 and 854x2 at 30 fps.
	thin := stream("video", "h264", 1920, 4, "60/1", "60")
	last := math.Inf(1)
	for _, r := range ladder {
		e := videoEstimate(&thin, nil, 3600, 60, r)
		if e > last {
			t.Fatalf("%dp rung estimates %v, over %v", r.shortEdge, e, last)
		}
		last = e
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
	// A transfer of another curve than BT.709's is converted; BT.601's and BT.2020's are BT.709's curve.
	for _, c := range []struct {
		transfer string
		want     bool
	}{
		{"iec61966-2-1", true}, {"gamma22", true}, {"gamma28", true}, {"linear", true},
		{"bt709", false}, {"smpte170m", false}, {"bt2020-10", false}, {"bt2020-12", false},
		{"unknown", false}, {"", false}, {"arib-std-b67", false}, {"smpte2084", false},
	} {
		pl, r := planNormalize(video("bt709", c.transfer), roomy)
		if r != "" || pl.transfer != c.want {
			t.Fatalf("bt709/%s: %+v %q", c.transfer, pl, r)
		}
	}
	// A conversion of a video that leaves its matrix unspecified reads it with BT.709 above 576 lines, else BT.601's.
	for _, c := range []struct {
		transfer, space string
		height          int
		want            string
	}{
		{"iec61966-2-1", "", 1080, "bt709"}, {"iec61966-2-1", "unknown", 720, "bt709"},
		{"iec61966-2-1", "", 576, "smpte170m"}, {"gamma22", "", 480, "smpte170m"},
		{"iec61966-2-1", "bt470bg", 1080, ""}, {"bt709", "", 1080, ""},
	} {
		p := video("bt709", c.transfer)
		p.Streams[0].ColorSpace, p.Streams[0].Height = c.space, c.height
		if pl, r := planNormalize(p, roomy); r != "" || pl.matrix != c.want {
			t.Fatalf("%s/%s/%d: matrix %q %q", c.transfer, c.space, c.height, pl.matrix, r)
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
// measured: a video takes the first rung from its duration's down whose estimate fits, and is refused when none does.
// The expected rung and estimate are derived here from A1's coefficients, A2's ladder and the encode time from design
// 4.7's starting stage times, never copied from the plan, so a changed coefficient, rung, allocation or walk fails this
// test.
func TestTheEnvelopeAtTheBoundaries(t *testing.T) {
	// The coefficients (A1's, the tone map's and the encode's from the boundary bench, A8; ns per pixel, ms per second
	// of audio), fixed work and safety factor.
	decode := map[string]float64{"h264": 1.0, "hevc": 1.5, "vp9": 3.5}
	const tonemap, encode, audioMs, fixedMs, safety = 11.0, 21.0, 40.0, 1500.0, 0.7
	// Design 4.7's starting stage times (s): dispatch, start, probe, still and Images, commit, v1's reply; an assumed
	// input streaming time and, for v1, ingress. They are the PR2 bench's allocations, not the live allocate's
	// (docs/media-processor.md, "Estimated admission limits", has those).
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
	type source struct {
		w, h, fps, d float64
		codec        string
		hdr, audio   bool
	}
	// The rung a duration takes, and the estimate on rung i: the output's even dimensions, each at least 2.
	durationRung := func(d float64) int {
		for i, r := range rungs {
			if d <= r.upTo {
				return i
			}
		}
		return len(rungs) - 1
	}
	estimateOn := func(s source, i int) float64 {
		r := rungs[i]
		f := math.Min(1, math.Min(r.long/math.Max(s.w, s.h), r.short/math.Min(s.w, s.h)))
		out := math.Max(2, math.Trunc(s.w*f/2)*2) * math.Max(2, math.Trunc(s.h*f/2)*2)
		perPixel := decode[s.codec]
		if s.hdr {
			perPixel += tonemap
		}
		est := fixedMs + s.w*s.h*s.d*s.fps*perPixel/1e6 + out*math.Min(s.d*s.fps, math.Ceil(s.d*r.fps))*encode/1e6
		if s.audio {
			est += s.d * audioMs
		}
		return est
	}
	// The rung planned with encodeMs and its estimate; -1 when no rung from the duration's down fits.
	expected := func(s source, encodeMs float64) (int, float64) {
		for i := durationRung(s.d); i < len(rungs); i++ {
			if est := estimateOn(s, i); est <= safety*encodeMs {
				return i, est
			}
		}
		return -1, 0
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
		src := source{in.w, in.h, in.fps, in.duration, in.codec, in.transfer != "", in.audio}
		check := func(label string, encodeMs float64) int {
			i, want := expected(src, encodeMs)
			pl, refused := planNormalize(probe, encodeMs)
			if i < 0 {
				if refused != refuseEnvelope {
					t.Fatalf("%s %s at %.0f ms: got %+v %q, want envelope", in.name, label, encodeMs, pl, refused)
				}
				return i
			}
			if refused != "" || pl.rung.longEdge != int(rungs[i].long) || pl.rung.shortEdge != int(rungs[i].short) ||
				pl.rung.fps != int(rungs[i].fps) {
				t.Fatalf("%s %s at %.0f ms: got %+v %q, want the rung %v", in.name, label, encodeMs, pl, refused, rungs[i])
			}
			if math.Abs(pl.estimateMs-want) > 1e-6 {
				t.Fatalf("%s %s: estimate %v, want %v", in.name, label, pl.estimateMs, want)
			}
			return i
		}
		for _, e := range endpoints {
			check("on "+e.name, e.encodeMs)
		}
		// Each rung's own edge for the input: admitted on that rung with the encode time its estimate needs, and a
		// millisecond under it on the next rung, or refused under the last.
		for i := durationRung(in.duration); i < len(rungs); i++ {
			edge := math.Ceil(estimateOn(src, i) / safety)
			if got := check("at its edge", edge); got != i {
				t.Fatalf("%s at its rung %d edge %.0f ms: rung %d", in.name, i, edge, got)
			}
			next := i + 1
			if next == len(rungs) {
				next = -1
			}
			if got := check("under its edge", edge-1); got != next {
				t.Fatalf("%s under its rung %d edge %.0f ms: rung %d", in.name, i, edge, got)
			}
		}
	}
	// A1's comparisons under A8's coefficients, on each input's duration rung: 30 s 1080p VP9 HLG with audio estimates
	// 69.0 s; 600 s 4K HEVC SDR 404.0 s (on the last rung, so none lower), refused on v2's 452.8 s of encode time,
	// where 470 s is the edge (471 s refused); a 60 s 1080p H.264 clip 86.0 s at 1080p, which on v1 at 90 s (50.8 s
	// of encode time) is encoded at 480p (23.1 s) and refused from 32,987 ms down.
	vp9 := source{1920, 1080, 30, 30, "vp9", true, true}
	hevc := source{3840, 2160, 30, 600, "hevc", false, true}
	h264 := source{1920, 1080, 30, 60, "h264", false, true}
	if math.Round(estimateOn(vp9, 0)/100) != 690 || math.Round(estimateOn(hevc, 2)/100) != 4040 ||
		math.Round(estimateOn(h264, 0)/100) != 860 || math.Round(estimateOn(h264, 2)/100) != 231 {
		t.Fatalf("estimates %v %v %v %v", estimateOn(vp9, 0), estimateOn(hevc, 2), estimateOn(h264, 0), estimateOn(h264, 2))
	}
	v2 := endpoints[0].encodeMs
	edge, past := hevc, hevc
	edge.d, past.d = 470, 471
	if i, _ := expected(hevc, v2); i >= 0 {
		t.Fatal("600 s 4K HEVC SDR admitted on v2")
	}
	if i, _ := expected(edge, v2); i != 2 {
		t.Fatal("470 s 4K HEVC SDR not admitted on v2")
	}
	if i, _ := expected(past, v2); i >= 0 {
		t.Fatal("471 s 4K HEVC SDR admitted on v2")
	}
	if i, _ := expected(h264, endpoints[1].encodeMs); i != 2 {
		t.Fatalf("60 s 1080p H.264 on v1 at 90 s: rung %d", i)
	}
	if i, _ := expected(h264, 32_988); i != 2 {
		t.Fatal("60 s 1080p H.264 refused at 32,988 ms")
	}
	if i, _ := expected(h264, 32_987); i >= 0 {
		t.Fatal("60 s 1080p H.264 admitted at 32,987 ms")
	}
}

// The packaged probe clip (container/probe.mp4, as ffprobe reads it: 192x144 H.264 at 15/1 with 30 frames and AAC, each
// 2.000000 s) fits an encode time of 2,284 ms and no less: the Worker's PROBE_ENVELOPE_MS
// (src/mastodon/media-activation.ts; test-node/container-image.test.ts holds the two equal).
func TestProbeClipEnvelope(t *testing.T) {
	video := stream("video", "h264", 192, 144, "15/1", "2.000000")
	video.NbFrames = "30"
	clip := probeOf("2.000000", video, stream("audio", "aac", 0, 0, "0/0", "2.000000"))
	const envelope = 2284.0
	if _, refused := planNormalize(clip, envelope); refused != "" {
		t.Fatalf("refused at %v ms: %s", envelope, refused)
	}
	if _, refused := planNormalize(clip, envelope-1); refused != refuseEnvelope {
		t.Fatalf("got %q at %v ms", refused, envelope-1)
	}
}
