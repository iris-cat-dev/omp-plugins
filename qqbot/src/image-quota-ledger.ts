import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";

export const QQ_IMAGE_QUOTA_EXHAUSTED =
  "QQ_IMAGE_QUOTA_EXHAUSTED: 每人每天最多可成功生成 10 次新图片，今日额度已用完（含处理中请求），北京时间午夜后恢复。";
export const QQ_IMAGE_QUOTA_IDENTITY_REQUIRED =
  "QQ_IMAGE_QUOTA_IDENTITY_REQUIRED: 无法确认图片请求的 QQ 发送者，已拒绝生成。";
const DAILY_LIMIT = 10;

export interface QQImageQuotaContext {
  appId: string;
  scope: 'c2c' | 'group';
  senderId: string;
}

export type ImageQuotaState = "pending" | "succeeded" | "failed";
interface ReservationRow {
  app_id: string;
  scope: string;
  sender_id: string;
  day: string;
  state: ImageQuotaState;
}
interface QuotaStatement {
  get(...params: string[]): unknown;
  run(...params: string[]): unknown;
}
interface QuotaDatabase {
  exec(sql: string): void;
  prepare(sql: string): QuotaStatement;
  close(): void;
}
export interface ImageQuotaReservation {
  created: boolean;
  state: ImageQuotaState;
  day: string;
}

/** Reservations use the Beijing day at admission, including across midnight settlement. */
export function imageQuotaDay(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Pending outcomes stay charged until an authoritative result arrives; never expire them. */
export class ImageGenerationQuotaLedger {
  private readonly database: QuotaDatabase;
  private readonly findReservation: QuotaStatement;
  private readonly countReservations: QuotaStatement;
  private readonly insertReservation: QuotaStatement;
  private readonly settleReservation: QuotaStatement;

  constructor(databasePath: string) {
    if (!isAbsolute(databasePath)) throw new Error("QQ image quota database must be absolute");
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    // The plugin opens its private ledger only when a new image is requested.
    const { DatabaseSync } = createRequire(process.execPath)("node:sqlite") as {
      DatabaseSync: new (path: string) => QuotaDatabase;
    };
    this.database = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS image_quota_reservations (
          request_id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('c2c', 'group')),
          sender_id TEXT NOT NULL,
          day TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed'))
        );
        CREATE INDEX IF NOT EXISTS image_quota_daily_owner
          ON image_quota_reservations (app_id, scope, sender_id, day, state);
      `);
      this.findReservation = this.database.prepare(
        "SELECT app_id, scope, sender_id, day, state FROM image_quota_reservations WHERE request_id = ?",
      );
      this.countReservations = this.database.prepare(`
        SELECT COUNT(*) AS used FROM image_quota_reservations
        WHERE app_id = ? AND scope = ? AND sender_id = ? AND day = ? AND state != 'failed'
      `);
      this.insertReservation = this.database.prepare(`
        INSERT INTO image_quota_reservations (request_id, app_id, scope, sender_id, day, state)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `);
      this.settleReservation = this.database.prepare(
        "UPDATE image_quota_reservations SET state = ? WHERE request_id = ? AND state = 'pending'",
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  reserve(requestId: string, quota: QQImageQuotaContext, now = Date.now()): ImageQuotaReservation {
    if (!requestId || !quota.appId.trim() || !quota.senderId.trim())
      throw new Error(QQ_IMAGE_QUOTA_IDENTITY_REQUIRED);
    const day = imageQuotaDay(now);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findReservation.get(requestId) as ReservationRow | undefined;
      if (existing) {
        if (existing.app_id !== quota.appId || existing.scope !== quota.scope || existing.sender_id !== quota.senderId)
          throw new Error("QQ image quota request identity changed");
        this.database.exec("COMMIT");
        return { created: false, state: existing.state, day: existing.day };
      }
      const count = this.countReservations.get(quota.appId, quota.scope, quota.senderId, day) as { used: number };
      if (count.used >= DAILY_LIMIT) throw new Error(QQ_IMAGE_QUOTA_EXHAUSTED);
      this.insertReservation.run(requestId, quota.appId, quota.scope, quota.senderId, day);
      this.database.exec("COMMIT");
      return { created: true, state: "pending", day };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  settle(requestId: string, outcome: "succeeded" | "failed"): void {
    // One terminal transition. Repeated or contradictory events cannot refund success.
    this.settleReservation.run(outcome, requestId);
  }

  close(): void {
    this.database.close();
  }
}
