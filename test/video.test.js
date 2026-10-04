import assert from "node:assert/strict";
import test from "node:test";
import { movieDurationSeconds } from "../src/video.js";

export function testMp4(duration = 2, { version = 0, extended = false } = {}) {
  function box(type, bytes) {
    const header = Buffer.alloc(extended ? 16 : 8);
    header.writeUInt32BE(extended ? 1 : header.length + bytes.length);
    header.write(type, 4);
    if (extended) header.writeBigUInt64BE(BigInt(header.length + bytes.length), 8);
    return Buffer.concat([header, bytes]);
  }
  const header = Buffer.alloc(version === 1 ? 32 : 20);
  header[0] = version;
  const scaleOffset = version === 1 ? 20 : 12;
  header.writeUInt32BE(1000, scaleOffset);
  if (version === 1) header.writeBigUInt64BE(BigInt(duration * 1000), scaleOffset + 4);
  else header.writeUInt32BE(duration * 1000, scaleOffset + 4);
  return Buffer.concat([box("ftyp", Buffer.from("isom0000isom")), box("moov", box("mvhd", header))]);
}

test("reads MP4 movie durations with both header versions and extended box lengths", () => {
  assert.equal(movieDurationSeconds(testMp4(2)), 2);
  assert.equal(movieDurationSeconds(testMp4(65, { version: 1 })), 65);
  assert.equal(movieDurationSeconds(testMp4(12, { extended: true })), 12);
});

test("rejects missing, unknown, truncated, or zero-duration MP4 headers", () => {
  for (const bytes of [Buffer.from("not a video"), testMp4(0), testMp4(2).subarray(0, 30)]) {
    assert.throws(() => movieDurationSeconds(bytes), /duration|MP4/i);
  }
  const invalid = testMp4(2);
  invalid[invalid.indexOf("mvhd") + 4] = 2;
  assert.throws(() => movieDurationSeconds(invalid), /duration|MP4/i);
});

test("reads legacy QuickTime headers without requiring an MP4 file-type box", () => {
  const movie = testMp4(3).subarray(20);
  assert.equal(movieDurationSeconds(movie, { quickTime: true }), 3);
  assert.throws(() => movieDurationSeconds(movie), /MP4/);
});
