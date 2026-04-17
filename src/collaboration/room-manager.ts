import { Room, RoomUser, UserRole, PresenceInfo, MAX_EDITORS } from './types';

// Random nickname generator
const ADJECTIVES = [
  'Happy', 'Clever', 'Brave', 'Calm', 'Swift', 'Bright', 'Cool', 'Bold',
  'Wise', 'Kind', 'Keen', 'Fair', 'Warm', 'Pure', 'Quick', 'Sharp',
  'Gentle', 'Noble', 'Proud', 'Vivid', 'Lucky', 'Witty', 'Jolly', 'Merry',
];
const ANIMALS = [
  'Fox', 'Owl', 'Bear', 'Wolf', 'Hawk', 'Deer', 'Lynx', 'Puma',
  'Eagle', 'Tiger', 'Lion', 'Raven', 'Swan', 'Crane', 'Otter', 'Panda',
  'Falcon', 'Dolphin', 'Koala', 'Parrot', 'Rabbit', 'Turtle', 'Phoenix', 'Dragon',
];
const COLORS = [
  '#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
  '#1ABC9C', '#E67E22', '#E91E63', '#00BCD4', '#8BC34A',
  '#FF5722', '#607D8B', '#795548', '#FF9800', '#4CAF50',
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateNickname(): string {
  return `${randomFrom(ADJECTIVES)} ${randomFrom(ANIMALS)}`;
}

function assignColor(existingColors: Set<string>): string {
  // Try to pick a color not yet used in the room
  const available = COLORS.filter(c => !existingColors.has(c));
  if (available.length > 0) {
    return randomFrom(available);
  }
  return randomFrom(COLORS);
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  // Map socketId → designId for cleanup on disconnect
  private socketToRoom: Map<string, string> = new Map();

  getRoom(designId: string): Room | undefined {
    return this.rooms.get(designId);
  }

  joinRoom(designId: string, socketId: string, sessionId: string): RoomUser {
    let room = this.rooms.get(designId);
    if (!room) {
      room = {
        designId,
        users: new Map(),
        editorCount: 0,
        viewerQueue: [],
      };
      this.rooms.set(designId, room);
    }

    // Check if same sessionId already in room (reconnect scenario)
    for (const [existingSocketId, user] of room.users) {
      if (user.sessionId === sessionId && existingSocketId !== socketId) {
        // Remove old connection
        this.removeUser(existingSocketId);
        break;
      }
    }

    const existingColors = new Set<string>();
    room.users.forEach(u => existingColors.add(u.color));

    const role = room.editorCount < MAX_EDITORS ? UserRole.EDITOR : UserRole.VIEWER;
    const user: RoomUser = {
      socketId,
      sessionId,
      nickname: generateNickname(),
      color: assignColor(existingColors),
      role,
      joinedAt: Date.now(),
      cursor: undefined,
      selectedElement: null,
    };

    room.users.set(socketId, user);

    if (role === UserRole.EDITOR) {
      room.editorCount++;
    } else {
      room.viewerQueue.push(socketId);
    }

    this.socketToRoom.set(socketId, designId);
    return user;
  }

  removeUser(socketId: string): { room: Room; removedUser: RoomUser; promotedUser?: RoomUser } | null {
    const designId = this.socketToRoom.get(socketId);
    if (!designId) return null;

    const room = this.rooms.get(designId);
    if (!room) return null;

    const user = room.users.get(socketId);
    if (!user) return null;

    room.users.delete(socketId);
    this.socketToRoom.delete(socketId);

    // Remove from viewer queue if viewer
    room.viewerQueue = room.viewerQueue.filter(id => id !== socketId);

    let promotedUser: RoomUser | undefined;

    if (user.role === UserRole.EDITOR) {
      room.editorCount--;
      // Promote first viewer in queue
      if (room.viewerQueue.length > 0) {
        const nextSocketId = room.viewerQueue.shift()!;
        const nextUser = room.users.get(nextSocketId);
        if (nextUser) {
          nextUser.role = UserRole.EDITOR;
          room.editorCount++;
          promotedUser = nextUser;
        }
      }
    }

    // Clean up empty rooms
    if (room.users.size === 0) {
      this.rooms.delete(designId);
    }

    return { room, removedUser: user, promotedUser };
  }

  requestEditSlot(socketId: string): { success: boolean; position?: number } {
    const designId = this.socketToRoom.get(socketId);
    if (!designId) return { success: false };

    const room = this.rooms.get(designId);
    if (!room) return { success: false };

    const user = room.users.get(socketId);
    if (!user) return { success: false };

    // Already an editor
    if (user.role === UserRole.EDITOR) return { success: true, position: 0 };

    // Check if slot available
    if (room.editorCount < MAX_EDITORS) {
      user.role = UserRole.EDITOR;
      room.editorCount++;
      room.viewerQueue = room.viewerQueue.filter(id => id !== socketId);
      return { success: true, position: 0 };
    }

    // Already in queue? Return position
    const pos = room.viewerQueue.indexOf(socketId);
    if (pos >= 0) {
      return { success: false, position: pos + 1 };
    }

    // Add to queue
    room.viewerQueue.push(socketId);
    return { success: false, position: room.viewerQueue.length };
  }

  updateCursor(socketId: string, cursor: { x: number; y: number }): void {
    const designId = this.socketToRoom.get(socketId);
    if (!designId) return;
    const room = this.rooms.get(designId);
    if (!room) return;
    const user = room.users.get(socketId);
    if (user) {
      user.cursor = cursor;
    }
  }

  updateSelection(socketId: string, selection: { type: number; id: string | number | null }): void {
    const designId = this.socketToRoom.get(socketId);
    if (!designId) return;
    const room = this.rooms.get(designId);
    if (!room) return;
    const user = room.users.get(socketId);
    if (user) {
      user.selectedElement = selection;
    }
  }

  getRoomUsers(designId: string): PresenceInfo[] {
    const room = this.rooms.get(designId);
    if (!room) return [];

    const users: PresenceInfo[] = [];
    room.users.forEach(u => {
      users.push({
        socketId: u.socketId,
        sessionId: u.sessionId,
        nickname: u.nickname,
        color: u.color,
        role: u.role,
        cursor: u.cursor,
        selectedElement: u.selectedElement,
      });
    });
    return users;
  }

  getRoomForSocket(socketId: string): string | undefined {
    return this.socketToRoom.get(socketId);
  }
}

export const roomManager = new RoomManager();
