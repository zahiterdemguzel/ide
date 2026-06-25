// xterm.js is loaded as a classic <script> before the module graph, so its
// globals are available. Re-export them here so feature modules import from one
// place instead of reaching into `window`.
export const Terminal = window.Terminal;
export const FitAddon = window.FitAddon.FitAddon;

export function termTheme() {
  return {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  };
}
