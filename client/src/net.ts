import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types';

export type GameClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Game server origin when the site is hosted separately; empty means same origin (Vite proxies in dev). */
export const SERVER_URL = (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/+$/, '');

export const socket: GameClientSocket = io(SERVER_URL || undefined, {
  transports: ['websocket', 'polling'],
});

/** Nudge a sleeping server (Render free tier) awake while the socket keeps retrying. */
export function wakeServer(): void {
  fetch(`${SERVER_URL}/healthz`, { cache: 'no-store' }).catch(() => {});
}
