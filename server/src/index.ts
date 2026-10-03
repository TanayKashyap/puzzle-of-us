import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import {
  SOCKET_MAX_BUFFER,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from '../../shared/types';
import { registerRoomHandlers } from './rooms';

export type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

/** Cross-origin sites allowed to connect: ALLOWED_ORIGINS (comma-separated) plus this project's Vercel URLs. */
const allowedOrigins: (string | RegExp)[] = [
  ...(process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  /^https:\/\/puzzle-of(-us)?\.vercel\.app$/,
  /^https:\/\/puzzle-of(-us)?-[a-z0-9-]+-tanaykashyaps-projects\.vercel\.app$/,
];
const isAllowedOrigin = (origin: string) =>
  allowedOrigins.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));

const app = express();
const httpServer = createServer(app);
const io: IO = new Server(httpServer, {
  maxHttpBufferSize: SOCKET_MAX_BUFFER,
  cors: { origin: allowedOrigins },
});

app.get('/healthz', (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.json({ ok: true });
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

io.on('connection', (socket) => {
  registerRoomHandlers(io, socket);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
