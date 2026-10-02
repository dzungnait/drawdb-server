import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '../config';
import { isAllowedOrigin } from '../auth/middleware';
import { userForSessionToken } from '../auth/session';
import { canWrite, load, Role } from '../services/diagram-service';
import { UserRow } from '../services/user-service';
import { runWithShareLink } from '../utils/request-context';
import { isValidOp, Op } from './ops';
import { closeRoom, getRoom, openRoom, setRoomEvents } from './rooms';

const COLORS = [
  '#e11d48',
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
];
const MAX_OPS_PER_BATCH = 500;
// Per connection; the editor sends a batch at most every ~50ms
const MAX_EVENTS_PER_SECOND = 40;

interface Member {
  diagramId: string;
  clientId: string;
  link: string | null;
  role: Role;
}

interface SocketData {
  user: UserRow | null;
  color: string;
  member?: Member;
  budget: { second: number; used: number };
}

type CollabSocket = Socket & { data: SocketData };

function colorFor(key: string) {
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function readCookie(header: string | undefined, name: string) {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The caller's access, as for GET /diagrams/:id; null without any. */
async function accessOf(diagramId: string, user: UserRow | null, link: string | null) {
  try {
    return await runWithShareLink(link, () => load(diagramId, user));
  } catch {
    return null;
  }
}

const peerOf = (socket: CollabSocket) => ({
  sid: socket.id,
  userId: socket.data.user?.id ?? null,
  name: socket.data.user?.name || socket.data.user?.email || null,
  avatarUrl: socket.data.user?.avatar_url ?? null,
  color: socket.data.color,
  role: socket.data.member?.role,
});

/** Spends from the connection's budget; false when it's sending too much. */
function spend(socket: CollabSocket) {
  const now = Math.floor(Date.now() / 1000);
  const budget = socket.data.budget;
  if (budget.second !== now) {
    budget.second = now;
    budget.used = 0;
  }
  return ++budget.used <= MAX_EVENTS_PER_SECOND;
}

export function attachCollab(server: HttpServer) {
  const io = new Server(server, {
    path: '/socket.io',
    serveClient: false,
    // One batch of operations; whole diagrams only go server -> client
    maxHttpBufferSize: 1e6,
    cors: {
      origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
      credentials: true,
    },
  });

  // Who is connecting: the session cookie, if any. Signed-out visitors
  // can still join with a share link.
  io.use(async (socket: CollabSocket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return next(new Error('bad_origin'));
    const token = readCookie(socket.handshake.headers.cookie, config.auth.cookieName);
    let user = token ? await userForSessionToken(token).catch(() => null) : null;
    if (user && config.auth.requireEmailVerification && !user.email_verified_at) user = null;
    socket.data.user = user;
    socket.data.color = colorFor(user?.id ?? socket.id);
    socket.data.budget = { second: 0, used: 0 };
    next();
  });

  const socketsIn = async (diagramId: string) =>
    (await io.in(diagramId).fetchSockets()) as unknown as CollabSocket[];

  async function leave(socket: CollabSocket) {
    const member = socket.data.member;
    if (!member) return;
    socket.data.member = undefined;
    await socket.leave(member.diagramId);
    socket.to(member.diagramId).emit('peer-leave', { sid: socket.id });
    const id = member.diagramId;
    if ((await socketsIn(id)).length === 0) {
      await closeRoom(id, () => (io.sockets.adapter.rooms.get(id)?.size ?? 0) > 0).catch((e) =>
        console.error(`Closing diagram ${id} failed:`, e),
      );
    }
  }

  setRoomEvents({
    emit: (diagramId, event, payload) => io.to(diagramId).emit(event, payload),
    async revalidate(diagramId) {
      for (const socket of await socketsIn(diagramId)) {
        const member = socket.data.member;
        if (!member) continue;
        const access = await accessOf(diagramId, socket.data.user, member.link);
        if (!access) {
          socket.emit('kicked', { diagramId });
          await leave(socket);
        } else if (access.role !== member.role) {
          member.role = access.role;
          socket.emit('role', { role: access.role, canWrite: canWrite(access.role) });
          io.to(diagramId).emit('peer-update', peerOf(socket));
        }
      }
    },
  });

  io.on('connection', (socket: CollabSocket) => {
    socket.on('join', async (payload: unknown, ack: (r: unknown) => void) => {
      if (typeof ack !== 'function') return;
      const { diagramId, clientId, link } = (payload ?? {}) as Record<string, unknown>;
      if (
        typeof diagramId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(diagramId) ||
        typeof clientId !== 'string' ||
        clientId.length > 64
      ) {
        return ack({ error: 'invalid_input' });
      }
      const shareLink = typeof link === 'string' ? link : null;
      const access = await accessOf(diagramId, socket.data.user, shareLink);
      const room = access && (await openRoom(diagramId));
      if (!access || !room) return ack({ error: 'diagram_not_found' });

      if (socket.data.member && socket.data.member.diagramId !== diagramId) await leave(socket);
      socket.data.member = { diagramId, clientId, link: shareLink, role: access.role };
      await socket.join(diagramId);
      const peers = (await socketsIn(diagramId)).filter((s) => s.id !== socket.id).map(peerOf);
      socket.to(diagramId).emit('peer-join', peerOf(socket));
      ack({
        state: room.state,
        seq: room.seq,
        version: room.version,
        role: access.role,
        canWrite: canWrite(access.role),
        lastOp: room.lastOpByClient.get(clientId) ?? null,
        self: peerOf(socket),
        peers,
      });
    });

    socket.on('ops', (payload: unknown, ack: (r: unknown) => void) => {
      if (typeof ack !== 'function') return;
      const member = socket.data.member;
      const { diagramId, opId, ops } = (payload ?? {}) as Record<string, unknown>;
      const room = member && member.diagramId === diagramId ? getRoom(member.diagramId) : null;
      if (!member || !room) return ack({ error: 'not_joined' });
      if (!canWrite(member.role) || !socket.data.user) return ack({ error: 'read_only' });
      if (!spend(socket)) return ack({ error: 'rate_limited' });
      if (
        typeof opId !== 'string' ||
        opId.length > 64 ||
        !Array.isArray(ops) ||
        ops.length > MAX_OPS_PER_BATCH ||
        !ops.every(isValidOp)
      ) {
        return ack({ error: 'invalid_input' });
      }
      room.apply(ops as Op[], socket.data.user.id, member.clientId, opId);
      // To everyone, sender included: the order everyone applies them in
      io.to(room.id).emit('ops', { seq: room.seq, ops, opId, clientId: member.clientId });
      ack({ seq: room.seq });
    });

    // Cursors and selections: relayed as they are, never stored
    socket.on('awareness', (payload: unknown) => {
      const member = socket.data.member;
      if (!member || !spend(socket)) return;
      const { cursor, selection, linking } = (payload ?? {}) as Record<string, unknown>;
      const point = (v: unknown) => {
        const p = v as { x?: unknown; y?: unknown } | null;
        return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
      };
      // The relationship line being dragged
      const line = linking as Record<string, unknown> | null;
      const ends = ['startX', 'startY', 'endX', 'endY'] as const;
      const sel = selection as { element?: unknown; id?: unknown } | null;
      socket.to(member.diagramId).volatile.emit('awareness', {
        sid: socket.id,
        cursor: point(cursor),
        selection:
          sel && typeof sel.element === 'number' && ['string', 'number'].includes(typeof sel.id)
            ? { element: sel.element, id: sel.id }
            : null,
        linking:
          line && ends.every((k) => Number.isFinite(line[k]))
            ? Object.fromEntries(ends.map((k) => [k, line[k]]))
            : null,
      });
    });

    socket.on('leave', () => {
      leave(socket).catch(() => {});
    });
    socket.on('disconnecting', () => {
      leave(socket).catch(() => {});
    });
  });

  return io;
}
