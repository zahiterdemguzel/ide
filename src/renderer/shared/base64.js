// base64 ↔ binary helpers for the asset views. The 3D model viewer/editor moves
// whole files through `read-asset`/`write-asset` as base64, so it needs both
// directions: bytes in (decode a model's file) and bytes out (the GLB the editor
// re-exports). Pure (no DOM/Electron) so it's unit-testable.

export function base64ToArrayBuffer(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Encode bytes to base64 in fixed-size chunks. The naive
// `btoa(String.fromCharCode.apply(null, bytes))` blows the call stack on the
// multi-megabyte buffers a re-exported GLB produces (apply spreads every byte as
// an argument), so we build the binary string a chunk at a time instead.
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32 KB — well under the argument-count limit
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
