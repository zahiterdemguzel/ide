import { createContext, useContext } from 'react';
import { Connection, ConnectionState } from './connection';
import type { PairInfo } from './pairing';
import type { Instance } from './instances';

export type Ctx = {
  conn: Connection | null;
  state: ConnectionState;
  pair: (info: PairInfo) => void;
  unpair: () => Promise<void>;
  // The windows to choose between, or null when there is nothing to choose: still
  // connecting, or the machine is running a single window and we went straight in.
  instances: Instance[] | null;
  // The window being driven. Null against a desktop too old to name its windows.
  instance: Instance | null;
  selectInstance: (inst: Instance) => void;
  // Go back to the chooser (re-lists, so a window opened since shows up).
  switchInstance: () => Promise<void>;
};

export const ConnectionContext = createContext<Ctx>({
  conn: null,
  state: 'closed',
  pair: () => {},
  unpair: async () => {},
  instances: null,
  instance: null,
  selectInstance: () => {},
  switchInstance: async () => {},
});

export const useConnection = () => useContext(ConnectionContext);
