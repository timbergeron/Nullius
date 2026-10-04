// Read MP4 and QuickTime container headers. Decoding remains with the vision provider.
function findBox(bytes, start, end, wanted) {
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new Error("invalid MP4/MOV container");
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerLength = 8;
    if (size === 1) {
      if (end - offset < 16) throw new Error("invalid MP4/MOV container");
      size = Number(bytes.readBigUInt64BE(offset + 8));
      headerLength = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerLength || size > end - offset) {
      throw new Error("invalid MP4/MOV container");
    }
    if (type === wanted) return { start: offset + headerLength, end: offset + size };
    offset += size;
  }
  return null;
}

export function movieDurationSeconds(bytes, { quickTime = false } = {}) {
  if (!quickTime && !findBox(bytes, 0, bytes.length, "ftyp")) throw new Error("invalid MP4/MOV container");
  const movie = findBox(bytes, 0, bytes.length, "moov");
  const header = movie && findBox(bytes, movie.start, movie.end, "mvhd");
  if (!header) throw new Error("video duration could not be verified");
  const version = bytes[header.start];
  if (![0, 1].includes(version) || header.end - header.start < (version === 1 ? 32 : 20)) {
    throw new Error("video duration could not be verified");
  }
  const scaleOffset = header.start + (version === 1 ? 20 : 12);
  const timescale = bytes.readUInt32BE(scaleOffset);
  const ticks = version === 1 ? Number(bytes.readBigUInt64BE(scaleOffset + 4)) : bytes.readUInt32BE(scaleOffset + 4);
  const duration = ticks / timescale;
  if (!timescale || !Number.isFinite(duration) || duration <= 0) throw new Error("video duration could not be verified");
  return duration;
}
