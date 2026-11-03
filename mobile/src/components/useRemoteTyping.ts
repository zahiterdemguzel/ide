// The hidden-input half of remote typing, shared by the Browser and Control tabs.
// The diffing itself is pure and tested (lib/remote-typing.js); this only holds the
// buffer the off-screen TextInput is controlled by and hands each change's edits on.
//
// Only `onChangeText` is wired — never `onKeyPress` too — so a platform that fires
// both can't send a key twice, and an Android keyboard that fires only the former
// still types.
import { useCallback, useRef, useState } from 'react';
import { BUFFER_SEED, settleBuffer, typedEdits, type TypedEdit } from '../lib/remote-typing';

export type { TypedEdit };

export function useRemoteTyping(onEdits: (edits: TypedEdit[]) => void) {
  const [value, setValue] = useState(BUFFER_SEED);
  // What the native field holds right now — onChangeText can fire several times
  // before a render lands (a held Backspace), so the diff base can't be state.
  const current = useRef(BUFFER_SEED);
  const handler = useRef(onEdits);
  handler.current = onEdits;

  const onChangeText = useCallback((text: string) => {
    const edits = typedEdits(current.current, text);
    const settled = settleBuffer(text);
    current.current = settled;
    // A settled value equal to the last render's still reaches the native field:
    // TextInput re-applies its `value` whenever the native text drifts from it.
    setValue(settled);
    if (edits.length) handler.current(edits);
  }, []);

  // A fresh buffer per typing session, so leftovers can't be diffed against.
  const reset = useCallback(() => {
    current.current = BUFFER_SEED;
    setValue(BUFFER_SEED);
  }, []);

  return { value, onChangeText, reset };
}
