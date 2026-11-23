import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TeamError } from "./error";

const minute = 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (bytes: number) => randomBytes(bytes).toString("base64url");
const recipientKey = (value: string) => value.normalize("NFKC").trim().toLowerCase();

type InviteRow = {
  id: string; recipient: string; tokenHash: string; codeHash: string;
  startsAt: number; expiresAt: number; redeemedAt: number | null; revokedAt: number | null;
};

export class DemoInvites {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => Date.now()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS demo_invites (
        id TEXT PRIMARY KEY, recipient TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        code_hash TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        redeemed_at INTEGER, revoked_at INTEGER, session_hash TEXT UNIQUE
      )
    `);
  }

  plan(minutes: number) {
    const startsAt = (Math.floor(this.clock() / minute) + 1) * minute;
    return { startsAt, expiresAt: startsAt + minutes * minute };
  }

  issue(id: string, recipient: string, minutes: number, startsAt: number) {
    const now = this.clock();
    if (startsAt < now || startsAt > now + minute || startsAt % minute !== 0) {
      throw new TeamError("INVITE_PLAN_EXPIRED", 409);
    }
    const expiresAt = startsAt + minutes * minute;
    const token = secret(32);
    const code = secret(18);
    const result = this.db.prepare(`INSERT INTO demo_invites(id,recipient,token_hash,code_hash,starts_at,expires_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, recipient, digest(token), digest(code), startsAt, expiresAt);
    if (!result.changes) throw new TeamError("INVITE_ALREADY_ISSUED", 409);
    return { id, recipient, token, code, startsAt, expiresAt };
  }

  list() {
    const now = this.clock();
    const rows = this.db.prepare(`SELECT id, recipient, starts_at AS startsAt, expires_at AS expiresAt,
      redeemed_at AS redeemedAt, revoked_at AS revokedAt FROM demo_invites ORDER BY rowid DESC LIMIT 100`).all() as unknown as
      Omit<InviteRow, "tokenHash" | "codeHash">[];
    return rows.map(row => ({ ...row, status: row.revokedAt !== null ? "Revoked" : row.expiresAt <= now ? "Expired" :
      row.startsAt > now ? "Scheduled" : row.redeemedAt !== null ? "Redeemed" : "Ready" }));
  }

  revoke(id: string) {
    this.db.prepare("UPDATE demo_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>?")
      .run(this.clock(), id, this.clock());
  }

  redeem(recipient: string, token: string, code: string) {
    const row = this.db.prepare(`SELECT id, recipient, code_hash AS codeHash FROM demo_invites WHERE token_hash=?`)
      .get(digest(token)) as Pick<InviteRow, "id" | "recipient" | "codeHash"> | undefined;
    if (!row || recipientKey(row.recipient) !== recipientKey(recipient) ||
      !timingSafeEqual(Buffer.from(row.codeHash, "hex"), Buffer.from(digest(code), "hex"))) {
      throw new TeamError("INVITE_UNAVAILABLE", 403);
    }
    const now = this.clock();
    const session = secret(32);
    const accepted = this.db.prepare(`UPDATE demo_invites SET redeemed_at=?, session_hash=?
      WHERE id=? AND revoked_at IS NULL AND redeemed_at IS NULL AND starts_at<=? AND expires_at>?
      RETURNING expires_at AS expiresAt`).get(now, digest(session), row.id, now, now) as { expiresAt: number } | undefined;
    if (!accepted) throw new TeamError("INVITE_UNAVAILABLE", 403);
    return { session, expiresAt: accepted.expiresAt, remainingMs: accepted.expiresAt - now };
  }

  check(session: string) {
    const now = this.clock();
    const row = this.db.prepare(`SELECT expires_at AS expiresAt FROM demo_invites
      WHERE session_hash=? AND revoked_at IS NULL AND starts_at<=? AND expires_at>?`)
      .get(digest(session), now, now) as { expiresAt: number } | undefined;
    if (!row) return undefined;
    return { expiresAt: row.expiresAt, remainingMs: row.expiresAt - now };
  }
}
