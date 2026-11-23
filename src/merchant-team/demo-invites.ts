import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccessIdentity } from "./cloudflare-access";
import { TeamError } from "./error";

const minute = 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (bytes: number) => randomBytes(bytes).toString("base64url");
const recipientKey = (value: string) => value.normalize("NFKC").trim().toLowerCase();

type InviteRow = {
  id: string; recipient: string; recipientEmail: string | null; tokenHash: string; codeHash: string;
  startsAt: number; expiresAt: number; redeemedAt: number | null; revokedAt: number | null;
};

export class DemoInvites {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => Date.now()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
      CREATE TABLE IF NOT EXISTS demo_invites (
        id TEXT PRIMARY KEY, recipient TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        code_hash TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        redeemed_at INTEGER, revoked_at INTEGER, session_hash TEXT UNIQUE,
        recipient_email TEXT, access_subject TEXT
      )
      `);
      const columns = db.prepare("PRAGMA table_info(demo_invites)").all().map(column => column.name);
      if (!columns.includes("recipient_email")) db.exec("ALTER TABLE demo_invites ADD COLUMN recipient_email TEXT");
      if (!columns.includes("access_subject")) db.exec("ALTER TABLE demo_invites ADD COLUMN access_subject TEXT");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  plan(minutes: number) {
    const startsAt = (Math.floor(this.clock() / minute) + 1) * minute;
    return { startsAt, expiresAt: startsAt + minutes * minute };
  }

  issue(id: string, recipient: string, minutes: number, startsAt: number, recipientEmail?: string) {
    const now = this.clock();
    if (startsAt < now || startsAt > now + minute || startsAt % minute !== 0) {
      throw new TeamError("INVITE_PLAN_EXPIRED", 409);
    }
    const expiresAt = startsAt + minutes * minute;
    const token = secret(32);
    const code = secret(18);
    const result = this.db.prepare(`INSERT INTO demo_invites(id,recipient,token_hash,code_hash,starts_at,expires_at,recipient_email)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, recipient, digest(token), digest(code), startsAt, expiresAt, recipientEmail ?? null);
    if (!result.changes) throw new TeamError("INVITE_ALREADY_ISSUED", 409);
    return { id, recipient, token, code, startsAt, expiresAt };
  }

  list() {
    const now = this.clock();
    const rows = this.db.prepare(`SELECT id, recipient, starts_at AS startsAt, expires_at AS expiresAt,
      redeemed_at AS redeemedAt, revoked_at AS revokedAt FROM demo_invites ORDER BY rowid DESC LIMIT 100`).all() as unknown as
      Omit<InviteRow, "tokenHash" | "codeHash" | "recipientEmail">[];
    return rows.map(row => ({ ...row, status: row.revokedAt !== null ? "Revoked" : row.expiresAt <= now ? "Expired" :
      row.startsAt > now ? "Scheduled" : row.redeemedAt !== null ? "Redeemed" : "Ready" }));
  }

  revoke(id: string) {
    const now = this.clock();
    this.db.prepare("UPDATE demo_invites SET revoked_at=?, session_hash=NULL WHERE id=? AND revoked_at IS NULL AND expires_at>?")
      .run(now, id, now);
  }

  redeem(recipient: string, token: string, code: string, identity?: AccessIdentity) {
    const row = this.db.prepare(`SELECT id, recipient, code_hash AS codeHash, recipient_email AS recipientEmail
      FROM demo_invites WHERE token_hash=?`)
      .get(digest(token)) as Pick<InviteRow, "id" | "recipient" | "codeHash" | "recipientEmail"> | undefined;
    if (!row || row.recipientEmail !== (identity?.email ?? null) || recipientKey(row.recipient) !== recipientKey(recipient) ||
      !timingSafeEqual(Buffer.from(row.codeHash, "hex"), Buffer.from(digest(code), "hex"))) {
      throw new TeamError("INVITE_UNAVAILABLE", 403);
    }
    const now = this.clock();
    const session = secret(32);
    const accepted = this.db.prepare(`UPDATE demo_invites SET redeemed_at=?, session_hash=?, access_subject=?
      WHERE id=? AND revoked_at IS NULL AND redeemed_at IS NULL AND starts_at<=? AND expires_at>?
      RETURNING expires_at AS expiresAt`).get(now, digest(session), identity?.subject ?? null, row.id, now, now) as { expiresAt: number } | undefined;
    if (!accepted) throw new TeamError("INVITE_UNAVAILABLE", 403);
    return { session, expiresAt: accepted.expiresAt, remainingMs: accepted.expiresAt - now };
  }

  check(session: string, identity?: AccessIdentity) {
    const now = this.clock();
    const row = this.db.prepare(`SELECT expires_at AS expiresAt FROM demo_invites
      WHERE session_hash=? AND revoked_at IS NULL AND starts_at<=? AND expires_at>?
      AND recipient_email IS ? AND access_subject IS ?`)
      .get(digest(session), now, now, identity?.email ?? null, identity?.subject ?? null) as { expiresAt: number } | undefined;
    if (!row) return undefined;
    return { expiresAt: row.expiresAt, remainingMs: row.expiresAt - now };
  }
}
