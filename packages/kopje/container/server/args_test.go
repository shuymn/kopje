package main

import (
	"slices"
	"strings"
	"testing"
)

// The value following flag in args, or "" when flag is absent.
func valueOf(args []string, flag string) string {
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		return ""
	}
	return args[i+1]
}

func hasPair(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

func videoPlan(hdr bool, audio int) *plan {
	return &plan{kind: "video", videoIndex: 0, audioIndex: audio, duration: 60, hdr: hdr, rung: rungFor(60),
		maxrate: videoMaxrate(60, 192_000)}
}

// Every run reads local files of the allowed demuxers only, and no container metadata, chapters or encoder strings
// reach an output.
func TestEveryCommandGuardsItsInputAndStripsMetadata(t *testing.T) {
	commands := map[string][]string{
		"video": videoArgs(videoPlan(false, 1), threadsDefault, "in", "out"),
		"audio": audioArgs(&plan{kind: "audio", videoIndex: -1, audioIndex: 0}, "in", "out"),
		"still": stillArgs(0, false, true, 1, "in", "out"),
	}
	for name, args := range commands {
		if !hasPair(args, "-protocol_whitelist", "file") || !hasPair(args, "-format_whitelist", formatWhitelist) {
			t.Fatalf("%s: input guards missing: %v", name, args)
		}
		if !hasPair(args, "-map_metadata", "-1") || !hasPair(args, "-map_chapters", "-1") ||
			!hasPair(args, "-fflags", "+bitexact") {
			t.Fatalf("%s: metadata not stripped: %v", name, args)
		}
		if valueOf(args, "-i") != "file:in" {
			t.Fatalf("%s: input %q", name, valueOf(args, "-i"))
		}
		for _, a := range args {
			if strings.HasPrefix(a, "http") || strings.Contains(a, "lavfi") {
				t.Fatalf("%s: %q", name, a)
			}
		}
	}
	probe := probeArgs("in")
	if !hasPair(probe, "-protocol_whitelist", "file") || !hasPair(probe, "-format_whitelist", formatWhitelist) {
		t.Fatalf("probe: %v", probe)
	}
	// The first frames too: an image codec's ICC profile is on its frames only (hasICC).
	if !slices.Contains(probe, "-show_frames") || !hasPair(probe, "-read_intervals", "%+#1") {
		t.Fatalf("probe reads no frame: %v", probe)
	}
	for _, d := range strings.Split(formatWhitelist, ",") {
		found := false
		for name := range allowedDemuxers {
			found = found || slices.Contains(strings.Split(name, ","), d)
		}
		if !found {
			t.Fatalf("whitelisted demuxer %q is not an allowed format", d)
		}
	}
}

func TestVideoArgsPinTheEncoding(t *testing.T) {
	args := videoArgs(videoPlan(false, 1), threadsDefault, "in", "out")
	pairs := [][2]string{
		{"-c:v", "libx264"}, {"-preset", "veryfast"}, {"-crf", "23"}, {"-pix_fmt", "yuv420p"},
		{"-maxrate", "7637367"}, {"-bufsize", "7637367"},
		{"-color_primaries", "bt709"}, {"-color_trc", "bt709"}, {"-colorspace", "bt709"}, {"-color_range", "tv"},
		{"-bsf:v", "filter_units=remove_types=6"}, {"-flags:v", "+bitexact"}, {"-metadata:s:v", "encoder="},
		{"-fpsmax", "60"}, {"-frames:v", "36000"},
		{"-c:a", "aac"}, {"-profile:a", "aac_low"}, {"-b:a", "192000"}, {"-ac", "2"}, {"-metadata:s:a", "encoder="},
		{"-movflags", "+faststart"}, {"-f", "mp4"}, {"-map", "0:0"}, {"-map", "0:1"},
	}
	for _, p := range pairs {
		if !hasPair(args, p[0], p[1]) {
			t.Fatalf("missing %s %s in %v", p[0], p[1], args)
		}
	}
	if !slices.Contains(args, "-sn") || !slices.Contains(args, "-dn") {
		t.Fatalf("subtitle or data streams kept: %v", args)
	}
	vf := valueOf(args, "-vf")
	// A frame's ICC profile goes first (the MP4 muxer would write the source's bytes into a colr box).
	if !strings.HasPrefix(vf, "sidedata=mode=delete:type=ICC_PROFILE,") || strings.Contains(vf, "tonemap") ||
		!strings.Contains(vf, "1920/max(iw,ih),1080/min(iw,ih)") {
		t.Fatalf("filter %q", vf)
	}
	hdr := valueOf(videoArgs(videoPlan(true, 1), threadsDefault, "in", "out"), "-vf")
	if !strings.HasPrefix(hdr, iccDrop+","+tonemap) {
		t.Fatalf("HDR filter %q", hdr)
	}
	silent := videoArgs(videoPlan(false, -1), threadsDefault, "in", "out")
	if slices.Contains(silent, "-c:a") || hasPair(silent, "-map", "0:-1") {
		t.Fatalf("a silent video gets an audio track: %v", silent)
	}
	long := &plan{kind: "video", videoIndex: 0, audioIndex: 1, duration: 500, rung: rungFor(500), maxrate: 1}
	if a := videoArgs(long, threadsDefault, "in", "out"); !hasPair(a, "-b:a", "128000") || !hasPair(a, "-fpsmax", "30") ||
		!strings.Contains(valueOf(a, "-vf"), "854/max(iw,ih),480/min(iw,ih)") {
		t.Fatalf("480p rung: %v", a)
	}
}

func TestAudioArgsPinTheEncoding(t *testing.T) {
	args := audioArgs(&plan{kind: "audio", videoIndex: -1, audioIndex: 2}, "in", "out")
	for _, p := range [][2]string{{"-c:a", "libmp3lame"}, {"-q:a", "2"}, {"-id3v2_version", "0"},
		{"-write_id3v1", "0"}, {"-flags:a", "+bitexact"}, {"-metadata:s:a", "encoder="}, {"-f", "mp3"},
		{"-map", "0:2"}} {
		if !hasPair(args, p[0], p[1]) {
			t.Fatalf("missing %s %s in %v", p[0], p[1], args)
		}
	}
	if !slices.Contains(args, "-vn") {
		t.Fatalf("video kept: %v", args)
	}
}

func TestStillArgs(t *testing.T) {
	args := stillArgs(3, true, true, 6, "in", "out")
	for _, p := range [][2]string{{"-skip_frame", "nokey"}, {"-ss", "6.000"}, {"-map", "0:3"}, {"-frames:v", "1"},
		{"-c:v", "png"}, {"-flags:v", "+bitexact"}} {
		if !hasPair(args, p[0], p[1]) {
			t.Fatalf("missing %s %s in %v", p[0], p[1], args)
		}
	}
	vf := valueOf(args, "-vf")
	if !strings.HasPrefix(vf, "iccdetect,scale=") || !strings.Contains(vf, "640/max(iw,ih)") ||
		!strings.Contains(vf, tonemap) || !strings.HasSuffix(vf, ",format=rgb24,iccgen=force=1") {
		t.Fatalf("filter %q", vf)
	}
	// -ss before -i: an input seek, which -skip_frame nokey turns into the keyframe at or before it.
	if slices.Index(args, "-ss") > slices.Index(args, "-i") {
		t.Fatalf("output seek: %v", args)
	}
	// Without icc (the run after iccdetect refused a profile), the profile is dropped and the still's own generated.
	plain := valueOf(stillArgs(3, false, false, 6, "in", "out"), "-vf")
	if !strings.HasPrefix(plain, iccDrop+",scale=") || !strings.HasSuffix(plain, ",format=rgb24,iccgen=force=1") {
		t.Fatalf("filter without icc %q", plain)
	}
}

// SDR with other primaries, by tag or by ICC profile, is converted to BT.709 before the output is labelled BT.709;
// BT.709 or untagged SDR and HDR (tone mapped to BT.709) are not.
func TestVideoArgsConvertOtherPrimaries(t *testing.T) {
	cases := []struct {
		name   string
		plan   func(*plan)
		prefix string
	}{
		{"bt709 or untagged", func(*plan) {}, iccDrop + ",scale="},
		{"icc", func(p *plan) { p.icc = true }, "iccdetect,zscale=p=bt709," + iccDrop + ",scale="},
		{"tagged", func(p *plan) { p.primaries = true }, "zscale=p=bt709," + iccDrop + ",scale="},
		{"hdr", func(p *plan) { p.hdr, p.icc, p.primaries = true, true, true }, iccDrop + "," + tonemap + ",scale="},
	}
	for _, c := range cases {
		p := videoPlan(false, 1)
		c.plan(p)
		if vf := valueOf(videoArgs(p, threadsDefault, "in", "out"), "-vf"); !strings.HasPrefix(vf, c.prefix) {
			t.Fatalf("%s: %q", c.name, vf)
		}
	}
}

// The threading options Kopje runs with (P27 pins the measured choice here) and the bench's alternatives.
func TestThreadingOptions(t *testing.T) {
	args := videoArgs(videoPlan(false, 1), threadsDefault, "in", "out")
	for _, flag := range []string{"-threads", "-threads:v", "-filter_threads", "-filter_complex_threads"} {
		if slices.Contains(args, flag) {
			t.Fatalf("default sets %s: %v", flag, args)
		}
	}
	cases := map[string]threading{"": threadsDefault, "default": threadsDefault, "filters:2": {filters: 2},
		"all:4": {filters: 4, encoder: 4}}
	for in, want := range cases {
		got, err := parseThreading(in)
		if err != nil || got != want {
			t.Fatalf("%q: %+v %v", in, got, err)
		}
	}
	for _, bad := range []string{"all", "all:0", "all:17", "filters:x", "x264:2", "default:1"} {
		if _, err := parseThreading(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	all := videoArgs(videoPlan(false, 1), threading{filters: 4, encoder: 4}, "in", "out")
	if !hasPair(all, "-filter_threads", "4") || !hasPair(all, "-filter_complex_threads", "4") ||
		!hasPair(all, "-threads:v", "4") || slices.Index(all, "-filter_threads") > slices.Index(all, "-i") {
		t.Fatalf("all:4: %v", all)
	}
}
