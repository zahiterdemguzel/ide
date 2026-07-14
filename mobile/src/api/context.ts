import { createContext, useContext } from 'react';
import { Connection, ConnectionState } from './connection';
import type { PairInfo } from './pairing';

export type Ctx = {
  conn: Connection | null;
  state: ConnectionState;
  pair: (info: PairInfo) => void;
  unpair: () => Promise<void>;
};

export const ConnectionContext = createContext<Ctx>({
  conn: null,
  state: 'closed',
  pair: () => {},
  unpair: async () => {},
});

export const useConnection = () => useContext(ConnectionContext);
