package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
)

// The PNG encoder writes the frame's metadata back: an input whose frames carry EXIF (a PNG in a MOV with an eXIf
// chunk) yields a still with that eXIf chunk. stripPNG keeps only the chunks that draw the image, so no metadata of a
// source survives into a still: the critical chunks, transparency, and the colour and pixel-size tags.
var keptPNGChunks = map[string]bool{
	"IHDR": true, "PLTE": true, "IDAT": true, "IEND": true,
	"tRNS": true, "sRGB": true, "gAMA": true, "cHRM": true, "cICP": true, "pHYs": true,
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// stripPNG rewrites the PNG at path with only keptPNGChunks, after checking every chunk's length and CRC and that the
// file is IHDR first and ends at IEND.
func stripPNG(path string) error {
	in, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out, err := strippedPNG(in)
	if err != nil {
		return err
	}
	tmp := path + ".strip"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func strippedPNG(in []byte) ([]byte, error) {
	if !bytes.HasPrefix(in, pngSignature) {
		return nil, errors.New("not a PNG")
	}
	out := append([]byte{}, pngSignature...)
	for p, first := len(pngSignature), true; ; first = false {
		if len(in)-p < 12 {
			return nil, errors.New("truncated chunk")
		}
		n := binary.BigEndian.Uint32(in[p:])
		if uint64(n) > uint64(len(in)-p-12) {
			return nil, errors.New("chunk past the end")
		}
		end := p + 12 + int(n)
		typ := string(in[p+4 : p+8])
		if crc32.ChecksumIEEE(in[p+4:end-4]) != binary.BigEndian.Uint32(in[end-4:]) {
			return nil, errors.New("bad chunk CRC")
		}
		if first != (typ == "IHDR") {
			return nil, errors.New("IHDR is not first")
		}
		if keptPNGChunks[typ] {
			out = append(out, in[p:end]...)
		}
		p = end
		if typ == "IEND" {
			if p != len(in) {
				return nil, errors.New("bytes after IEND")
			}
			return out, nil
		}
	}
}
