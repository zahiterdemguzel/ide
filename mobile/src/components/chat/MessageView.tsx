// One message in the chat.
//
// The two roles are drawn as different things on purpose, the way every chat app
// does it: what you said is a bubble on the right, what Claude said is prose on the
// page. Tool calls are neither — they're what the assistant *did*, so they read as
// compact activity rows you can open, not as speech.
import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from './Markdown';
import { LinkedText } from './links';
import { Block, Diff, Message, messageText, sentPhotoUri, splitAttachments } from '../../api/chat';
import { DIFF_PAGE_LINES, DIFF_PREVIEW_LINES, capLines, moreLinesLabel } from '../../lib/chat-view';
import { alpha, color, font, radius, space, tint } from '../../theme';

const TOOL_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  Read: 'document-text-outline',
  Write: 'create-outline',
  Edit: 'create-outline',
  MultiEdit: 'create-outline',
  NotebookEdit: 'create-outline',
  Bash: 'terminal-outline',
  BashOutput: 'terminal-outline',
  Glob: 'search-outline',
  Grep: 'search-outline',
  Task: 'sparkles-outline',
  Agent: 'sparkles-outline',
  WebFetch: 'globe-outline',
  WebSearch: 'globe-outline',
  TodoWrite: 'checkbox-outline',
};

// An edit's diff is the card's payload, shown open the way the design's chat mock
// (4a) draws it: each row is `<n>  <sign> <code>` on a red/green wash, the number
// faint and inline rather than a ruled gutter, the sign part of the text.
//
// Only the first DIFF_PREVIEW_LINES rows are drawn; the rest wait behind an expander
// that adds a page per tap. A Write's diff is the whole file, and these rows are
// plain Views inside the chat's own list — a few thousand of them froze the JS thread.
function DiffView({ diff }: { diff: Diff }) {
  const [limit, setLimit] = useState(DIFF_PREVIEW_LINES);
  const { shown, hidden } = capLines(diff.lines, limit);
  return (
    <View style={styles.diff}>
      {shown.map((l, i) => (
        <View key={i} style={[styles.diffRow, l.sign === '+' && styles.diffAdd, l.sign === '-' && styles.diffDel]}>
          <Text
            style={[styles.diffText, l.sign === '+' && styles.diffTextAdd, l.sign === '-' && styles.diffTextDel]}
            numberOfLines={1}
          >
            {l.n > 0 && <Text style={styles.diffNum}>{l.n}{'  '}</Text>}
            {l.sign === ' ' ? ' ' : l.sign} {l.text}
          </Text>
        </View>
      ))}
      {hidden > 0 && (
        <Pressable
          onPress={() => setLimit((n) => n + DIFF_PAGE_LINES)}
          style={({ pressed }) => [styles.diffMore, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Ionicons name="chevron-down" size={13} color={color.accent} />
          <Text style={styles.diffMoreText}>{moreLinesLabel(hidden, diff.lines.length)}</Text>
        </Pressable>
      )}
    </View>
  );
}

// An Edit's diff is the card's payload and is never collapsed. Any other tool's
// body — a Write's diff (the whole file), a Read/Bash output — waits behind the
// chevron, or every card in the chat would be a wall.
const DIFF_OPEN = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

function ToolCard({ block }: { block: Extract<Block, { t: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const diffOpen = !!block.diff && DIFF_OPEN.has(block.name);
  const expandable = !diffOpen && (!!block.diff || !!block.output);
  return (
    <View style={[styles.tool, block.status === 'error' && styles.toolError]}>
      <Pressable
        style={({ pressed }) => [styles.toolHead, pressed && expandable && styles.pressed]}
        onPress={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
      >
        <Ionicons
          name={TOOL_ICON[block.name] || 'construct-outline'}
          size={14}
          color={block.status === 'error' ? color.red : color.muted}
        />
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={styles.toolTitle} numberOfLines={1}>{block.title}</Text>
        {block.diff && (
          <Text style={styles.diffBadge}>+{block.diff.added} −{block.diff.removed}</Text>
        )}
        {block.status === 'running'
          ? <ActivityIndicator size="small" color={color.muted} />
          : expandable
            ? <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={color.faint} />
            : null}
      </Pressable>
      {diffOpen && <DiffView diff={block.diff!} />}
      {open && !diffOpen && block.diff && <DiffView diff={block.diff} />}
      {open && !block.diff && (
        <ScrollView style={styles.toolOut} nestedScrollEnabled>
          <Text style={styles.toolOutText} selectable>{block.output}</Text>
        </ScrollView>
      )}
    </View>
  );
}

// Thinking is collapsed by default: it's context, not the answer, and unfolding it is
// the reader's choice — the same call the desktop TUI makes.
//
// The label is a plain "Thinking" rather than a duration: the transcript stamps each
// entry when it was *written*, not when thinking started, so any number derived from
// it would be a guess dressed up as a measurement.
function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.thinking}>
      <Pressable style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
        <Ionicons name="bulb-outline" size={14} color={color.purple} />
        <Text style={styles.thinkingLabel}>Thinking</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={color.faint} />
      </Pressable>
      {open && <Text style={styles.thinkingText} selectable>{text}</Text>}
    </View>
  );
}

function AssistantBlock({ block }: { block: Block }) {
  switch (block.t) {
    case 'text': return <Markdown text={block.text} />;
    case 'thinking': return <ThinkingCard text={block.text} />;
    case 'tool': return <ToolCard block={block} />;
    case 'image': return <ImageThumb uri={block.uri} />;
    default: return null;
  }
}

// An image in the conversation. The transcript records that an image was there but
// not its bytes, so only a photo this phone sent (still on the phone) can be drawn;
// anything else is a labelled placeholder of the same footprint.
function ImageThumb({ uri, onBubble }: { uri?: string; onBubble?: boolean }) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={styles.thumb}
        accessible
        accessibilityRole="image"
        accessibilityLabel="Attached image"
      />
    );
  }
  return (
    <View
      style={[styles.chip, onBubble ? styles.chipOnBubble : styles.chipOnPage]}
      accessible
      accessibilityLabel="Image"
    >
      <Ionicons name="image-outline" size={13} color={onBubble ? color.text : color.accent} />
      <Text style={[styles.chipText, !onBubble && styles.chipTextOnPage]}>Image</Text>
    </View>
  );
}

// What the user said. Attached images arrive as a path on its own line (that is how
// Claude is handed a photo — see chat.js); a photo this phone sent is shown as its
// thumbnail, any other as an attachment chip — never as a wall of C:\Users\… noise.
//
// A message that hasn't reached the desktop yet is drawn the same, just dimmed: it is
// on screen the instant you tap send, and the only thing still missing is the receipt.
function UserMessage({ message, pending }: { message: Message; pending?: boolean }) {
  const { said, paths } = splitAttachments(messageText(message));
  const imageUris: (string | undefined)[] = [
    ...paths.map(sentPhotoUri),
    ...message.blocks.flatMap((b) => (b.t === 'image' ? [b.uri] : [])),
  ];
  const thumbs = imageUris.filter((u): u is string => !!u);
  const unknown = imageUris.length - thumbs.length;
  return (
    <View style={styles.userRow}>
      {thumbs.length > 0 && (
        <View style={[styles.thumbRow, pending && styles.bubblePending]}>
          {thumbs.map((uri, i) => <ImageThumb key={uri + i} uri={uri} />)}
        </View>
      )}
      {(unknown > 0 || !!said) && (
        <View style={[styles.bubble, pending && styles.bubblePending]}>
          {unknown > 0 && (
            <View style={[styles.chip, styles.chipOnBubble]} accessible accessibilityLabel={unknown === 1 ? 'Image' : `${unknown} images`}>
              <Ionicons name="image-outline" size={13} color={color.text} />
              <Text style={styles.chipText}>{unknown === 1 ? 'Image' : `${unknown} images`}</Text>
            </View>
          )}
          {!!said && <Text style={styles.userText} selectable><LinkedText text={said} linkStyle={styles.userLink} /></Text>}
        </View>
      )}
    </View>
  );
}

function MessageView({ message, pending }: { message: Message; pending?: boolean }) {
  if (message.role === 'user') return <UserMessage message={message} pending={pending} />;
  return (
    <View style={styles.assistant}>
      {message.blocks.map((b, i) => <AssistantBlock key={i} block={b} />)}
    </View>
  );
}

// The list re-renders on every push; a message that didn't change shouldn't.
export default React.memo(MessageView);

const styles = StyleSheet.create({
  assistant: { paddingHorizontal: space.lg, paddingVertical: space.xs },
  userRow: { paddingHorizontal: space.lg, paddingVertical: space.xs, alignItems: 'flex-end' },
  // Your own words are the one thing here you already know — so the bubble is solid
  // blue and squared off at the corner nearest you, and everything Claude says is
  // left plain on the page.
  bubble: {
    maxWidth: '86%',
    backgroundColor: color.accentDim,
    borderRadius: 18, borderBottomRightRadius: 6,
    paddingHorizontal: 13, paddingVertical: 9,
    gap: space.xs,
  },
  bubblePending: { opacity: 0.55 },
  userText: { color: '#fff', fontSize: font.size.md, lineHeight: 21 },
  // The bubble is already accent blue, so a link in it is told apart by its underline.
  userLink: { color: '#fff', textDecorationLine: 'underline' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  // A white wash over the blue bubble, the same tint formula the rest of the system uses.
  chipOnBubble: { backgroundColor: tint.fillStrong('#ffffff') },
  chipOnPage: {
    backgroundColor: tint.fill(color.accent), borderWidth: 1, borderColor: tint.line(color.accent),
    marginBottom: space.sm,
  },
  chipText: { color: '#fff', fontSize: font.size.xs, fontWeight: '600' },
  chipTextOnPage: { color: color.accent },
  // Your own photos sit above the bubble, right-aligned with it, as every chat app
  // draws a sent picture — on the page rather than squeezed inside the blue.
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.xs, marginBottom: space.xs, maxWidth: '86%' },
  thumb: {
    width: 120, height: 120, borderRadius: radius.md,
    backgroundColor: color.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
  },

  tool: {
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: color.borderSoft,
    borderRadius: 12,
    marginVertical: 3,
    overflow: 'hidden',
  },
  toolError: { borderColor: tint.line(color.red) },
  toolHead: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: space.sm,
  },
  pressed: { backgroundColor: color.raised },
  toolName: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  toolTitle: { flex: 1, color: color.muted, fontSize: font.size.sm, fontFamily: font.mono },
  toolOut: {
    maxHeight: 220,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border,
    backgroundColor: color.bg,
    padding: space.md,
  },
  toolOutText: { color: color.muted, fontSize: font.size.xs, fontFamily: font.mono, lineHeight: 17 },

  // The edit card's diff, drawn to the design mock (4a): a green `+6 −2` in the
  // header, then rows on the card's own surface — a 10%-alpha wash under soft
  // red/green code, the line number faint and inline before the sign.
  diffBadge: { color: color.green, fontSize: font.size.xs, fontWeight: '600' },
  diff: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft,
    paddingVertical: space.sm,
  },
  diffRow: { paddingHorizontal: 13 },
  diffAdd: { backgroundColor: alpha(color.green, 0.1) },
  diffDel: { backgroundColor: alpha(color.red, 0.1) },
  diffNum: { color: color.faint },
  diffText: { color: color.muted, fontSize: 11.5, fontFamily: font.mono, lineHeight: 18 },
  diffTextAdd: { color: color.greenSoft },
  diffTextDel: { color: color.redSoft },
  diffMore: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    minHeight: 44, paddingHorizontal: 13,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft,
    marginTop: space.xs,
  },
  diffMoreText: { color: color.accent, fontSize: font.size.xs, fontWeight: '600' },

  thinking: {
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: color.borderSoft,
    borderRadius: 12, marginVertical: 3,
    paddingBottom: 2,
  },
  thinkingLabel: { flex: 1, color: color.purple, fontSize: font.size.sm, fontWeight: '600' },
  thinkingText: {
    color: color.muted, fontSize: font.size.sm, lineHeight: 20,
    paddingHorizontal: space.md, paddingBottom: space.md,
  },
});
