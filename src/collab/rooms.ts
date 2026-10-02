import { queryOne, transaction } from '../db';
import { keepCurrentIfDue } from '../services/snapshots';
import { applyAll, Op } from './ops';

/** How long edits wait before being written to the database. */
const PERSIST_DELAY = 2000;

export type DiagramState = Record<string, unknown> & { name: string; database: string };

/** What the socket layer provides, so services can notify open rooms. */
export interface RoomEvents {
  emit(diagramId: string, event: string, payload: unknown): void;
  /** Re-checks everyone's access, e.g. after sharing changed. */
  revalidate(diagramId: string): Promise<void>;
}

let events: RoomEvents = { emit: () => {}, revalidate: async () => {} };
export const setRoomEvents = (e: RoomEvents) => (events = e);

/**
 * A diagram open in at least one editor. Its state is the source of truth
 * while open: edits are applied here in order and saved shortly after.
 */
export class Room {
  seq = 0;
  dirty = false;
  /** The last operation batch applied from each client (for resends). */
  lastOpByClient = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> | null = null;
  private lastEditor: string | null = null;

  constructor(
    readonly id: string,
    public state: DiagramState,
    public version: number,
  ) {}

  apply(ops: Op[], userId: string, clientId: string, opId: string) {
    this.state = applyAll(this.state, ops);
    this.seq++;
    this.lastOpByClient.set(clientId, opId);
    this.lastEditor = userId;
    this.dirty = true;
    // Saves every few seconds during continuous editing, not only after
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.save().catch((e) => console.error(`Saving diagram ${this.id} failed:`, e));
    }, PERSIST_DELAY);
  }

  /** Writes pending edits now. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
  }

  private async save() {
    // One save at a time; edits made meanwhile go in the next one
    while (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    const { name, database, ...content } = this.state;
    const editor = this.lastEditor;
    this.saving = (async () => {
      const saved = await transaction(async (db) => {
        const {
          rows: [row],
        } = await db.query<{ deleted: boolean }>(
          'SELECT deleted_at IS NOT NULL AS deleted FROM diagrams WHERE id = $1 FOR UPDATE',
          [this.id],
        );
        if (!row || row.deleted) return null;
        await keepCurrentIfDue(db, this.id);
        const {
          rows: [updated],
        } = await db.query<{ version: number }>(
          `UPDATE diagrams
              SET name = $2, database = $3, content = $4, size_bytes = $5, updated_by = $6,
                  version = version + 1, updated_at = now()
            WHERE id = $1
            RETURNING version`,
          [this.id, name, database, content, Buffer.byteLength(JSON.stringify(content)), editor],
        );
        return updated.version;
      });
      if (saved !== null) {
        this.version = saved;
        events.emit(this.id, 'saved', { version: saved });
      }
    })();
    try {
      await this.saving;
    } catch (e) {
      // Try again with the next edit
      this.dirty = true;
      throw e;
    } finally {
      this.saving = null;
    }
  }
}

const rooms = new Map<string, Room>();
const loading = new Map<string, Promise<Room | null>>();

async function loadState(id: string) {
  const row = await queryOne<{
    name: string;
    database: string;
    content: Record<string, unknown>;
    version: number;
  }>('SELECT name, database, content, version FROM diagrams WHERE id = $1 AND deleted_at IS NULL', [
    id,
  ]);
  if (!row) return null;
  const { pan: _pan, zoom: _zoom, ...content } = row.content;
  void _pan;
  void _zoom;
  return {
    state: { ...content, name: row.name, database: row.database } as DiagramState,
    version: row.version,
  };
}

/** The open room for a diagram, loading it if needed; null if it's gone. */
export async function openRoom(id: string): Promise<Room | null> {
  const open = rooms.get(id);
  if (open) return open;
  if (!loading.has(id)) {
    loading.set(
      id,
      loadState(id)
        .then((loaded) => {
          if (!loaded) return null;
          const room = new Room(id, loaded.state, loaded.version);
          rooms.set(id, room);
          return room;
        })
        .finally(() => loading.delete(id)),
    );
  }
  return loading.get(id)!;
}

export const getRoom = (id: string) => rooms.get(id) ?? null;

/** Saves and forgets a room nobody has open any more. */
export async function closeRoom(id: string, stillUsed: () => boolean) {
  const room = rooms.get(id);
  if (!room) return;
  await room.flush();
  if (!stillUsed()) rooms.delete(id);
}

/**
 * Before changing a diagram outside the room (a save from an editor
 * without a live connection, a restore): store the room's edits first.
 */
export async function flushRoom(id: string) {
  await rooms.get(id)?.flush();
}

/** After a change outside the room: everyone in it starts over from the database. */
export async function reloadRoom(id: string) {
  const room = rooms.get(id);
  if (!room) return;
  const loaded = await loadState(id);
  if (!loaded) return;
  room.state = loaded.state;
  room.version = loaded.version;
  room.seq++;
  room.dirty = false;
  events.emit(id, 'reset', { seq: room.seq, state: room.state, version: room.version });
}

/** After sharing or the trash changed: drop people who lost access. */
export const revalidateRoom = (id: string) =>
  rooms.has(id) ? events.revalidate(id) : Promise.resolve();

export async function flushAllRooms() {
  await Promise.allSettled([...rooms.values()].map((r) => r.flush()));
}
