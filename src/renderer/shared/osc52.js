console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/osc52.js'); // PERF-TEMP
// Decode an OSC 52 clipboard-set payload into the text the terminal app wants
// copied. Apps (notably the Claude CLI) copy by emitting `OSC 52 ; Pc ; Pd ST`
// rather than a key event: Pc is the target selection (c/p/…), Pd is the
// base64-encoded UTF-8 text. xterm hands the handler just the `Pc;Pd` portion.
//
// Returns the decoded string, or null for anything we shouldn't act on: a read
// request (`Pd` is "?"), an empty payload, or malformed base64. Kept Electron-
// and DOM-free (atob + TextDecoder are global in both the renderer and Node) so
// it stays unit-testable.
export function decodeOsc52(data) {
  if (typeof data !== 'string') return null;
  const sep = data.indexOf(';');
  const b64 = (sep === -1 ? data : data.slice(sep + 1)).trim();
  if (!b64 || b64 === '?') return null;
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes) || null;
  } catch {
    return null;
  }
}
