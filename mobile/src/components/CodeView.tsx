// Read-only source view with syntax highlighting, for the Files tab.
//
// Same highlighting as the desktop file viewer: highlight.js 11.11.1 with the
// vs2015 theme (index.html pins both), the same EXT_LANG → grammar mapping via
// the generated desktop-assets module, and the same dos/powershell extras the
// desktop side-loads because they're absent from the common bundle. So a file
// colours identically on the phone and on the desktop.
//
// It lives in a WebView because hljs emits HTML — there is no RN renderer for it.
// That matches XtermWebView's precedent (library from CDN; the phone has internet
// even when the desktop link is LAN-only).
import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const HLJS = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1';

// Beyond this, highlighting a file costs more than it's worth on a phone — hljs is
// O(n) but the DOM it builds is not free. Render it as plain text instead.
const MAX_HIGHLIGHT = 400_000;

const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${HLJS}/styles/vs2015.min.css">
<script src="${HLJS}/highlight.min.js"></script>
<script src="${HLJS}/languages/dos.min.js"></script>
<script src="${HLJS}/languages/powershell.min.js"></script>
<style>
  html,body{margin:0;background:#1e1e1e;color:#d4d4d4;-webkit-text-size-adjust:100%}
  /* The gutter must not scroll away from its lines, so the rows scroll as one
     block and the gutter cells stick to the left edge. */
  #code{display:table;min-width:100%;font:13px/19px ui-monospace,Menlo,Consolas,monospace}
  .row{display:table-row}
  .ln,.src{display:table-cell;vertical-align:top}
  .ln{
    position:sticky;left:0;z-index:1;
    padding:0 10px 0 12px;text-align:right;
    background:#1e1e1e;color:#5a5a5a;
    user-select:none;-webkit-user-select:none;
  }
  .src{padding-right:16px;white-space:pre;user-select:text;-webkit-user-select:text}
  #empty{padding:16px;color:#6e7681;font:13px system-ui}
</style>
</head><body><div id="code"></div><script>
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Port of hlLines() from src/renderer/shared/highlight.js: highlight the whole
  // block for correct multi-line context, then cut it into per-line HTML, re-opening
  // any span left open across a newline so every row is balanced on its own.
  const hlLines = (code, lang) => {
    let html;
    try {
      html = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch { return null; }
    const open = [], out = [];
    let line = '';
    const re = /<span [^>]*>|<\\/span>|\\n|[^<\\n]+/g;
    let m;
    while ((m = re.exec(html))) {
      const tok = m[0];
      if (tok === '\\n') { out.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
      else if (tok[1] === '/') { open.pop(); line += tok; }
      else if (tok[0] === '<') { open.push(tok); line += tok; }
      else line += tok;
    }
    out.push(line + '</span>'.repeat(open.length));
    return out;
  };

  const host = document.getElementById('code');

  // RN calls this with base64 (survives quoting) + the language id, or '' for none.
  window.__render = (b64, lang, plain) => {
    const code = decodeURIComponent(escape(atob(b64)));
    if (!code) { host.innerHTML = '<div id="empty">This file is empty.</div>'; return; }
    const lines = (plain ? null : hlLines(code, lang)) || code.split('\\n').map(esc);
    const width = String(lines.length).length;
    host.innerHTML = lines
      .map((h, i) => '<div class="row"><div class="ln" style="min-width:' + width + 'ch">'
        + (i + 1) + '</div><div class="src">' + (h || ' ') + '</div></div>')
      .join('');
  };
</script></body></html>`;

// btoa that survives non-Latin1 source (UTF-8 identifiers, comments, emoji).
function toBase64(s: string): string {
  const bytes = unescape(encodeURIComponent(s));
  return global.btoa ? global.btoa(bytes) : Buffer.from(bytes, 'binary').toString('base64');
}

export default function CodeView({ code, lang }: { code: string; lang: string | null }) {
  const web = useRef<WebView>(null);

  // The page is static; the content is injected once it exists. Re-running on
  // every code change would mean a full WebView reload.
  const render = useCallback(() => {
    const plain = code.length > MAX_HIGHLIGHT;
    const b64 = toBase64(code);
    web.current?.injectJavaScript(
      `window.__render("${b64}", ${JSON.stringify(lang ?? '')}, ${plain}); true;`,
    );
  }, [code, lang]);

  // Re-inject when the text changes under a live page (e.g. back from the editor
  // after a save). Before the page loads this is a no-op, and onLoadEnd covers it.
  useEffect(render, [render]);

  return (
    <WebView
      ref={web}
      source={{ html: HTML, baseUrl: Platform.OS === 'android' ? 'https://localhost' : undefined }}
      originWhitelist={['*']}
      onLoadEnd={render}
      style={styles.fill}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e1e' },
});
