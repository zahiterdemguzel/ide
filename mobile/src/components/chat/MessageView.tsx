// One message in the chat.
//
// The two roles are drawn as different things on purpose, the way every chat app
// does it: what you said is a bubble on the right, what Claude said is prose on the
// page. Tool calls are neither — they're what the assistant *did*, so they read as
// compact activity rows you can open, not as speech.
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from './Markdown';
import { Block, Message, messageText, splitAttachments } from '../../api/chat';
import { color, font, radius, space } from '../../theme';

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

function ToolCard({ block }: { block: Extract<Block, { t: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!block.output;
  return (
    <View style={[styles.tool, block.status === 'error' && styles.toolError]}>
      <Pressable
        style={({ pressed }) => [styles.toolHead, pressed && hasOutput && styles.pressed]}
        onPress={() => hasOutput && setOpen((o) => !o)}
        disabled={!hasOutput}
      >
        <Ionicons
          name={TOOL_ICON[block.name] || 'construct-outline'}
          size={14}
          color={block.status === 'error' ? color.red : color.muted}
        />
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={styles.toolTitle} numberOfLines={1}>{block.title}</Text>
        {block.status === 'running'
          ? <ActivityIndicator size="small" color={color.muted} />
          : hasOutput
            ? <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={color.faint} />
            : null}
      </Pressable>
      {open && (
        <ScrollView style={styles.toolOut} nestedScrollEnabled>
          <Text style={styles.toolOutText} selectable>{block.output}</Text>
        </ScrollView>
      )}
    </View>
  );
}

// Thinking is collapsed by default: it's context, not the answer, and unfolding it is
// the reader's choice — the same call the desktop TUI makes.
function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.thinking}>
      <Pressable style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
        <Ionicons name="bulb-outline" size={14} color={color.purple} />
        <Text style={styles.thinkingLabel}>Thought for a moment</Text>
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
    case 'image': return <Text style={styles.imageNote}>🖼 image</Text>;
    default: return null;
  }
}

// What the user said. Attached images arrive as a path on its own line (that is how
// Claude is handed a photo — see chat.js), so they're shown as an attachment chip
// rather than as a wall of C:\Users\… noise.
//
// A message that hasn't reached the desktop yet is drawn the same, just dimmed: it is
// on screen the instant you tap send, and the only thing still missing is the receipt.
function UserMessage({ message, pending }: { message: Message; pending?: boolean }) {
  const { said, files } = splitAttachments(messageText(message));
  const images = files + message.blocks.filter((b) => b.t === 'image').length;
  return (
    <View style={styles.userRow}>
      <View style={[styles.bubble, pending && styles.bubblePending]}>
        {images > 0 && (
          <View style={styles.chip}>
            <Ionicons name="image-outline" size={13} color={color.accent} />
            <Text style={styles.chipText}>{images === 1 ? 'Image' : `${images} images`}</Text>
          </View>
        )}
        {!!said && <Text style={styles.userText} selectable>{said}</Text>}
      </View>
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
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.15)', borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  chipText: { color: '#fff', fontSize: font.size.xs, fontWeight: '600' },

  tool: {
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: color.borderSoft,
    borderRadius: 12,
    marginVertical: 3,
    overflow: 'hidden',
  },
  toolError: { borderColor: '#f8514955' },
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
  imageNote: { color: color.muted, fontSize: font.size.sm, marginBottom: space.sm },
});
