// The message box: what you type, what you attach, and the command menu that opens
// when a message starts with "/".
//
// It owns the draft (text + attachments) and hands it over on send — the screen owns
// the wire. The slash menu appears only while the *first* word is being typed as a
// command, which is the only place Claude accepts one; after that the text is just
// text, and a "/" mid-sentence must not pop a menu at the reader.
import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { SlashCommand } from '../../api/chat';
import { showError } from '../ErrorDialog';
import { color, font, radius, space } from '../../theme';

export type Draft = { uri: string; base64: string; name: string };

const COMMAND_PREFIX = /^\/(\S*)$/;

// A photo goes over the socket as base64 and is written to a file on the desktop, so
// it is downscaled and recompressed on the way in. 1568px is the largest edge Claude
// gets any benefit from; a raw 12MP shot is ~8x the bytes for no extra detail.
const PICK = {
  mediaTypes: ImagePicker.MediaTypeOptions.Images,
  base64: true as const,
  quality: 0.7,
  allowsMultipleSelection: false as const,
};

export default function Composer({
  commands, busy, disabled, placeholder, onSend,
}: {
  commands: SlashCommand[];
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string, images: Draft[]) => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Draft[]>([]);
  const input = useRef<TextInput>(null);

  const matches = useMemo(() => {
    const m = COMMAND_PREFIX.exec(text);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 8);
  }, [text, commands]);

  const add = async (fromCamera: boolean) => {
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return Alert.alert('Permission needed', 'Allow access to attach a photo.');
      const r = fromCamera
        ? await ImagePicker.launchCameraAsync(PICK)
        : await ImagePicker.launchImageLibraryAsync(PICK);
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset?.base64) return;
      const name = asset.fileName || `photo-${asset.assetId || 'attachment'}.jpg`;
      setImages((prev) => [...prev, { uri: asset.uri, base64: asset.base64!, name }]);
    } catch (e: any) {
      showError('Could not attach', e);
    }
  };

  const attach = () => {
    Keyboard.dismiss();
    Alert.alert('Attach an image', undefined, [
      { text: 'Take photo', onPress: () => add(true) },
      { text: 'Choose from library', onPress: () => add(false) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const empty = !text.trim() && !images.length;
  const send = () => {
    if (empty || busy || disabled) return;
    onSend(text.trim(), images);
    setText('');
    setImages([]);
  };

  return (
    <View style={styles.wrap}>
      {matches.length > 0 && (
        <View style={styles.menu}>
          <FlatList
            data={matches}
            keyboardShouldPersistTaps="always"
            keyExtractor={(c) => c.name}
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.cmd, pressed && styles.cmdPressed]}
                onPress={() => { setText(item.name + ' '); input.current?.focus(); }}
              >
                <Text style={styles.cmdName}>{item.name}</Text>
                <Text style={styles.cmdDesc} numberOfLines={1}>{item.description}</Text>
                {item.source !== 'builtin' && <Text style={styles.cmdSource}>{item.source}</Text>}
              </Pressable>
            )}
          />
        </View>
      )}

      {images.length > 0 && (
        <View style={styles.strip}>
          {images.map((img, i) => (
            <View key={img.uri + i} style={styles.thumbWrap}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <Pressable
                style={styles.remove}
                hitSlop={8}
                onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Ionicons name="close" size={12} color={color.text} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={styles.bar}>
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
          onPress={attach}
          disabled={disabled}
          hitSlop={6}
        >
          <Ionicons name="add" size={22} color={disabled ? color.faint : color.muted} />
        </Pressable>
        <TextInput
          ref={input}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder || 'Message Claude…'}
          placeholderTextColor={color.faint}
          multiline
          editable={!disabled}
          onSubmitEditing={send}
          blurOnSubmit={false}
        />
        <Pressable
          style={({ pressed }) => [styles.send, empty && styles.sendOff, pressed && !empty && styles.sendPressed]}
          onPress={send}
          disabled={empty || busy || disabled}
        >
          {busy
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="arrow-up" size={18} color={empty ? color.faint : '#fff'} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border,
  },
  bar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: space.sm,
    paddingHorizontal: space.sm, paddingVertical: space.sm,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raised,
  },
  iconBtnPressed: { backgroundColor: color.raisedHi },
  // 19 is half of 38: the field is a true pill at one line and stays rounded as it
  // grows, rather than snapping to a rectangle with rounded ends.
  input: {
    flex: 1,
    color: color.text, fontSize: font.size.md, lineHeight: 20,
    // Android adds ascender/descender padding on top of the explicit padding, which
    // pushes a one-line field past the 38px buttons. Drop it so 9 + 20 + 9 holds.
    includeFontPadding: false,
    textAlignVertical: 'center',
    backgroundColor: color.raised,
    borderRadius: 19,
    paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9,
    maxHeight: 140,
    minHeight: 38,
  },
  send: {
    width: 38, height: 38, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.accentDim,
  },
  sendPressed: { backgroundColor: color.accent },
  sendOff: { backgroundColor: color.raised },

  menu: {
    maxHeight: 232,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border,
  },
  cmd: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: 10,
  },
  cmdPressed: { backgroundColor: color.raised },
  cmdName: { color: color.accent, fontSize: font.size.sm, fontWeight: '700', fontFamily: font.mono },
  cmdDesc: { flex: 1, color: color.muted, fontSize: font.size.sm },
  cmdSource: {
    color: color.faint, fontSize: font.size.xs,
    borderWidth: 1, borderColor: color.border, borderRadius: radius.sm,
    paddingHorizontal: 5, paddingVertical: 1,
  },

  strip: {
    flexDirection: 'row', flexWrap: 'wrap', gap: space.sm,
    paddingHorizontal: space.md, paddingTop: space.md,
  },
  thumbWrap: { width: 56, height: 56 },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: color.raised },
  remove: {
    position: 'absolute', top: -6, right: -6,
    width: 20, height: 20, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raisedHi,
    borderWidth: 1, borderColor: color.surface,
  },
});
