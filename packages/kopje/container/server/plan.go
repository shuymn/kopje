package main

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Limits on the source (Mastodon 4.7.5, app/models/media_attachment.rb) and on Kopje's output (design #1828,
// section 4.11).
const (
	maxSourcePixels    = 8_294_400 // 3840x2160
	maxSourceFPS       = 120
	maxVideoFrames     = 36_000
	videoDurationLimit = 600.0  // seconds
	audioDurationLimit = 1200.0 // seconds
	stillLongEdge      = 640
	// AV_OUTPUT_TARGET: what the bitrate cap aims a whole file at, below AV_OUTPUT_LIMIT.
	avOutputTarget  = 56 << 20
	maxVideoMaxrate = 8_000_000 // bits per second
	// The share of the encode time an estimate may take; the rest absorbs its error.
	estimateSafety = 0.7
)

// A rung of the output ladder: the longest duration it takes and the geometry and frame rate it keeps to. The rungs
// are starting values, set from the measurement of NORMALIZE_INSTANCE (P27).
type rung struct {
	maxDuration  float64
	longEdge     int
	shortEdge    int
	fps          int
	audioBitrate int
}

var ladder = []rung{
	{maxDuration: 120, longEdge: 1920, shortEdge: 1080, fps: 60, audioBitrate: 192_000},
	{maxDuration: 300, longEdge: 1280, shortEdge: 720, fps: 30, audioBitrate: 192_000},
	{maxDuration: videoDurationLimit, longEdge: 854, shortEdge: 480, fps: 30, audioBitrate: 128_000},
}

// Coefficients of the conservative estimate, in nanoseconds of wall time per pixel (decode and encode) and milliseconds
// per second of audio. Provisional upper bounds against P27's published wall times (standard-4, all:4; the aggregates
// on #1828), chosen so the estimate is at least the whole measured wall time of every published run with margin left
// for camera footage; to be replaced by the boundary bench's per-run encode times (#1828 PR2, A3). The codecs P27 did
// not measure (VP8, AV1, MPEG-4, the default) and VP9 (measured below its value) keep the spike's values.
var (
	decodeNsPerPixel = map[string]float64{"h264": 1.0, "hevc": 1.5, "vp9": 3.5, "vp8": 3, "av1": 8, "mpeg4": 2.5}
	// A codec outside the map counts as the slowest listed.
	decodeNsDefault   = 8.0
	tonemapNsPerPixel = 10.0
	encodeNsPerPixel  = 9.0
	audioMsPerSecond  = 40.0
	// Fixed work around the encode: ffmpeg's start, the moov rewrite and the still.
	fixedEstimateMs = 1500.0
)

type probeStream struct {
	Index          int        `json:"index"`
	CodecType      string     `json:"codec_type"`
	CodecName      string     `json:"codec_name"`
	Width          int        `json:"width"`
	Height         int        `json:"height"`
	ColorTransfer  string     `json:"color_transfer"`
	ColorPrimaries string     `json:"color_primaries"`
	SideDataList   []sideData `json:"side_data_list"`
	RFrameRate     string     `json:"r_frame_rate"`
	AvgFrameRate   string     `json:"avg_frame_rate"`
	NbFrames       string     `json:"nb_frames"`
	SampleRate     string     `json:"sample_rate"`
	Duration       string     `json:"duration"`
	Disposition    struct {
		AttachedPic int `json:"attached_pic"`
	} `json:"disposition"`
}

type probeResult struct {
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
	Streams []probeStream `json:"streams"`
}

// The frame probe's answer (frameProbeArgs): the first decoded frames, for what only a frame carries.
type frameProbe struct {
	Frames []struct {
		StreamIndex  int        `json:"stream_index"`
		SideDataList []sideData `json:"side_data_list"`
	} `json:"frames"`
}

type sideData struct {
	SideDataType string `json:"side_data_type"`
}

func iccIn(list []sideData) bool {
	for _, d := range list {
		if strings.EqualFold(d.SideDataType, "ICC profile") {
			return true
		}
	}
	return false
}

// limitsUnknown: the headers leave a limit unknown, so the probe runs again with stream discovery and the limits
// apply to what it found: no duration is declared, or the video stream declares no dimensions or no r_frame_rate (the
// highest rate a stream can reach; avg_frame_rate can hide a VFR peak, so it does not stand in). An input that still
// leaves one unknown is refused by planVideo, planAudio or the still's checks.
func limitsUnknown(p *probeResult) bool {
	if !declaresDuration(p) {
		return true
	}
	video, _ := selectStreams(p)
	return video != nil && (video.Width <= 0 || video.Height <= 0 || parseRate(video.RFrameRate) == 0)
}

// colourUnknown: the video stream declares no transfer or no primaries. The header probe reads colour from the
// container's colr box only; a file without one (a phone's HLG or PQ clip remuxed, say) carries it in the bitstream's
// VUI, which discovery decodes, and planned without it an HDR video would be neither tone mapped nor estimated as HDR.
// A video discovery still leaves untagged is untagged SDR.
func colourUnknown(p *probeResult) bool {
	video, _ := selectStreams(p)
	return video != nil && (!knownColour(video.ColorTransfer) || !knownColour(video.ColorPrimaries))
}

func knownColour(v string) bool { return v != "" && v != "unknown" }

// frameRate is the larger of the stream's declared rates (VFR and contradictory headers count at their largest); 0
// when it declares no r_frame_rate, which the limit needs.
func frameRate(video *probeStream) float64 {
	if parseRate(video.RFrameRate) == 0 {
		return 0
	}
	return math.Max(parseRate(video.RFrameRate), parseRate(video.AvgFrameRate))
}

// declaresDuration: the container or a stream declares a duration.
func declaresDuration(p *probeResult) bool {
	if parsePositive(p.Format.Duration) > 0 {
		return true
	}
	for _, s := range p.Streams {
		if parsePositive(s.Duration) > 0 {
			return true
		}
	}
	return false
}

// streamICC: the video stream carries an ICC profile on the stream (a MOV colr box). An image codec's own (a PNG's
// iCCP) is on its frames only: framesICC reads the frame probe for it.
func streamICC(video *probeStream) bool {
	return iccIn(video.SideDataList)
}

// framesICC: the frame probe's answer shows an ICC profile on a frame of the stream at index.
func framesICC(out []byte, index int) bool {
	var p frameProbe
	if json.Unmarshal(out, &p) != nil {
		return false
	}
	for _, f := range p.Frames {
		if f.StreamIndex == index && iccIn(f.SideDataList) {
			return true
		}
	}
	return false
}

// otherPrimaries: SDR video tagged with primaries other than BT.709 and a known transfer, which normalize converts
// to BT.709 before labelling the output BT.709.
func otherPrimaries(s *probeStream) bool {
	return !isHDR(s) && knownColour(s.ColorPrimaries) && s.ColorPrimaries != "bt709" && knownColour(s.ColorTransfer)
}

// A refusal of the input: the code the Worker records. Codes only, never ffmpeg's words.
type refusal string

const (
	refuseUnreadable refusal = "unreadable"
	refuseFormat     refusal = "format"
	refuseNoStream   refusal = "no_stream"
	refuseNoVideo    refusal = "no_video"
	refusePixels     refusal = "pixels"
	refuseFPS        refusal = "fps"
	refuseFrames     refusal = "frames"
	refuseDuration   refusal = "duration"
	refuseUnbounded  refusal = "unbounded"
	refuseEnvelope   refusal = "envelope"
	// An output shorter than the plan (checkOutput); a 400 "truncated" is a request body shorter than its length.
	refuseTruncated refusal = "truncated"
)

// What normalize does with an input, decided from the probe before any decoding.
type plan struct {
	kind       string // "video" or "audio"
	videoIndex int    // -1 for audio
	audioIndex int    // -1 for a video without audio
	audioRate  int    // the audio stream's declared sample rate, 0 when unknown
	duration   float64
	hdr        bool
	// icc: the video carries an ICC profile, which normalize reads (iccdetect) for its primaries and transfer;
	// primaries: it is tagged with primaries other than BT.709. Either converts the primaries to BT.709 (SDR only).
	icc        bool
	primaries  bool
	rung       rung
	maxrate    int
	estimateMs float64
}

func parseRate(s string) float64 {
	num, den, ok := strings.Cut(s, "/")
	n := parsePositive(num)
	if !ok || n == 0 {
		return n
	}
	d := parsePositive(den)
	if d == 0 {
		return 0
	}
	return n / d
}

func parsePositive(s string) float64 {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
		return 0
	}
	return v
}

func isHDR(s *probeStream) bool {
	return s.ColorTransfer == "arib-std-b67" || s.ColorTransfer == "smpte2084"
}

// selectStreams picks the streams the encoder maps: the first video stream that is not an attached picture and the
// first audio stream. Cover art and every other stream are ignored, as the encoder drops them.
func selectStreams(p *probeResult) (video, audio *probeStream) {
	for i := range p.Streams {
		s := &p.Streams[i]
		switch {
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && video == nil:
			video = s
		case s.CodecType == "audio" && audio == nil:
			audio = s
		}
	}
	return video, audio
}

// boundedDuration is the largest declared duration of the selected streams; a stream that declares none counts the
// container's (the Matroska demuxer records a WebM's duration on the segment only). 0 when a selected stream has
// neither.
func boundedDuration(p *probeResult, streams ...*probeStream) float64 {
	container := parsePositive(p.Format.Duration)
	longest := 0.0
	for _, s := range streams {
		if s == nil {
			continue
		}
		d := parsePositive(s.Duration)
		if d == 0 {
			d = container
		}
		if d == 0 {
			return 0
		}
		longest = math.Max(longest, d)
	}
	return longest
}

func rungFor(duration float64) rung {
	for _, r := range ladder {
		if duration <= r.maxDuration {
			return r
		}
	}
	return ladder[len(ladder)-1]
}

// videoMaxrate keeps a whole file near AV_OUTPUT_TARGET: with bufsize equal to maxrate, the overshoot is at most one
// second of maxrate.
func videoMaxrate(duration float64, audioBitrate int) int {
	byTarget := float64(avOutputTarget)*8/duration - float64(audioBitrate)
	return int(math.Min(maxVideoMaxrate, math.Max(byTarget, 0)))
}

// fitWithin scales w x h down (never up) so the long edge is at most long and the short edge at most short, to even
// dimensions, as the scale filter of normalizeArgs does.
func fitWithin(w, h, long, short int) (int, int) {
	l, s := max(w, h), min(w, h)
	f := math.Min(1, math.Min(float64(long)/float64(l), float64(short)/float64(s)))
	return int(float64(w)*f/2) * 2, int(float64(h)*f/2) * 2
}

// planNormalize decides the operation by the probed streams and refuses, before any decoding, an input outside the
// limits or whose conservative estimate does not fit encodeMs.
func planNormalize(p *probeResult, encodeMs float64) (*plan, refusal) {
	video, audio := selectStreams(p)
	if video != nil {
		return planVideo(p, video, audio, encodeMs)
	}
	if audio != nil {
		return planAudio(p, audio, encodeMs)
	}
	return nil, refuseNoStream
}

func planVideo(p *probeResult, video, audio *probeStream, encodeMs float64) (*plan, refusal) {
	if video.CodecName == "" || video.Width <= 0 || video.Height <= 0 {
		return nil, refuseNoVideo
	}
	if video.Width*video.Height > maxSourcePixels {
		return nil, refusePixels
	}
	fps := frameRate(video)
	if fps == 0 || fps > maxSourceFPS {
		return nil, refuseFPS
	}
	duration := boundedDuration(p, video, audio)
	if duration == 0 {
		return nil, refuseUnbounded
	}
	if duration > videoDurationLimit {
		return nil, refuseDuration
	}
	frames := math.Max(parsePositive(video.NbFrames), duration*fps)
	if frames > maxVideoFrames {
		return nil, refuseFrames
	}
	r := rungFor(duration)
	audioBitrate := 0
	if audio != nil {
		audioBitrate = r.audioBitrate
	}
	outW, outH := fitWithin(video.Width, video.Height, r.longEdge, r.shortEdge)
	outFrames := math.Min(frames, math.Ceil(duration*float64(r.fps)))
	decode, ok := decodeNsPerPixel[video.CodecName]
	if !ok {
		decode = decodeNsDefault
	}
	hdr := isHDR(video)
	if hdr {
		decode += tonemapNsPerPixel
	}
	estimate := fixedEstimateMs +
		float64(video.Width*video.Height)*frames*decode/1e6 +
		float64(outW*outH)*outFrames*encodeNsPerPixel/1e6
	audioIndex, audioRate := -1, 0
	if audio != nil {
		estimate += duration * audioMsPerSecond
		audioIndex, audioRate = audio.Index, int(parsePositive(audio.SampleRate))
	}
	if estimate > estimateSafety*encodeMs {
		return nil, refuseEnvelope
	}
	return &plan{
		kind:       "video",
		videoIndex: video.Index,
		audioIndex: audioIndex,
		audioRate:  audioRate,
		duration:   duration,
		hdr:        hdr,
		icc:        streamICC(video),
		primaries:  otherPrimaries(video),
		rung:       r,
		maxrate:    videoMaxrate(duration, audioBitrate),
		estimateMs: estimate,
	}, ""
}

func planAudio(p *probeResult, audio *probeStream, encodeMs float64) (*plan, refusal) {
	duration := boundedDuration(p, audio)
	if duration == 0 {
		return nil, refuseUnbounded
	}
	if duration > audioDurationLimit {
		return nil, refuseDuration
	}
	estimate := fixedEstimateMs + duration*audioMsPerSecond
	if estimate > estimateSafety*encodeMs {
		return nil, refuseEnvelope
	}
	return &plan{kind: "audio", videoIndex: -1, audioIndex: audio.Index, audioRate: int(parsePositive(audio.SampleRate)),
		duration: duration, estimateMs: estimate}, ""
}
