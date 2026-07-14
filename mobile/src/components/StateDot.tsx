// The session status dot, in step with the desktop's `.dot` rules in
// src/styles/sessions.css. The desktop treats the dot as a small state machine of
// its own, and the phone has to tell the same story: a spinning yellow ring while
// Claude works, a glowing green dot when it wants you, and a pop + ring when a run
// lands. Anything less and the two halves of the product disagree about what the
// session is doing.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { color, stateColor } from '../theme';

// Desktop: `.dot` is 9px, `.dot.working` grows to 11px to fit the ring's border.
const BASE = 9;
const WORKING = 11;
const SPIN_MS = 700;   // sess-dot-spin
const POP_MS = 500;    // sess-finish-pop
const RING_MS = 600;   // sess-finish-ring

export default function StateDot({ state, size = BASE }: { state: string; size?: number }) {
  const scale = size / BASE;
  const spin = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  // Parked at 1, i.e. the *end* of the ring animation (faded out, fully expanded), so
  // a dot that has never celebrated shows no ring at all.
  const ring = useRef(new Animated.Value(1)).current;
  const prev = useRef(state);

  const working = state === 'working';

  useEffect(() => {
    if (!working) return;
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [working, spin]);

  // The celebration fires on the same transition the desktop celebrates
  // (`isCompletionTransition`): working -> completed, and nothing else.
  useEffect(() => {
    const finished = prev.current === 'working' && state === 'completed';
    prev.current = state;
    if (!finished) return;
    pop.setValue(0);
    ring.setValue(0);
    Animated.parallel([
      Animated.timing(pop, {
        toValue: 1,
        duration: POP_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(ring, {
        toValue: 1,
        duration: RING_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [state, pop, ring]);

  const popScale = pop.interpolate({
    inputRange: [0, 0.35, 1],   // scale 1 -> 1.7 -> 1, as in sess-finish-pop
    outputRange: [1, 1.7, 1],
  });

  const box = { width: WORKING * scale, height: WORKING * scale };

  return (
    <Animated.View style={[styles.box, box, { transform: [{ scale: popScale }] }]}>
      {working ? (
        <Animated.View
          style={[
            styles.ringSpinner,
            {
              width: WORKING * scale,
              height: WORKING * scale,
              borderRadius: (WORKING * scale) / 2,
              borderWidth: 2 * scale,
              transform: [
                { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
              ],
            },
          ]}
        />
      ) : (
        <View
          style={[
            styles.dot,
            {
              width: BASE * scale,
              height: BASE * scale,
              borderRadius: (BASE * scale) / 2,
              backgroundColor: stateColor[state] || color.faint,
            },
            // Desktop gives only `needs-input` a glow, so it reads as the one state
            // that is *asking* for something rather than just reporting.
            state === 'needs-input' && styles.glow,
          ]}
        />
      )}

      <Animated.View
        pointerEvents="none"
        style={[
          styles.finishRing,
          {
            width: BASE * scale,
            height: BASE * scale,
            borderRadius: (BASE * scale) / 2,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2.6] }) }],
          },
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  dot: {},
  // The desktop's ring spinner: a dim yellow circle with one bright quadrant.
  ringSpinner: {
    borderColor: 'rgba(210, 153, 34, 0.28)',   // --yellow at 28%
    borderTopColor: color.yellow,
  },
  glow: {
    shadowColor: color.green,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  finishRing: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: color.green,
  },
});
