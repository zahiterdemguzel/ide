// Claude answers in markdown, so a chat that rendered it raw would show ** and ``` at
// the reader. This is a deliberately small subset — headings, lists, quotes, rules,
// fenced code, and inline bold/italic/code/links — which is everything an assistant
// reply actually uses. Anything it doesn't know is shown as the text it is, never
// swallowed.
//
// It is hand-written rather than pulled from a library because the phone renders code
// blocks with the desktop's own look and nothing off the shelf reads the same.
import React, { useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { color, font, radius, space } from '../../theme';

type Block =
  | { t: 'p' | 'h1' | 'h2' | 'h3' | 'quote'; text: string }
  | { t: 'li'; text: string; marker: string }
  | { t: 'code'; text: string; lang: string }
  | { t: 'hr' };

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

function parse(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      // An unclosed fence runs to the end — Claude's output is streamed into the
      // transcript a message at a time, so the last one can genuinely be open.
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n'), lang: fence[1] || '' });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (RULE.test(line.trim())) { flush(); out.push({ t: 'hr' }); continue; }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = Math.min(3, h[1].length);
      out.push({ t: `h${level}` as 'h1' | 'h2' | 'h3', text: h[2] });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) { flush(); out.push({ t: 'quote', text: q[1] }); continue; }
    const b = BULLET.exec(line);
    if (b) { flush(); out.push({ t: 'li', text: b[1], marker: '•' }); continue; }
    const n = NUMBERED.exec(line);
    if (n) { flush(); out.push({ t: 'li', text: n[2], marker: `${n[1]}.` }); continue; }
    para.push(line);
  }
  flush();
  return out;
}

// Inline spans. The regex alternation is ordered so `**bold**` is matched before
// `*italic*` would take its first two stars.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g;

function Inline({ text, style }: { text: string; style?: any }) {
  const parts = text.split(INLINE).filter((p) => p !== '' && p !== undefined);
  // A code span swaps the font family mid-sentence, and a run measured with taller
  // metrics than the line box around it makes Android draw the paragraph's lines on top
  // of each other. So it inherits the line box of whatever it sits in — which is the
  // body's in a paragraph and a bigger one in a heading, and neither is a constant.
  const inherited = StyleSheet.flatten(style)?.lineHeight;
  const span = inherited ? { lineHeight: inherited } : null;
  return (
    <Text style={style}>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`')) {
          return <Text key={i} style={[styles.codeSpan, span]}>{p.slice(1, -1)}</Text>;
        }
        if (p.startsWith('**') && p.endsWith('**')) {
          return <Text key={i} style={styles.bold}>{p.slice(2, -2)}</Text>;
        }
        if ((p.startsWith('*') && p.endsWith('*')) || (p.startsWith('_') && p.endsWith('_'))) {
          return <Text key={i} style={styles.italic}>{p.slice(1, -1)}</Text>;
        }
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (link) {
          return (
            <Text key={i} style={styles.link} onPress={() => Linking.openURL(link[2]).catch(() => {})}>
              {link[1]}
            </Text>
          );
        }
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

// A code block scrolls sideways inside its own box: wrapping code is worse than
// scrolling it, and the message column must never be what scrolls.
function CodeBlock({ text, lang }: { text: string; lang: string }) {
  return (
    <View style={styles.code}>
      {!!lang && <Text style={styles.lang}>{lang}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>{text}</Text>
      </ScrollView>
    </View>
  );
}

export default function Markdown({ text, style }: { text: string; style?: any }) {
  const blocks = useMemo(() => parse(text), [text]);
  return (
    <View>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            return <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case 'hr':
            return <View key={i} style={styles.hr} />;
          case 'h1': case 'h2': case 'h3':
            return <Inline key={i} text={b.text} style={[styles.body, styles[b.t], style]} />;
          case 'quote':
            return (
              <View key={i} style={styles.quote}>
                <Inline text={b.text} style={[styles.body, styles.quoteText, style]} />
              </View>
            );
          case 'li':
            return (
              <View key={i} style={styles.li}>
                <Text style={styles.marker}>{b.marker}</Text>
                <Inline text={b.text} style={[styles.body, styles.liText, style]} />
              </View>
            );
          default:
            return <Inline key={i} text={b.text} style={[styles.body, style]} />;
        }
      })}
    </View>
  );
}

// A line box has to be tall enough for the font that sits in it. RN draws lines exactly
// `lineHeight` apart with no minimum, so a style that raises `fontSize` and inherits
// someone else's `lineHeight` doesn't get a cramped line — it gets one line drawn on top
// of the next. Every style below therefore carries the line height for its *own* size,
// and a heading must never lean on `body`'s.
const LINE = 22;      // the body's, at font.size.md
const line = (size: number) => Math.round(size * 1.45);

const styles = StyleSheet.create({
  body: { color: color.text, fontSize: font.size.md, lineHeight: LINE, marginBottom: space.sm },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { color: color.accent, textDecorationLine: 'underline' },
  codeSpan: {
    fontFamily: font.mono, fontSize: font.size.sm,
    color: color.redSoft, backgroundColor: color.raised,
    lineHeight: LINE, // the body's; `Inline` overrides it with the line box it lands in
  },
  h1: { fontSize: 21, lineHeight: line(21), fontWeight: '700', marginTop: space.sm },
  h2: { fontSize: 18, lineHeight: line(18), fontWeight: '700', marginTop: space.sm },
  h3: { fontSize: font.size.md, lineHeight: LINE, fontWeight: '700', marginTop: space.xs },
  li: { flexDirection: 'row', gap: space.sm, paddingLeft: space.xs },
  marker: { color: color.muted, fontSize: font.size.md, lineHeight: LINE, minWidth: 16 },
  liText: { flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: color.border, paddingLeft: space.md },
  quoteText: { color: color.muted },
  hr: { height: 1, backgroundColor: color.border, marginVertical: space.md },
  code: {
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border,
    borderRadius: radius.sm, padding: space.md, marginBottom: space.sm,
  },
  lang: { color: color.faint, fontSize: font.size.xs, marginBottom: space.xs, textTransform: 'uppercase' },
  codeText: { fontFamily: font.mono, fontSize: font.size.sm, color: color.text, lineHeight: 19 },
});
