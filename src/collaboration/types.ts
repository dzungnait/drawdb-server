export const MAX_EDITORS = 15;

export enum UserRole {
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

export interface RoomUser {
  socketId: string;
  sessionId: string;
  nickname: string;
  color: string;
  role: UserRole;
  joinedAt: number;
  cursor?: { x: number; y: number };
  selectedElement?: { type: number; id: string | number | null } | null;
}

export interface EntityLockInfo {
  entityKey: string; // e.g. "table:3" or "table:3:field:1"
  socketId: string;
  nickname: string;
  color: string;
  lockedAt: number;
}

export interface Room {
  designId: string;
  users: Map<string, RoomUser>; // socketId -> RoomUser
  editorCount: number;
  viewerQueue: string[]; // socketIds in order, for slot promotion
  nextSeqNumber: number;
  entityLocks: Map<string, EntityLockInfo>; // entityKey -> lock info
}

export interface OperationPayload {
  id: string;
  type: 'add' | 'delete' | 'edit' | 'move' | 'edit-field' | 'delete-field';
  target: 'table' | 'relationship' | 'note' | 'area' | 'type' | 'enum';
  targetId: string | number;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface CursorPayload {
  x: number;
  y: number;
}

export interface SelectionPayload {
  type: number;
  id: string | number | null;
}

export interface PresenceInfo {
  socketId: string;
  sessionId: string;
  nickname: string;
  color: string;
  role: UserRole;
  cursor?: { x: number; y: number };
  selectedElement?: { type: number; id: string | number | null } | null;
}

// Events: client → server
export interface ClientToServerEvents {
  'join-room': (data: { designId: string; sessionId: string }) => void;
  'leave-room': () => void;
  'operation': (op: OperationPayload) => void;
  'cursor-move': (cursor: CursorPayload) => void;
  'selection-change': (selection: SelectionPayload) => void;
  'request-edit-slot': () => void;
  'lock-entity': (data: { entityKey: string }) => void;
  'unlock-entity': (data: { entityKey: string }) => void;
  'full-state-sync': (data: { tables: unknown[]; relationships: unknown[]; notes: unknown[]; areas: unknown[]; types?: unknown[]; enums?: unknown[] }) => void;
  'request-full-state': () => void;
  'full-state-for-peer': (data: { targetSocketId: string; data: { tables: unknown[]; relationships: unknown[]; notes: unknown[]; areas: unknown[]; types?: unknown[]; enums?: unknown[] } }) => void;
}

// Events: server → client
export interface ServerToClientEvents {
  'room-joined': (data: { role: UserRole; users: PresenceInfo[]; nickname: string; color: string; entityLocks: EntityLockInfo[] }) => void;
  'user-joined': (user: PresenceInfo) => void;
  'user-left': (data: { socketId: string }) => void;
  'remote-operation': (op: OperationPayload & { userId: string; nickname: string; seq: number }) => void;
  'entity-locked': (data: { entityKey: string; socketId: string; nickname: string; color: string }) => void;
  'entity-unlocked': (data: { entityKey: string; socketId: string }) => void;
  'cursor-updated': (data: { socketId: string; cursor: CursorPayload; nickname: string; color: string }) => void;
  'selection-updated': (data: { socketId: string; selection: SelectionPayload; nickname: string; color: string }) => void;
  'role-changed': (data: { role: UserRole; message: string }) => void;
  'edit-slot-available': (data: { message: string }) => void;
  'full-state-update': (data: { tables: unknown[]; relationships: unknown[]; notes: unknown[]; areas: unknown[]; types?: unknown[]; enums?: unknown[] }) => void;
  'request-state-from-peer': (data: { requestingSocketId: string }) => void;
  'error': (data: { message: string }) => void;
}
