// Test helpers: tiny byte sequences that pass the proxy's JPEG/PNG sniffing.
// (Only imported from *.test.ts files.)

/** Minimal JPEG header with an SOF0 segment declaring width x height. */
export function fakeJpeg(width = 640, height = 360, padding = 32): Uint8Array {
  const sof = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 (tiny)
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  return new Uint8Array([...sof, ...new Array(padding).fill(0), 0xff, 0xd9]);
}

/** Minimal PNG signature + IHDR declaring width x height. */
export function fakePng(width = 320, height = 240): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
