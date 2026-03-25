import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  const token = localStorage.getItem('nanoclaw_token') || '';
  socket = io({
    auth: { token },
    transports: ['websocket', 'polling'],
  });
  return socket;
}
