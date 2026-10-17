// Cursor-style AI features for the Monaco editor:
//   - ghost-text inline completions (Tab accepts, Cmd/Ctrl+Right accepts a word)
//   - Cmd/Ctrl+K inline edit: prompt widget -> streamed rewrite -> reviewable
//     inline diff with Accept / Reject and follow-up refinement
//   - Cmd/Ctrl+L: add the selection to the active Claude session as an @mention
//   - context-menu actions and "Fix with AI" quick fixes for diagnostics
// The model calls run in the main process (src/main/ai-assist.js) through
// window.api.ai*. See .claude/memory/ai-assist.md.
import { t } from '../../i18n/index.js';

const INLINE_MAX_FILE_CHARS = 500000;
const INLINE_PREFIX_CHARS = 4000;
const INLINE_SUFFIX_CHARS = 2000;
const INLINE_DEBOUNCE_MS = 300;
const INLINE_CACHE_SIZE = 40;
const EDIT_PREFIX_CHARS = 6000;
const EDIT_SUFFIX_CHARS = 3000;
const CONTEXT_MENU_GROUP = '1_claude';
const FIX_COMMAND_ID = 'claude.ai.fixDiagnostic';
const ASK_FIX_COMMAND_ID = 'claude.ai.askSessionToFixDiagnostic';
const INLINE_EDIT_CONTEXT_KEY = 'claudeAiInlineEditActive';
const INLINE_REVIEW_CONTEXT_KEY = 'claudeAiInlineEditReview';

let monaco = null;
let host = null;
let attachedEditor = null;
let activeSession = null;
let inlineEditKey = null;
let inlineReviewKey = null;

// --- Status ----------------------------------------------------------------------

const statusListeners = new Set();
let tokenPresent = false;
let lastCallOk = null;
let busyEdits = 0;

export function aiStatus() {
  return { available: tokenPresent && lastCallOk !== false, busy: busyEdits > 0 };
}

export function onAiStatus(cb) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function emitStatus() {
  const current = aiStatus();
  for (const cb of statusListeners) {
    try { cb(current); } catch (err) { console.error('[ai status listener]', err); }
  }
}

async function refreshAvailability() {
  try {
    const s = await window.api.aiStatus();
    tokenPresent = !!s.tokenPresent;
    if (s.lastCallOk != null) lastCallOk = s.lastCallOk;
  } catch { tokenPresent = false; }
  emitStatus();
}

// Fold one completion/edit outcome into the status (aborts say nothing).
function noteOutcome({ ok, error, aborted }) {
  if (aborted || error === 'aborted') return;
  if (error === 'no_token') tokenPresent = false;
  else if (ok) { tokenPresent = true; lastCallOk = true; } else lastCallOk = false;
  emitStatus();
}

let requestSeq = 0;
const nextRequestId = (kind) => `${kind}-${Date.now().toString(36)}-${++requestSeq}`;

// --- Shared helpers ----------------------------------------------------------------

const LF = () => monaco.editor.EndOfLinePreference.LF;

// Up to `before` chars ending at `position` and `after` chars starting there.
function textAround(model, position, before, after) {
  const offset = model.getOffsetAt(position);
  const start = model.getPositionAt(Math.max(0, offset - before));
  const end = model.getPositionAt(Math.min(model.getValueLength(), offset + after));
  return {
    prefix: model.getValueInRange(monaco.Range.fromPositions(start, position), LF()),
    suffix: model.getValueInRange(monaco.Range.fromPositions(position, end), LF()),
  };
}

const lineEndPosition = (model, line) => ({ lineNumber: line, column: model.getLineMaxColumn(line) });
const leadingWhitespace = (line) => line.match(/^[ \t]*/)[0];

function commonIndent(text) {
  let common = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const indent = leadingWhitespace(line);
    if (common === null || indent.length < common.length) common = indent;
  }
  return common || '';
}

// The selection's line span; a selection ending at column 1 of the next line
// doesn't include that line.
function selectedLines(selection) {
  let end = selection.endLineNumber;
  if (selection.endColumn === 1 && end > selection.startLineNumber) end--;
  return { start: selection.startLineNumber, end };
}

// `@path#L3-9 ` (or `@path ` with nothing selected), the mention syntax Claude
// Code resolves to that file range. The trailing space ends the mention.
function mentionFor(editor) {
  const rel = host.relPath(editor.getModel());
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return `@${rel} `;
  const { start, end } = selectedLines(selection);
  return start === end ? `@${rel}#L${start} ` : `@${rel}#L${start}-${end} `;
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

// --- Ghost-text inline completions ------------------------------------------------------

// Small LRU of completions keyed by the text around the cursor, so backspacing
// and retyping (or Monaco re-asking) re-shows a suggestion without a round-trip.
class CompletionCache {
  constructor(limit) { this.limit = limit; this.entries = new Map(); }
  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
}

const NO_COMPLETIONS = { items: [] };

function isInlineCompletionWanted(model, prefix, suffix, context) {
  if (!host.isInlineEnabled()) return false;
  if (context.selectedSuggestionInfo) return false; // the suggest widget owns this moment
  if (model.getValueLength() > INLINE_MAX_FILE_CHARS) return false;
  if (attachedEditor?.getModel() === model && attachedEditor.getOption(monaco.editor.EditorOption.readOnly)) return false;
  if (activeSession?.model === model) return false;
  // Mid-identifier: an insertion would split the word.
  return !(/\w/.test(prefix.slice(-1)) && /\w/.test(suffix.slice(0, 1)));
}

function registerInlineCompletions() {
  const cache = new CompletionCache(INLINE_CACHE_SIZE);
  monaco.languages.registerInlineCompletionsProvider('*', {
    displayName: 'Claude',
    // Monaco waits this long after typing stops before asking (and cancels the
    // token if typing resumes) — this is the debounce.
    debounceDelayMs: INLINE_DEBOUNCE_MS,
    async provideInlineCompletions(model, position, context, token) {
      const { prefix, suffix } = textAround(model, position, INLINE_PREFIX_CHARS, INLINE_SUFFIX_CHARS);
      if (!isInlineCompletionWanted(model, prefix, suffix, context)) return NO_COMPLETIONS;
      const key = `${model.uri.toString()}\u0000${prefix.slice(-500)}\u0000${suffix.slice(0, 100)}`;
      let text = cache.get(key);
      if (text === undefined) {
        if (token.isCancellationRequested) return NO_COMPLETIONS;
        const id = nextRequestId('complete');
        const cancelSub = token.onCancellationRequested(() => window.api.aiCancel(id));
        try {
          const result = await window.api.aiComplete({
            id, language: model.getLanguageId(), path: host.relPath(model), prefix, suffix,
          });
          noteOutcome({ ok: !result.error, error: result.error, aborted: result.aborted || result.skipped });
          if (token.isCancellationRequested || result.error) return NO_COMPLETIONS;
          text = result.text || '';
          cache.set(key, text);
        } catch {
          return NO_COMPLETIONS;
        } finally {
          cancelSub.dispose();
        }
      }
      if (!text) return NO_COMPLETIONS;
      const at = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      return { items: [{ insertText: text, range: at }] };
    },
    disposeInlineCompletions() {},
    // Name used by older Monaco builds; harmless on 0.57.
    freeInlineCompletions() {},
  });
}

// --- Cmd/Ctrl+K inline edit ---------------------------------------------------------------

const SPARKLE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<path fill="currentColor" d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/></svg>';

// Where an inline edit lands. `replace`: whole lines start..end are rewritten
// (a selection, or a blank cursor line to generate into). `insertBelow`: new
// lines are generated after the cursor line, which is left untouched.
function editTargetFor(editor, { cursorLineAsSelection = false } = {}) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  const cursorLine = selection.positionLineNumber;
  const lineText = model.getLineContent(cursorLine);
  if (!selection.isEmpty() || cursorLineAsSelection) {
    const { start, end } = selection.isEmpty() ? { start: cursorLine, end: cursorLine } : selectedLines(selection);
    const range = monaco.Range.fromPositions({ lineNumber: start, column: 1 }, lineEndPosition(model, end));
    const original = model.getValueInRange(range, LF());
    const blank = !original.trim();
    return { mode: 'replace', start, end, original, generating: blank,
      baseIndent: blank ? (original || null) : commonIndent(original) };
  }
  if (!lineText.trim()) {
    // Generate into the blank line; an empty line gives no indent hint, so let the model choose.
    return { mode: 'replace', start: cursorLine, end: cursorLine, original: lineText, generating: true,
      baseIndent: lineText.length ? lineText : null };
  }
  return { mode: 'insertBelow', start: cursorLine, end: cursorLine, original: '', generating: true, baseIndent: null };
}

class InlineEditSession {
  constructor(editor, target) {
    this.editor = editor;
    this.model = editor.getModel();
    this.target = target;
    this.state = 'prompt'; // prompt | streaming | review | refining
    this.proposal = null; // current proposed text, once applied
    this.requestId = null;
    this.blockDecorations = editor.createDecorationsCollection();
    this.promptZoneId = null;
    this.originalZoneId = null;
    this.disposables = [];
    this.buildWidget();
    this.mountWidget();
    // Switching files keeps whatever is applied (it is already one undoable edit).
    this.disposables.push(editor.onDidChangeModel(() => this.close()));
    this.disposables.push(editor.onDidLayoutChange(() => this.layoutWidget()));
  }

  // --- widget ---

  buildWidget() {
    const root = document.createElement('div');
    root.className = 'ai-edit-widget';
    root.innerHTML = `
      <div class="ai-edit-row">
        <span class="ai-edit-icon">${SPARKLE_SVG}</span>
        <input class="ai-edit-input" type="text" spellcheck="false">
        <span class="ai-edit-status"></span>
        <button class="ai-edit-btn ai-edit-accept" type="button"></button>
        <button class="ai-edit-btn ai-edit-reject" type="button"></button>
        <button class="ai-edit-close" type="button">&times;</button>
      </div>
      <div class="ai-edit-error"></div>`;
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    this.root = root;
    this.input = root.querySelector('.ai-edit-input');
    this.statusEl = root.querySelector('.ai-edit-status');
    this.errorEl = root.querySelector('.ai-edit-error');
    const accept = root.querySelector('.ai-edit-accept');
    const reject = root.querySelector('.ai-edit-reject');
    const close = root.querySelector('.ai-edit-close');
    accept.textContent = `${t('ai.accept')} ${isMac ? '⌘⏎' : 'Ctrl+Enter'}`;
    reject.textContent = `${t('ai.reject')} Esc`;
    close.title = t('ai.close');
    accept.addEventListener('click', () => this.accept());
    reject.addEventListener('click', () => this.reject());
    close.addEventListener('click', () => this.escape());
    // Keep keystrokes and clicks inside the widget away from the editor's (and
    // the app's) keybinding listeners; native input editing still works.
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.renderState();
  }

  onKeyDown(e) {
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      if (this.state === 'review') this.accept();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit(this.input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.escape();
    }
  }

  renderState() {
    this.root.dataset.state = this.state;
    const placeholder = this.proposal != null ? 'ai.followUpPlaceholder'
      : this.target.generating ? 'ai.generatePlaceholder' : 'ai.editPlaceholder';
    this.input.placeholder = t(placeholder);
    const working = this.state === 'streaming' || this.state === 'refining';
    // readOnly, not disabled: a disabled input drops focus and Esc could no longer cancel.
    this.input.readOnly = working;
    if (!working) this.statusEl.textContent = '';
  }

  showError(message) {
    this.errorEl.textContent = message || '';
    this.root.classList.toggle('has-error', !!message);
    this.updatePromptZoneHeight();
  }

  // The widget lives in an overlay widget pinned to a view zone, so it pushes
  // the code down instead of covering it (the same trick VS Code's inline chat uses).
  mountWidget() {
    this.overlayTop = -10000; // off-screen until the zone reports its first top
    this.overlay = {
      getId: () => 'claude.ai.inlineEditWidget',
      getDomNode: () => this.root,
      getPosition: () => ({ preference: { top: this.overlayTop, left: this.editor.getLayoutInfo().contentLeft } }),
    };
    this.editor.addOverlayWidget(this.overlay);
    this.layoutWidget();
    const zoneNode = document.createElement('div');
    const afterLine = this.target.mode === 'insertBelow' ? this.target.start : this.target.start - 1;
    this.editor.changeViewZones((accessor) => {
      this.promptZone = {
        afterLineNumber: afterLine,
        heightInPx: this.widgetHeight(),
        ordinal: 1,
        domNode: zoneNode,
        onDomNodeTop: (top) => {
          this.overlayTop = top + 4;
          this.editor.layoutOverlayWidget(this.overlay);
        },
      };
      this.promptZoneId = accessor.addZone(this.promptZone);
    });
    this.editor.revealLineInCenterIfOutsideViewport(Math.max(1, afterLine));
    requestAnimationFrame(() => this.input.focus());
  }

  widgetHeight() {
    return (this.root.offsetHeight || 36) + 8;
  }

  layoutWidget() {
    const { contentWidth } = this.editor.getLayoutInfo();
    this.root.style.width = `${Math.max(240, Math.min(620, contentWidth - 32))}px`;
    this.editor.layoutOverlayWidget(this.overlay);
  }

  updatePromptZoneHeight() {
    if (this.promptZoneId == null) return;
    this.editor.changeViewZones((accessor) => {
      this.promptZone.heightInPx = this.widgetHeight();
      accessor.layoutZone(this.promptZoneId);
    });
  }

  // --- request ---

  async submit(rawInstruction) {
    const instruction = String(rawInstruction || '').trim();
    if (!instruction || this.state === 'streaming' || this.state === 'refining') return;
    this.showError('');
    const refining = this.proposal != null;
    this.state = refining ? 'refining' : 'streaming';
    this.renderState();
    this.statusEl.textContent = t('ai.generating');
    const id = this.requestId = nextRequestId('edit');
    let streamedChars = 0;
    let streamedLines = 0;
    const unsubscribe = window.api.onAiEditChunk((msg) => {
      if (msg.id !== id) return;
      streamedChars += msg.text.length;
      streamedLines += (msg.text.match(/\n/g) || []).length;
      this.statusEl.textContent = fill(t('ai.generatingLines'), { lines: streamedLines + (streamedChars ? 1 : 0) });
    });
    busyEdits++;
    emitStatus();
    let result;
    try {
      result = await window.api.aiEdit({ id, ...this.requestContext(), instruction,
        previous: refining ? this.currentProposalText() : undefined });
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    } finally {
      unsubscribe();
      busyEdits--;
      emitStatus();
    }
    if (this.requestId !== id || this !== activeSession) return; // cancelled or closed meanwhile
    this.requestId = null;
    noteOutcome(result);
    this.state = refining ? 'review' : 'prompt';
    if (!result.ok) {
      this.renderState();
      if (!result.aborted) this.showError(fill(t('ai.failed'), { error: result.error || '' }));
      return;
    }
    if (!result.text && this.target.mode === 'insertBelow') {
      this.renderState();
      this.showError(t('ai.noCode'));
      return;
    }
    this.applyProposal(result.text);
    this.input.value = '';
    this.state = 'review';
    this.renderState();
    inlineReviewKey?.set(true);
    this.input.focus();
  }

  // The text around the edited region. Once a proposal is in the file the region
  // is the proposal's block (so a follow-up sees the code around it, not inside
  // it); before that it is the target lines, or the gap below the cursor line.
  requestContext() {
    const { model, target } = this;
    const selection = target.generating ? '' : target.original;
    const block = this.proposal != null ? this.currentBlockRange() : null;
    let prefixEnd;
    let suffixStart;
    let prefixTail = '';
    if (block) {
      prefixEnd = block.getStartPosition();
      suffixStart = block.getEndPosition();
    } else if (target.mode === 'insertBelow') {
      prefixEnd = suffixStart = lineEndPosition(model, target.start);
      prefixTail = '\n';
    } else {
      prefixEnd = { lineNumber: target.start, column: 1 };
      suffixStart = lineEndPosition(model, target.end);
    }
    const { prefix } = textAround(model, prefixEnd, EDIT_PREFIX_CHARS, 0);
    const { suffix } = textAround(model, suffixStart, 0, EDIT_SUFFIX_CHARS);
    return {
      language: model.getLanguageId(),
      path: host.relPath(model),
      selection,
      prefix: prefix + prefixTail,
      suffix,
      baseIndent: target.baseIndent,
    };
  }

  // The proposal's current lines (the user may have touched them since).
  currentBlockRange() {
    const range = this.blockDecorations.getRange(0);
    if (!range) return null;
    return monaco.Range.fromPositions({ lineNumber: range.startLineNumber, column: 1 },
      lineEndPosition(this.model, range.endLineNumber));
  }

  currentProposalText() {
    const range = this.currentBlockRange();
    return range ? this.model.getValueInRange(range, LF()) : this.proposal;
  }

  // Apply text as one undoable edit, then mark it up as an inline diff.
  applyProposal(text) {
    const { model, target } = this;
    let range;
    let insertText = text;
    let blockStart;
    const existing = this.proposal != null ? this.currentBlockRange() : null;
    if (existing) {
      range = existing;
      blockStart = existing.startLineNumber;
    } else if (target.mode === 'insertBelow') {
      const end = lineEndPosition(model, target.start);
      range = monaco.Range.fromPositions(end, end);
      insertText = `\n${text}`;
      blockStart = target.start + 1;
    } else {
      range = monaco.Range.fromPositions({ lineNumber: target.start, column: 1 }, lineEndPosition(model, target.end));
      blockStart = target.start;
    }
    this.editor.pushUndoStop();
    this.editor.executeEdits('claude-ai-edit', [{ range, text: insertText, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
    this.proposal = text;
    const blockEnd = blockStart + text.split('\n').length - 1;
    this.blockDecorations.set([{
      range: new monaco.Range(blockStart, 1, blockEnd, model.getLineMaxColumn(blockEnd)),
      options: {
        isWholeLine: true,
        className: 'ai-diff-inserted-line',
        linesDecorationsClassName: 'ai-diff-inserted-gutter',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }]);
    this.showOriginalZone(blockStart);
    this.editor.revealLinesInCenterIfOutsideViewport(blockStart, blockEnd);
  }

  // The replaced text, struck through in red above the proposal.
  showOriginalZone(blockStart) {
    if (this.originalZoneId != null || !this.target.original.trim()) return;
    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
    const lines = this.target.original.split('\n');
    const domNode = document.createElement('div');
    domNode.className = 'ai-diff-removed';
    Object.assign(domNode.style, {
      fontFamily: fontInfo.fontFamily,
      fontSize: `${fontInfo.fontSize}px`,
      lineHeight: `${fontInfo.lineHeight}px`,
      tabSize: String(this.model.getOptions().tabSize),
    });
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'ai-diff-removed-line';
      row.textContent = line || ' ';
      domNode.appendChild(row);
    }
    const marginDomNode = document.createElement('div');
    marginDomNode.className = 'ai-diff-removed-margin';
    this.editor.changeViewZones((accessor) => {
      this.originalZoneId = accessor.addZone({
        afterLineNumber: blockStart - 1,
        heightInLines: lines.length,
        ordinal: 2,
        domNode,
        marginDomNode,
      });
    });
  }

  // --- outcomes ---

  cancelRequest() {
    if (!this.requestId) return;
    window.api.aiCancel(this.requestId);
    this.requestId = null;
    this.state = this.proposal != null ? 'review' : 'prompt';
    this.renderState();
  }

  escape() {
    if (this.state === 'streaming' || this.state === 'refining') this.cancelRequest();
    else if (this.state === 'review') this.reject();
    else this.close();
  }

  accept() {
    if (this.state !== 'review') return;
    this.close();
  }

  // Put the original text back exactly, as one undoable edit.
  reject() {
    if (this.proposal != null) {
      const block = this.currentBlockRange();
      if (block) {
        let range = block;
        let text = this.target.original;
        if (this.target.mode === 'insertBelow') {
          const lineAbove = block.startLineNumber - 1;
          range = monaco.Range.fromPositions(lineEndPosition(this.model, lineAbove), block.getEndPosition());
          text = '';
        }
        this.editor.pushUndoStop();
        this.editor.executeEdits('claude-ai-edit', [{ range, text, forceMoveMarkers: true }]);
        this.editor.pushUndoStop();
      }
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.requestId) window.api.aiCancel(this.requestId);
    this.blockDecorations.clear();
    this.editor.changeViewZones((accessor) => {
      if (this.promptZoneId != null) accessor.removeZone(this.promptZoneId);
      if (this.originalZoneId != null) accessor.removeZone(this.originalZoneId);
    });
    this.editor.removeOverlayWidget(this.overlay);
    for (const d of this.disposables) d.dispose();
    if (activeSession === this) activeSession = null;
    inlineEditKey?.set(false);
    inlineReviewKey?.set(false);
    this.editor.focus();
  }
}

// Open the Cmd/Ctrl+K widget; with `instruction` + `autoSubmit` it runs a preset.
function openInlineEdit(editor, { instruction = '', autoSubmit = false, cursorLineAsSelection = false } = {}) {
  if (!editor.getModel() || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  activeSession?.close();
  const session = new InlineEditSession(editor, editTargetFor(editor, { cursorLineAsSelection }));
  activeSession = session;
  inlineEditKey?.set(true);
  if (instruction) session.input.value = instruction;
  if (autoSubmit && instruction) session.submit(instruction);
}

// --- Claude session hand-offs --------------------------------------------------------

function addSelectionToSession(editor) {
  if (!editor.getModel()) return;
  host.sendToSession(mentionFor(editor));
}

function explainWithClaude(editor) {
  if (!editor.getModel()) return;
  host.askInNewSession(fill(t('ai.explainPrompt'), { mention: mentionFor(editor).trim() }));
}

// --- Diagnostics quick fixes ---------------------------------------------------------

function rangesIntersect(marker, range) {
  return !(marker.endLineNumber < range.startLineNumber || marker.startLineNumber > range.endLineNumber);
}

function registerFixCodeActions() {
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      const inContext = (context.markers || []).filter((m) => m.severity >= monaco.MarkerSeverity.Warning);
      const markers = inContext.length ? inContext
        : monaco.editor.getModelMarkers({ resource: model.uri })
          .filter((m) => m.severity >= monaco.MarkerSeverity.Warning && rangesIntersect(m, range));
      if (!markers.length) return { actions: [], dispose() {} };
      const marker = markers.reduce((worst, m) => (m.severity > worst.severity ? m : worst), markers[0]);
      const args = [model.uri.toString(), {
        message: marker.message,
        startLineNumber: marker.startLineNumber,
        endLineNumber: marker.endLineNumber,
      }];
      return {
        actions: [
          { title: t('ai.fixWithAi'), kind: 'quickfix', diagnostics: [marker],
            command: { id: FIX_COMMAND_ID, title: t('ai.fixWithAi'), arguments: args } },
          { title: t('ai.askSessionToFix'), kind: 'quickfix', diagnostics: [marker],
            command: { id: ASK_FIX_COMMAND_ID, title: t('ai.askSessionToFix'), arguments: args } },
        ],
        dispose() {},
      };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // Select the diagnostic's lines in the editor showing that file, so the edit
  // target / @mention cover exactly them. Returns that editor, or null.
  const editorShowingMarker = (uri, marker) => {
    const editor = attachedEditor;
    if (!editor || editor.getModel()?.uri.toString() !== uri) return null;
    const model = editor.getModel();
    const end = Math.min(marker.endLineNumber, model.getLineCount());
    editor.setSelection(new monaco.Range(marker.startLineNumber, 1, end, model.getLineMaxColumn(end)));
    return editor;
  };
  monaco.editor.registerCommand(FIX_COMMAND_ID, (_accessor, uri, marker) => {
    const editor = editorShowingMarker(uri, marker);
    if (editor) openInlineEdit(editor, { instruction: `Fix: ${marker.message}`, autoSubmit: true });
  });
  monaco.editor.registerCommand(ASK_FIX_COMMAND_ID, (_accessor, uri, marker) => {
    const editor = editorShowingMarker(uri, marker);
    if (editor) host.sendToSession(fill(t('ai.askFixPrompt'), { mention: mentionFor(editor).trim(), message: marker.message }));
  });
}

// --- Public API ----------------------------------------------------------------------

export function initAi(monacoNamespace, hostApi) {
  monaco = monacoNamespace;
  host = hostApi;
  registerInlineCompletions();
  registerFixCodeActions();
  refreshAvailability();
}

export function attachAiToEditor(editor) {
  attachedEditor = editor;
  inlineEditKey = editor.createContextKey(INLINE_EDIT_CONTEXT_KEY, false);
  inlineReviewKey = editor.createContextKey(INLINE_REVIEW_CONTEXT_KEY, false);
  editor.updateOptions({ inlineSuggest: { enabled: true } });
  const { KeyMod, KeyCode } = monaco;
  const notWhileOtherWidgets = '!suggestWidgetVisible && !findWidgetVisible && !inlineSuggestionVisible';

  editor.addAction({
    id: 'claude.ai.addSelectionToSession',
    label: t('ai.addToSession'),
    // Overrides Monaco's Cmd/Ctrl+L "expand line selection", like Cursor.
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyL],
    contextMenuGroupId: CONTEXT_MENU_GROUP,
    contextMenuOrder: 1,
    run: (ed) => addSelectionToSession(ed),
  });
  editor.addAction({
    id: 'claude.ai.explain',
    label: t('ai.explain'),
    contextMenuGroupId: CONTEXT_MENU_GROUP,
    contextMenuOrder: 2,
    run: (ed) => explainWithClaude(ed),
  });
  editor.addAction({
    id: 'claude.ai.inlineEdit',
    label: t('ai.editWithAi'),
    // Takes Cmd/Ctrl+K from Monaco's Cmd+K chords (Cmd+K Cmd+C etc.), like Cursor.
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
    precondition: '!editorReadonly',
    contextMenuGroupId: CONTEXT_MENU_GROUP,
    contextMenuOrder: 3,
    run: (ed) => openInlineEdit(ed),
  });
  editor.addAction({
    id: 'claude.ai.docComment',
    label: t('ai.docComment'),
    precondition: '!editorReadonly',
    contextMenuGroupId: CONTEXT_MENU_GROUP,
    contextMenuOrder: 4,
    run: (ed) => openInlineEdit(ed, { instruction: t('ai.docInstruction'), autoSubmit: true, cursorLineAsSelection: true }),
  });
  editor.addAction({
    id: 'claude.ai.inlineEdit.accept',
    label: t('ai.accept'),
    keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
    keybindingContext: INLINE_REVIEW_CONTEXT_KEY,
    run: () => activeSession?.accept(),
  });
  editor.addAction({
    id: 'claude.ai.inlineEdit.escape',
    label: t('ai.reject'),
    keybindings: [KeyCode.Escape],
    keybindingContext: `${INLINE_EDIT_CONTEXT_KEY} && ${notWhileOtherWidgets}`,
    run: () => activeSession?.escape(),
  });
}
