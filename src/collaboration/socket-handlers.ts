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
      socket.emit('room-joined', {
        role: user.role,
        users: allUsers,
        nickname: user.nickname,
        color: user.color,
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

      // If viewer, request full state from first editor
      if (user.role === UserRole.VIEWER) {
        const firstEditor = allUsers.find(u => u.role === UserRole.EDITOR && u.socketId !== socket.id);
        if (firstEditor) {
          // Ask the editor to send full state to this viewer
          io.to(firstEditor.socketId).emit('full-state-update', {} as any);
        }
      }

      console.log(`👤 ${user.nickname} (${user.role}) joined room ${designId} [${allUsers.length} users]`);
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
      socket.to(`design:${designId}`).emit('remote-operation', {
        ...op,
        userId: user.sessionId,
        nickname: user.nickname,
      });
    });

    socket.on('cursor-move', (cursor) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      roomManager.updateCursor(socket.id, cursor);

      // Broadcast to others (throttled on client side)
      socket.to(`design:${designId}`).emit('cursor-updated', {
        socketId: socket.id,
        cursor,
      });
    });

    socket.on('selection-change', (selection) => {
      const designId = roomManager.getRoomForSocket(socket.id);
      if (!designId) return;

      roomManager.updateSelection(socket.id, selection);

      socket.to(`design:${designId}`).emit('selection-updated', {
        socketId: socket.id,
        selection,
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

    socket.on('disconnect', () => {
      const result = roomManager.removeUser(socket.id);
      if (!result) return;

      const { room, removedUser, promotedUser } = result;
      const roomKey = `design:${room.designId}`;

      // Notify room about user leaving
      io.to(roomKey).emit('user-left', { socketId: socket.id });

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
