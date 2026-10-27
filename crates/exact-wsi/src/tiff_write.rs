//! Minimal BigTIFF writer: chunks are streamed to disk as they are produced, the IFDs are written at the end.

use crate::{Result, WsiError};
use std::{
    fs::File,
    io::{BufWriter, Seek, SeekFrom, Write},
};

pub struct Entry {
    pub tag: u16,
    pub typ: u16,
    pub count: u64,
    /// value bytes, little endian
    pub data: Vec<u8>,
}

impl Entry {
    pub fn raw(tag: u16, typ: u16, data: Vec<u8>) -> Self {
        let unit = match typ {
            3 | 8 => 2,
            4 | 9 | 11 | 13 => 4,
            5 | 10 | 12 | 16 | 17 | 18 => 8,
            _ => 1,
        };
        Self {
            tag,
            typ,
            count: (data.len() / unit) as u64,
            data,
        }
    }
    pub fn short(tag: u16, v: &[u16]) -> Self {
        Self {
            tag,
            typ: 3,
            count: v.len() as u64,
            data: v.iter().flat_map(|x| x.to_le_bytes()).collect(),
        }
    }
    pub fn long(tag: u16, v: &[u32]) -> Self {
        Self {
            tag,
            typ: 4,
            count: v.len() as u64,
            data: v.iter().flat_map(|x| x.to_le_bytes()).collect(),
        }
    }
    pub fn long8(tag: u16, v: &[u64]) -> Self {
        Self {
            tag,
            typ: 16,
            count: v.len() as u64,
            data: v.iter().flat_map(|x| x.to_le_bytes()).collect(),
        }
    }
}

pub struct TiffWriter {
    out: BufWriter<File>,
    pos: u64,
    pages: Vec<Vec<Entry>>,
}

fn io(e: std::io::Error) -> WsiError {
    WsiError(format!("write: {e}"))
}

impl TiffWriter {
    pub fn create(path: &str) -> Result<Self> {
        let f = File::create(path).map_err(io)?;
        let mut out = BufWriter::with_capacity(1 << 20, f);
        // "II", 43, offset size 8, 0, first IFD offset (patched in finish)
        out.write_all(&[0x49, 0x49, 43, 0, 8, 0, 0, 0])
            .map_err(io)?;
        out.write_all(&0u64.to_le_bytes()).map_err(io)?;
        Ok(Self {
            out,
            pos: 16,
            pages: Vec::new(),
        })
    }

    fn align(&mut self, to: u64) -> Result<()> {
        let pad = (to - self.pos % to) % to;
        if pad > 0 {
            self.out.write_all(&vec![0u8; pad as usize]).map_err(io)?;
            self.pos += pad;
        }
        Ok(())
    }

    /// Appends one tile/strip; returns (offset, length).
    pub fn write_chunk(&mut self, data: &[u8]) -> Result<(u64, u64)> {
        self.align(2)?;
        let off = self.pos;
        self.out.write_all(data).map_err(io)?;
        self.pos += data.len() as u64;
        Ok((off, data.len() as u64))
    }

    /// Makes everything written so far readable through another file handle.
    pub fn flush(&mut self) -> Result<()> {
        self.out.flush().map_err(io)
    }

    pub fn add_page(&mut self, entries: Vec<Entry>) {
        self.pages.push(entries);
    }

    /// Writes all IFDs, links them in the order they were added and patches the header.
    pub fn finish(mut self) -> Result<()> {
        let pages = std::mem::take(&mut self.pages);
        let mut ifd_offsets = Vec::new();
        let mut next_ptr_pos = Vec::new();
        for mut entries in pages {
            entries.sort_by_key(|e| e.tag);
            // out-of-line values first
            let mut value_offsets = Vec::new();
            for e in &entries {
                if e.data.len() > 8 {
                    self.align(8)?;
                    value_offsets.push(Some(self.pos));
                    self.out.write_all(&e.data).map_err(io)?;
                    self.pos += e.data.len() as u64;
                } else {
                    value_offsets.push(None);
                }
            }
            self.align(8)?;
            ifd_offsets.push(self.pos);
            self.out
                .write_all(&(entries.len() as u64).to_le_bytes())
                .map_err(io)?;
            for (e, vo) in entries.iter().zip(&value_offsets) {
                self.out.write_all(&e.tag.to_le_bytes()).map_err(io)?;
                self.out.write_all(&e.typ.to_le_bytes()).map_err(io)?;
                self.out.write_all(&e.count.to_le_bytes()).map_err(io)?;
                let mut v = [0u8; 8];
                match vo {
                    Some(o) => v.copy_from_slice(&o.to_le_bytes()),
                    None => v[..e.data.len()].copy_from_slice(&e.data),
                }
                self.out.write_all(&v).map_err(io)?;
            }
            next_ptr_pos.push(self.pos + 8 + entries.len() as u64 * 20);
            self.out.write_all(&0u64.to_le_bytes()).map_err(io)?;
            self.pos += 8 + entries.len() as u64 * 20 + 8;
        }
        self.out.flush().map_err(io)?;
        let f = self.out.get_mut();
        if let Some(first) = ifd_offsets.first() {
            f.seek(SeekFrom::Start(8)).map_err(io)?;
            f.write_all(&first.to_le_bytes()).map_err(io)?;
        }
        for i in 0..ifd_offsets.len().saturating_sub(1) {
            f.seek(SeekFrom::Start(next_ptr_pos[i])).map_err(io)?;
            f.write_all(&ifd_offsets[i + 1].to_le_bytes()).map_err(io)?;
        }
        f.sync_all().map_err(io)?;
        Ok(())
    }
}
