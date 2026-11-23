package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// ffmpeg's MP4 muxer always writes moov/udta/meta(hdlr mdir)/ilst, empty when
// -map_metadata -1 is set. stripMoovMetadata removes moov/udta and moov/meta
// and rewrites the file. With +faststart the moov precedes mdat, so every
// chunk offset (stco/co64) moves back by the number of bytes removed.
const maxMoovBytes = 64 << 20

type mp4box struct {
	typ          string
	start, size  int64
	headerLength int64
}

func readBoxes(r io.ReaderAt, start, end int64) ([]mp4box, error) {
	var out []mp4box
	hdr := make([]byte, 16)
	for p := start; p < end; {
		if end-p < 8 {
			return nil, fmt.Errorf("trailing %d bytes at %d", end-p, p)
		}
		if _, err := r.ReadAt(hdr[:8], p); err != nil {
			return nil, err
		}
		size := int64(binary.BigEndian.Uint32(hdr))
		typ := string(hdr[4:8])
		hl := int64(8)
		switch size {
		case 1:
			if _, err := r.ReadAt(hdr[8:16], p+8); err != nil {
				return nil, err
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16]))
			hl = 16
		case 0:
			size = end - p
		}
		if size < hl || p+size > end || size < 0 {
			return nil, fmt.Errorf("box %q at %d has bad size %d", typ, p, size)
		}
		out = append(out, mp4box{typ: typ, start: p, size: size, headerLength: hl})
		p += size
	}
	return out, nil
}

func stripMoovMetadata(path string) (removed int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	top, err := readBoxes(f, 0, st.Size())
	if err != nil {
		return 0, err
	}
	moovIdx, mdatIdx := -1, -1
	for i, b := range top {
		switch b.typ {
		case "moov":
			moovIdx = i
		case "mdat":
			if mdatIdx < 0 {
				mdatIdx = i
			}
		}
	}
	if moovIdx < 0 || mdatIdx < 0 {
		return 0, fmt.Errorf("missing moov or mdat")
	}
	moov := top[moovIdx]
	if moov.size > maxMoovBytes || moov.headerLength != 8 {
		return 0, fmt.Errorf("moov size %d not supported", moov.size)
	}
	buf := make([]byte, moov.size)
	if _, err := f.ReadAt(buf, moov.start); err != nil {
		return 0, err
	}
	src := bytesReaderAt(buf)
	children, err := readBoxes(src, 8, moov.size)
	if err != nil {
		return 0, err
	}
	var kept []byte
	kept = append(kept, buf[:8]...)
	for _, c := range children {
		if c.typ == "udta" || c.typ == "meta" {
			removed += c.size
			continue
		}
		kept = append(kept, buf[c.start:c.start+c.size]...)
	}
	if removed == 0 {
		return 0, nil
	}
	binary.BigEndian.PutUint32(kept[0:4], uint32(len(kept)))
	if moovIdx < mdatIdx {
		if err := shiftChunkOffsets(kept, -removed); err != nil {
			return 0, err
		}
	}

	tmp := path + ".strip"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp)
	if _, err := io.Copy(out, io.NewSectionReader(f, 0, moov.start)); err != nil {
		out.Close()
		return 0, err
	}
	if _, err := out.Write(kept); err != nil {
		out.Close()
		return 0, err
	}
	rest := moov.start + moov.size
	if _, err := io.Copy(out, io.NewSectionReader(f, rest, st.Size()-rest)); err != nil {
		out.Close()
		return 0, err
	}
	if err := out.Close(); err != nil {
		return 0, err
	}
	return removed, os.Rename(tmp, path)
}

// shiftChunkOffsets walks moov -> trak -> mdia -> minf -> stbl in place and
// adds delta to every stco/co64 entry.
func shiftChunkOffsets(moov []byte, delta int64) error {
	var walk func(start, end int64, depth int) error
	containers := map[string]bool{"trak": true, "mdia": true, "minf": true, "stbl": true}
	r := bytesReaderAt(moov)
	walk = func(start, end int64, depth int) error {
		boxes, err := readBoxes(r, start, end)
		if err != nil {
			return err
		}
		for _, b := range boxes {
			body := b.start + b.headerLength
			switch {
			case containers[b.typ] && depth < 5:
				if err := walk(body, b.start+b.size, depth+1); err != nil {
					return err
				}
			case b.typ == "stco":
				if b.size-b.headerLength < 8 {
					return fmt.Errorf("stco too short")
				}
				n := int64(binary.BigEndian.Uint32(moov[body+4:]))
				if body+8+n*4 > b.start+b.size {
					return fmt.Errorf("stco overflows")
				}
				for i := int64(0); i < n; i++ {
					at := body + 8 + i*4
					v := int64(binary.BigEndian.Uint32(moov[at:])) + delta
					if v < 0 {
						return fmt.Errorf("negative chunk offset")
					}
					binary.BigEndian.PutUint32(moov[at:], uint32(v))
				}
			case b.typ == "co64":
				if b.size-b.headerLength < 8 {
					return fmt.Errorf("co64 too short")
				}
				n := int64(binary.BigEndian.Uint32(moov[body+4:]))
				if body+8+n*8 > b.start+b.size {
					return fmt.Errorf("co64 overflows")
				}
				for i := int64(0); i < n; i++ {
					at := body + 8 + i*8
					v := int64(binary.BigEndian.Uint64(moov[at:])) + delta
					if v < 0 {
						return fmt.Errorf("negative chunk offset")
					}
					binary.BigEndian.PutUint64(moov[at:], uint64(v))
				}
			}
		}
		return nil
	}
	return walk(8, int64(len(moov)), 0)
}

type bytesReaderAt []byte

func (b bytesReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off > int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
