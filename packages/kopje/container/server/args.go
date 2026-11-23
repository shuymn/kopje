package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The demuxers ffmpeg may open (MP4/MOV, Matroska/WebM, Ogg, FLAC, MP3, WAV, AAC). The probe's format_name must be
// one of these exactly (ffprobe reports the demuxer's name).
var allowedDemuxers = map[string]bool{
	"mov,mp4,m4a,3gp,3g2,mj2": true,
	"matroska,webm":           true,
	"ogg":                     true,
	"flac":                    true,
	"mp3":                     true,
	"wav":                     true,
	"aac":                     true,
}

const formatWhitelist = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,flac,mp3,wav,aac"

// Every ffmpeg and ffprobe run reads only local files of the formats above.
var inputGuards = []string{"-protocol_whitelist", "file", "-format_whitelist", formatWhitelist}

var commonArgs = append([]string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y"}, inputGuards...)

// No container metadata, chapters or encoder strings reach the output.
var stripMetadata = []string{"-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"}

// Tone-maps HLG/PQ to SDR BT.709. ffmpeg applies the display matrix (autorotate) before this chain and leaves the
// output's matrix the identity.
const tonemap = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0," +
	"zscale=t=bt709:m=bt709:r=tv,format=yuv420p"

// Threading options under measurement (P27): the environment variable MEDIASRV_THREADS selects them at start, so a
// bench can compare them on one image. Kopje's Durable Object never sets it, so production runs with threadsDefault.
type threading struct {
	filters int // -filter_threads and -filter_complex_threads; 0 leaves ffmpeg's default
	encoder int // -threads for the video encoder (x264's threads); 0 leaves ffmpeg's default
}

var threadsDefault = threading{}

// parseThreading reads MEDIASRV_THREADS: "" or "default", "filters:<n>" or "all:<n>" with n in 1..16.
func parseThreading(s string) (threading, error) {
	if s == "" || s == "default" {
		return threadsDefault, nil
	}
	mode, count, ok := strings.Cut(s, ":")
	n, err := strconv.Atoi(count)
	if !ok || err != nil || n < 1 || n > 16 {
		return threading{}, fmt.Errorf("MEDIASRV_THREADS %q: want default, filters:<1-16> or all:<1-16>", s)
	}
	switch mode {
	case "filters":
		return threading{filters: n}, nil
	case "all":
		return threading{filters: n, encoder: n}, nil
	}
	return threading{}, fmt.Errorf("MEDIASRV_THREADS %q: want default, filters:<1-16> or all:<1-16>", s)
}

func (t threading) filterArgs() []string {
	if t.filters == 0 {
		return nil
	}
	n := strconv.Itoa(t.filters)
	return []string{"-filter_threads", n, "-filter_complex_threads", n}
}

func (t threading) encoderArgs() []string {
	if t.encoder == 0 {
		return nil
	}
	return []string{"-threads:v", strconv.Itoa(t.encoder)}
}

// iccDrop removes a frame's ICC profile; toBT709 converts a frame's primaries to BT.709 from its colour tags.
const (
	iccDrop = "sidedata=mode=delete:type=ICC_PROFILE"
	toBT709 = "zscale=p=bt709"
)

func cat(parts ...[]string) []string {
	var out []string
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// videoArgs encodes the plan's video (and audio) stream as H.264/AAC MP4 within its rung: libx264 veryfast CRF 23
// under a bitrate cap, yuv420p BT.709 limited range, rotation applied to pixels, no SEI (x264 writes its version
// there), empty encoder tags (they reach the avc1 compressor name) and the moov ahead of mdat. HDR is tone mapped to
// BT.709. SDR whose primaries are not BT.709, by its tags or by its ICC profile (iccdetect), is converted to BT.709
// primaries first, keeping its transfer; BT.709 and untagged SDR pass as they are. A frame's ICC profile is dropped
// after it is read (the MP4 muxer writes it into a colr box otherwise).
func videoArgs(p *plan, t threading, in, out string) []string {
	r := p.rung
	var vf []string
	switch {
	case p.hdr:
		vf = []string{iccDrop, tonemap}
	case p.icc:
		vf = []string{"iccdetect", toBT709, iccDrop}
	case p.primaries:
		vf = []string{toBT709, iccDrop}
	default:
		vf = []string{iccDrop}
	}
	fit := fmt.Sprintf("min(1,min(%d/max(iw,ih),%d/min(iw,ih)))", r.longEdge, r.shortEdge)
	vf = append(vf,
		fmt.Sprintf("scale=w='trunc(iw*%s/2)*2':h='trunc(ih*%s/2)*2':out_color_matrix=bt709:out_range=tv", fit, fit),
		"setsar=1", "format=yuv420p")
	maxrate := strconv.Itoa(p.maxrate)
	args := cat(commonArgs, t.filterArgs(), []string{"-i", "file:" + in, "-map", fmt.Sprintf("0:%d", p.videoIndex)})
	if p.audioIndex >= 0 {
		args = append(args, "-map", fmt.Sprintf("0:%d", p.audioIndex))
	}
	args = cat(args, stripMetadata, []string{
		"-sn", "-dn",
		"-vf", strings.Join(vf, ","),
		"-fpsmax", strconv.Itoa(r.fps), "-frames:v", strconv.Itoa(maxVideoFrames),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", maxrate, "-bufsize", maxrate,
		"-pix_fmt", "yuv420p",
		"-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
		"-bsf:v", "filter_units=remove_types=6",
		"-flags:v", "+bitexact",
		"-metadata:s:v", "encoder=",
	}, t.encoderArgs())
	if p.audioIndex >= 0 {
		args = append(args, "-c:a", "aac", "-profile:a", "aac_low", "-b:a", strconv.Itoa(r.audioBitrate), "-ac", "2",
			"-flags:a", "+bitexact", "-metadata:s:a", "encoder=")
	}
	return append(args, "-movflags", "+faststart", "-f", "mp4", "file:"+out)
}

// audioArgs encodes the plan's audio stream as MP3 (libmp3lame -q:a 2, as Mastodon) with no ID3 tags and no encoder
// string in the Xing frame.
func audioArgs(p *plan, in, out string) []string {
	return cat(commonArgs, []string{"-i", "file:" + in, "-map", fmt.Sprintf("0:%d", p.audioIndex)}, stripMetadata,
		[]string{
			"-vn", "-sn", "-dn",
			"-c:a", "libmp3lame", "-q:a", "2", "-flags:a", "+bitexact", "-metadata:s:a", "encoder=",
			"-id3v2_version", "0", "-write_id3v1", "0",
			"-f", "mp3", "file:" + out,
		})
}

// stillSeek is the time of the still: the keyframe at or before 10 % of the duration (0 when unknown).
func stillSeek(duration float64) float64 {
	if duration <= 0 || math.IsInf(duration, 0) {
		return 0
	}
	return duration * 0.1
}

// stillArgs writes one PNG of the keyframe at or before seek, long edge at most stillLongEdge, scaled before any tone
// mapping so the float chain runs on the small frame. Only keyframes are decoded. With icc, a frame's ICC profile (a
// PNG or other image codec in MOV can carry one) is read for its primaries and transfer (iccdetect); without, it is
// dropped. The still's profile is generated from the frame's colour tags (iccgen=force=1), never copied, so the still
// keeps its colour without the source's profile bytes; for an untagged or BT.709 frame it renders as the frame does.
// iccdetect refuses a profile it cannot use (a grayscale one, a malformed one): the caller runs again without icc.
func stillArgs(videoIndex int, hdr, icc bool, seek float64, in, out string) []string {
	fit := fmt.Sprintf("min(1,%d/max(iw,ih))", stillLongEdge)
	first := iccDrop
	if icc {
		first = "iccdetect"
	}
	vf := []string{first, fmt.Sprintf("scale=w='max(2,trunc(iw*%s))':h='max(2,trunc(ih*%s))'", fit, fit)}
	if hdr {
		vf = append(vf, tonemap)
	}
	vf = append(vf, "format=rgb24", "iccgen=force=1")
	return cat(commonArgs,
		[]string{"-skip_frame", "nokey", "-noaccurate_seek", "-ss", strconv.FormatFloat(seek, 'f', 3, 64),
			"-i", "file:" + in, "-map", fmt.Sprintf("0:%d", videoIndex)},
		stripMetadata,
		[]string{"-an", "-sn", "-dn", "-vf", strings.Join(vf, ","),
			"-frames:v", "1", "-c:v", "png", "-flags:v", "+bitexact", "-update", "1", "-f", "image2", "file:" + out})
}

func probeArgs(path string) []string {
	return cat([]string{"-v", "error"}, inputGuards,
		[]string{"-print_format", "json", "-show_format", "-show_streams", "file:" + path})
}

// frameProbeArgs decodes the first packet of the stream at index, for what only a frame carries (an image codec's ICC
// profile). It runs only after the header probe's limits passed, and the decoder refuses a frame over
// maxSourcePixels as well.
func frameProbeArgs(path string, index int) []string {
	return cat([]string{"-v", "error"}, inputGuards,
		[]string{"-max_pixels", strconv.Itoa(maxSourcePixels), "-select_streams", strconv.Itoa(index),
			"-read_intervals", "%+#1", "-print_format", "json", "-show_frames", "file:" + path})
}
