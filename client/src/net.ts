import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types';

export type GameClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Same-origin connection; in dev, Vite proxies /socket.io to the server on :3000. */
export const socket: GameClientSocket = io();
