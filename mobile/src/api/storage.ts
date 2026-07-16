// Dev runs and installed builds must never share persisted state — the mobile
// mirror of the desktop's `-dev` userData split (src/main/instance.js). A debug
// native build shares the release app's sandbox (same applicationId), and Expo Go
// keeps one SecureStore for every project it runs, so a fixed key name would let
// a dev session clobber the built app's pairing. Namespacing the keys keeps the
// two worlds side by side.
export const storageKey = (name: string): string => (__DEV__ ? `ide.dev.${name}` : `ide.${name}`);
