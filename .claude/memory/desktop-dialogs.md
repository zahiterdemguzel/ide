# Desktop dialogs — one layout, one stylesheet

Every desktop modal that **asks the user something or reports an error** is built
by a single file and painted by a single set of CSS rules:

- **Layout** — `src/renderer/shared/dialog.js`. `openDialog(spec)` builds the
  whole thing from a spec object. There is **no dialog markup in `index.html`**
  and nothing else may hand-roll dialog chrome.
- **Styles** — the `.dlg` family in `src/styles/base.css`. Style `.dlg`; a rule
  targeting a dialog's `#id` is the regression this setup exists to prevent.

Read this before adding a dialog or restyling one. (The phone app is separate:
[mobile-design.md](mobile-design.md).)

## Entry points

Call one of these — don't call `openDialog` directly unless you need a shape none
of them cover:

| Function | File | Returns |
|---|---|---|
| `confirmDialog({title, message, ok, danger})` | `shared/confirm.js` | `true` / `false` (Esc & backdrop → `false`) |
| `noticeDialog({title, message})` | `shared/confirm.js` | one-button acknowledge — a failure with nothing to decide |
| `promptText({title, label, value, ok, error})` | `shared/prompt.js` | trimmed string, or `null` if cancelled/blank |
| `pickOption({title, label, options, def})` | `shared/prompt.js` | picked value, or `null` — the `pickString` run-config list |
| `showWarning(message, title)` | `shared/warn.js` | non-fatal error; OK + Copy |
| `showError(message, title, {mono})` | `shared/warn.js` | failed git/CLI op; `mono` on by default for stderr |

`confirmDialog` is for a question with two answers. If the user has nothing to
decide, it's `noticeDialog` — passing `ok: 'OK'` to a confirm just adds a Cancel
button next to it that means the same thing.

## How openDialog works

A per-call native `<dialog class="dlg">`, appended, `showModal()`n, and removed on
close. Native (not a div + `.modal-backdrop`) because `showModal()` brings focus
trapping, Esc and `::backdrop` with it — verified `:modal` is true for all six.

Spec: `title`, `tone` (`'error'` reddens the title), `body`, `mono`, `label`,
`input`, `options`, `buttons`, `cancelValue`, `singleton`.
Buttons: `{label, value, variant: 'primary'|'secondary'|'danger', keepOpen, onClick}`
— `value` may be a function of the input's trimmed text (that's how `promptText`
maps blank → `null`). `keepOpen` is for Copy, which must not dismiss the text it
just copied. `singleton: 'warn'` means a burst of errors replaces the open dialog
instead of stacking a pile of them.

## Design rules

- **One primary per dialog, last in the row.** Accent weight marks the commit
  action; `-danger` (red) replaces it for destructive acts. Everything else is
  `-secondary`. The `pickString` list is `.dlg-option` rows — a stack of accent
  buttons reads as many commit actions.
- **`.is-error` reddens the title only.** The body stays neutral: a wall of red
  monospace is louder than the message ever warrants.
- **Focus rings are `--accent`.** `showModal()` autofocuses the first button, so
  the ring shows every time a dialog opens; the UA default paints it in the *OS*
  accent, the one colour in the dialog not coming from the theme.

## History

This started as **four** independent copies of the same box — `#confirm-dialog`
and `#git-error-dialog` in `git.css`, `#run-error-dialog` in `toolbar.css`, and a
parallel `.modal-*` family in `base.css` — plus three hand-rolled layouts (parked
markup in `index.html`, `prompt.js`, and a `pickOption` in `toolbar.js`). They had
drifted on padding (20/24 vs 16), title size, body colour, and button metrics
(`6px 18px`/13px vs `6px 14px`/12px), with the `::backdrop` rule copy-pasted six
times. Consolidating settled on the majority metrics, which also match
`.settings-primary`.

`.modal-backdrop` in `base.css` is **not** part of this — it's the overlay for
quick-open and the command palette, which anchor their own box near the top.
