package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func box(typ string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	out := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(out, uint32(8+len(body)))
	copy(out[4:], typ)
	return append(out, body...)
}

func u32s(values ...uint32) []byte {
	out := make([]byte, 4*len(values))
	for i, v := range values {
		binary.BigEndian.PutUint32(out[4*i:], v)
	}
	return out
}

// A faststart MP4 as ffmpeg's muxer writes it: ftyp, moov (with the empty udta/meta/ilst it always adds), a free box
// and mdat, its chunk offsets into mdat.
func faststart(offsets func(mdatData int) []uint32, withUdta bool) ([]byte, int) {
	ftyp := box("ftyp", []byte("isom"), u32s(512), []byte("isomiso2avc1mp41"))
	build := func(offs []uint32) []byte {
		stco := box("stco", u32s(0, uint32(len(offs))), u32s(offs...))
		trak := box("trak", box("mdia", box("minf", box("stbl", stco))))
		children := [][]byte{box("mvhd", make([]byte, 100)), trak}
		if withUdta {
			children = append(children, box("udta", box("meta", u32s(0), box("hdlr", make([]byte, 25)), box("ilst"))))
		}
		return box("moov", children...)
	}
	// Two passes: the offsets depend on moov's own size.
	moov := build(offsets(0))
	mdatData := len(ftyp) + len(moov) + 8 + 8
	moov = build(offsets(mdatData))
	file := bytes.Join([][]byte{ftyp, moov, box("free"), box("mdat", []byte("0123456789abcdef"))}, nil)
	return file, mdatData
}

func TestStripMoovMetadataRemovesUdtaAndShiftsOffsets(t *testing.T) {
	file, mdatData := faststart(func(d int) []uint32 { return []uint32{uint32(d), uint32(d + 10)} }, true)
	path := filepath.Join(t.TempDir(), "out.mp4")
	if err := os.WriteFile(path, file, 0o600); err != nil {
		t.Fatal(err)
	}
	removed, err := stripMoovMetadata(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if removed <= 0 || int64(len(got)) != int64(len(file))-removed || bytes.Contains(got, []byte("udta")) ||
		bytes.Contains(got, []byte("ilst")) {
		t.Fatalf("removed %d, %d -> %d bytes", removed, len(file), len(got))
	}
	stco := bytes.Index(got, []byte("stco"))
	first := int(binary.BigEndian.Uint32(got[stco+12:]))
	second := int(binary.BigEndian.Uint32(got[stco+16:]))
	if first != mdatData-int(removed) || second != first+10 || string(got[first:first+10]) != "0123456789" {
		t.Fatalf("offsets %d %d, mdat data at %d", first, second, mdatData-int(removed))
	}
}

func TestStripMoovMetadataLeavesAFileWithoutUdta(t *testing.T) {
	file, _ := faststart(func(d int) []uint32 { return []uint32{uint32(d)} }, false)
	path := filepath.Join(t.TempDir(), "out.mp4")
	if err := os.WriteFile(path, file, 0o600); err != nil {
		t.Fatal(err)
	}
	if removed, err := stripMoovMetadata(path); err != nil || removed != 0 {
		t.Fatalf("removed %d, %v", removed, err)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, file) {
		t.Fatal("file changed")
	}
}

func TestStripMoovMetadataRefusesMalformedBoxes(t *testing.T) {
	short := box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stco", u32s(0)))))), box("udta"))
	cases := map[string][]byte{
		"no mdat":        box("moov", box("mvhd")),
		"bad size":       append(box("moov", box("mvhd")), 0, 0, 0, 99, 'm', 'd', 'a', 't'),
		"stco too short": append(append([]byte{}, short...), box("mdat", []byte("x"))...),
	}
	for name, file := range cases {
		path := filepath.Join(t.TempDir(), "out.mp4")
		if err := os.WriteFile(path, file, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := stripMoovMetadata(path); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}
