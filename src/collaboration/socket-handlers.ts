import { Server, Socket } from 'socket.io';
import { roomManager } from './room-manager';
import { UserRole, ClientToServerEvents, ServerToClientEvents } from './types';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function registerSocketHandlers(io: IOServer): void {
  io.on('connection', (socket: IOSocket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    socket.on('join-room', ({ designId, sessionId }) => {
      if (!designId || !sessionId) {
        socket.emit('error', { message: 'Missing designId or sessionId' });
        return;
      }

      const user = roomManager.joinRoom(designId, socket.id, sessionId);
      const roomKey = `design:${designId}`;

      socket.join(roomKey);

      // Send joined user their info + current room users
      const allUsers = roomManager.getRoomUsers(designId);
      const entityLocks = roomManager.getEntityLocks(designId);
      socket.emit('room-joined', {
        role: user.role,
        users: allUsers,
        nickname: user.nickname,
        color: user.color,
        entityLocks,
      });

      // Notify others in the room
      socket.to(roomKey).emit('user-joined', {
        socketId: user.socketId,
        sessionId: user.sessionId,
        nickname: user.nickname,
        color: user.color,
        role: user.role,
        cursor: user.cursor,
        selectedElement: user.selectedElement,
      });

      console.log(`👤 ${user.nickname} (${user.role}) joined room ${designId} [${allUsers.length} users]`);
    });

    // A reconnecting client requests full state from another peer
    socket.on('request-full-state', () => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const allUsers = roomManager.getRoomUsers(designId);
      // Find an editor (not the requester) to ask for state
      const peer = allUsers.find(u => u.role === UserRole.EDITOR && u.socketId !== socket.id);
      if (peer) {
        // Ask peer to send their full state — peer will emit 'full-state-sync'
        io.to(peer.socketId).emit('request-state-from-peer', { requestingSocketId: socket.id });
      }
    });

    // Peer responds with full state for a specific requester
    socket.on('full-state-for-peer', ({ targetSocketId, data }) => {
      if (targetSocketId && data) {
        io.to(targetSocketId).emit('full-state-update', data);
      }
    });

    socket.on('operation', (op) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const room = roomManager.getRoom(designId);
      if (!room) return;

      const user = room.users.get(socket.id);
      if (!user) return;

      // Only editors can send operations
      if (user.role !== UserRole.EDITOR) {
        socket.emit('error', { message: 'Only editors can perform operations' });
        return;
      }

      // Broadcast to all others in the room
      const seq = roomManager.getNextSeq(designId);
      socket.to(`design:${designId}`).emit('remote-operation', {
        ...op,
        userId: user.sessionId,
        nickname: user.nickname,
        seq,
      });
    });

    socket.on('lock-entity', ({ entityKey }) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const lock = roomManager.lockEntity(socket.id, entityKey);
      if (lock) {
        socket.to(`design:${designId}`).emit('entity-locked', {
          entityKey,
          socketId: socket.id,
          nickname: lock.nickname,
          color: lock.color,
        });
      }
    });

    socket.on('unlock-entity', ({ entityKey }) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const unlocked = roomManager.unlockEntity(socket.id, entityKey);
      if (unlocked) {
        socket.to(`design:${designId}`).emit('entity-unlocked', {
          entityKey,
          socketId: socket.id,
        });
      }
    });

    socket.on('cursor-move', (cursor) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      roomManager.updateCursor(socket.id, cursor);

      const room = roomManager.getRoom(designId);
      const user = room?.users.get(socket.id);

      // Broadcast to others (throttled on client side)
      socket.to(`design:${designId}`).emit('cursor-updated', {
        socketId: socket.id,
        cursor,
        nickname: user?.nickname || 'Unknown',
        color: user?.color || '#999',
      });
    });

    socket.on('selection-change', (selection) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      roomManager.updateSelection(socket.id, selection);

      const room = roomManager.getRoom(designId);
      const user = room?.users.get(socket.id);

      socket.to(`design:${designId}`).emit('selection-updated', {
        socketId: socket.id,
        selection,
        nickname: user?.nickname || 'Unknown',
        color: user?.color || '#999',
      });
    });

    socket.on('request-edit-slot', () => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const result = roomManager.requestEditSlot(socket.id);
      if (result.success) {
        socket.emit('role-changed', {
          role: UserRole.EDITOR,
          message: 'You are now an editor',
        });
        // Notify others
        socket.to(`design:${designId}`).emit('user-joined', {
          ...roomManager.getRoomUsers(designId).find(u => u.socketId === socket.id)!,
        });
      } else {
        socket.emit('error', {
          message: `No editor slots available. You are #${result.position} in queue.`,
        });
      }
    });

    socket.on('full-state-sync', (data) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      // Broadcast full state to all viewers who just joined
      socket.to(`design:${designId}`).emit('full-state-update', data);
    });

    // Explicit leave-room (client navigates away but socket may stay alive)
    socket.on('leave-room', () => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      const result = roomManager.removeUser(socket.id);
      if (!result) return;

      const { room, removedUser, promotedUser, releasedLocks } = result;
      const roomKey = `design:${designId}`;

      socket.leave(roomKey);

      io.to(roomKey).emit('user-left', { socketId: socket.id });

      for (const entityKey of releasedLocks) {
        io.to(roomKey).emit('entity-unlocked', { entityKey, socketId: socket.id });
      }

      if (promotedUser) {
        io.to(promotedUser.socketId).emit('role-changed', {
          role: UserRole.EDITOR,
          message: 'An editor left. You have been promoted to editor!',
        });
      }

      console.log(`🚪 ${removedUser.nickname} left room ${designId} [${room.users.size} users remaining]`);
    });

    socket.on('disconnect', () => {
      const result = roomManager.removeUser(socket.id);
      if (!result) return;

      const { room, removedUser, promotedUser, releasedLocks } = result;
      const roomKey = `design:${room.designId}`;

      // Notify room about user leaving
      io.to(roomKey).emit('user-left', { socketId: socket.id });

      // Broadcast released entity locks
      for (const entityKey of releasedLocks) {
        io.to(roomKey).emit('entity-unlocked', { entityKey, socketId: socket.id });
      }

      // Notify promoted user
      if (promotedUser) {
        io.to(promotedUser.socketId).emit('role-changed', {
          role: UserRole.EDITOR,
          message: 'An editor left. You have been promoted to editor!',
        });
      }

      console.log(`👋 ${removedUser.nickname} left room ${room.designId} [${room.users.size} users remaining]`);
    });
  });
}
