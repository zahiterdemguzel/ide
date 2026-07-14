// File browser + plain-text editor. Mirrors the desktop explorer's list-dir /
// read-text / write-text channels (repo-relative paths, {ok,...} results).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, TextInput, Button, Alert, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useConnection } from '../api/context';

type Entry = { name: string; dir: boolean };

export default function FilesScreen({ navigation }: any) {
  const { conn } = useConnection();
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);

  const list = useCallback(async (rel: string) => {
    const r: any = await conn?.req('list-dir', rel);
    if (r?.ok) { setCwd(rel); setEntries(r.entries); }
    else Alert.alert('Files', r?.error ?? 'failed');
  }, [conn]);

  useEffect(() => { list(''); }, [list]);

  useEffect(() => {
    navigation.setOptions({
      title: file ? file.split('/').pop() : cwd || 'Files',
      headerRight: () => file
        ? <Button title={dirty ? 'Save' : 'Saved'} disabled={!dirty} onPress={save} />
        : undefined,
    });
  });

  const openEntry = async (e: Entry) => {
    const rel = cwd ? `${cwd}/${e.name}` : e.name;
    if (e.dir) return list(rel);
    const r: any = await conn?.req('read-text', rel);
    if (!r?.ok) return Alert.alert('Files', r?.error ?? 'cannot open');
    setFile(rel);
    setText(r.text);
    setDirty(false);
  };

  const save = async () => {
    const r: any = await conn?.req('write-text', { file, text });
    if (!r?.ok) return Alert.alert('Files', r?.error ?? 'save failed');
    setDirty(false);
  };

  const up = () => {
    if (file) { setFile(null); return; }
    if (!cwd) return;
    list(cwd.split('/').slice(0, -1).join('/'));
  };

  if (file) {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable onPress={up}><Text style={styles.back}>‹ back to files</Text></Pressable>
        <TextInput
          style={styles.editor}
          value={text}
          onChangeText={(v) => { setText(v); setDirty(true); }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.fill}>
      {cwd !== '' && (
        <Pressable onPress={up}><Text style={styles.back}>‹ ..</Text></Pressable>
      )}
      <FlatList
        data={entries}
        keyExtractor={(e) => e.name}
        refreshing={false}
        onRefresh={() => list(cwd)}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => openEntry(item)}>
            <Text style={styles.icon}>{item.dir ? '📁' : '📄'}</Text>
            <Text style={styles.name}>{item.name}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  back: { color: '#61afef', padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  icon: { marginRight: 10 },
  name: { color: '#ddd', flex: 1 },
  editor: { flex: 1, color: '#ddd', fontFamily: 'monospace', fontSize: 13, padding: 12, textAlignVertical: 'top' },
});
