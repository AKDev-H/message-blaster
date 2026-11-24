import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { normalizeEmail } from '../utils/email.util.js';

export type AuthRole = 'admin' | 'operator';

export interface AuthUser {
    id: number;
    email: string;
    role: AuthRole;
    enabled: boolean;
    name: string | null;
    picture: string | null;
}

export interface GoogleProfile {
    name?: string;
    picture?: string;
}

export interface Session {
    user: AuthUser;
    expiresAt: number;
}

export interface AuditInput {
    actorId?: number;
    source?: 'web' | 'cli' | 'worker';
    action: string;
    target?: string;
    outcome: 'success' | 'denied' | 'failed' | 'accepted';
    requestId?: string;
}

export interface AuditEvent {
    id: number;
    occurredAt: number;
    actorId: number | null;
    source: NonNullable<AuditInput['source']>;
    action: string;
    target: string | null;
    outcome: AuditInput['outcome'];
    requestId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    actorPicture: string | null;
}

export interface AuditRange {
    from?: number;
    to?: number;
}

export interface AuditPage {
    events: AuditEvent[];
    page: number;
    pageSize: number;
    totalPages: number;
    total: number;
}

export interface ApprovalSync {
    added: string[];
    enabled: string[];
    disabled: string[];
}

interface UserRow extends Omit<AuthUser, 'enabled' | 'name' | 'picture'> {
    enabled: 0 | 1;
    display_name: string | null;
    picture_url: string | null;
}

const USER_COLUMNS = 'id, email, role, enabled, display_name, picture_url';
const AUDIT_COLUMNS = `
    e.id, e.occurred_at AS occurredAt, e.actor_id AS actorId, e.source, e.action, e.target, e.outcome, e.request_id AS requestId,
    u.display_name AS actorName, u.email AS actorEmail, u.picture_url AS actorPicture
`;

interface OAuthFlow {
    nonce: string;
    verifier: string;
}

function authUser(row: UserRow): AuthUser {
    return { id: row.id, email: row.email, role: row.role, enabled: row.enabled === 1, name: row.display_name, picture: row.picture_url };
}

export class AuthStore {
    readonly #lookupSession: StatementSync;
    readonly #writeEvent: StatementSync;

    constructor(private readonly db: DatabaseSync) {
        this.#lookupSession = db.prepare(`
            SELECT u.id, u.email, u.role, u.enabled, u.display_name, u.picture_url, s.expires_at AS expiresAt
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1
        `);
        this.#writeEvent = db.prepare(`
            INSERT INTO audit_events (occurred_at, actor_id, source, action, target, outcome, request_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
    }

    bootstrap(email: string): AuthUser {
        return transaction(this.db, () => {
            if (this.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
                throw new ConflictError('The user registry has already been initialized.');
            }
            return this.insertUser(email, 'admin', 'user.bootstrap');
        });
    }

    allowUser(email: string, role: AuthRole, actorId?: number): AuthUser {
        return transaction(this.db, () => this.insertUser(email, role, 'user.invite', actorId));
    }

    syncApprovedAccounts(emails: readonly string[]): ApprovalSync {
        return transaction(this.db, () => {
            const approved = new Set(emails.map(normalizeEmail));
            const result: ApprovalSync = { added: [], enabled: [], disabled: [] };
            for (const email of approved) this.approve(email, result);
            for (const user of this.listUsers()) {
                if (approved.has(user.email) || !user.enabled) continue;
                this.db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(user.id);
                this.deleteSessionRows(user.id);
                this.auditUserAction('user.disable', user.id);
                result.disabled.push(user.email);
            }
            return result;
        });
    }

    userByEmail(email: string): AuthUser | undefined {
        const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(normalizeEmail(email)) as UserRow | undefined;
        return row && authUser(row);
    }

    listUsers(): AuthUser[] {
        return (this.db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY email`).all() as unknown as UserRow[]).map(authUser);
    }

    setUserEnabled(userId: number, enabled: boolean, actorId?: number): AuthUser {
        return transaction(this.db, () => {
            const user = this.getUser(userId);
            if (user.enabled === enabled) return user;
            if (!enabled && user.role === 'admin') this.requireOtherAdmin(userId);
            this.db.prepare('UPDATE users SET enabled = ? WHERE id = ?').run(Number(enabled), userId);
            if (!enabled) this.deleteSessionRows(userId);
            this.auditUserAction(enabled ? 'user.enable' : 'user.disable', userId, actorId);
            return { ...user, enabled };
        });
    }

    revokeUserSessions(userId: number, actorId?: number): number {
        return transaction(this.db, () => {
            this.getUser(userId);
            const count = this.deleteSessionRows(userId);
            this.auditUserAction('user.revoke_sessions', userId, actorId);
            return count;
        });
    }

    revokeAllSessions(actorId?: number): number {
        return transaction(this.db, () => {
            const deleted = this.db.prepare('DELETE FROM sessions').run();
            this.db.prepare('DELETE FROM oauth_flows').run();
            this.auditUserAction('user.revoke_all_sessions', undefined, actorId);
            return Number(deleted.changes);
        });
    }

    saveFlow(tokenHash: string, stateHash: string, flow: OAuthFlow, expiresAt: number): void {
        this.db.prepare(`
            INSERT INTO oauth_flows (token_hash, state_hash, nonce, verifier, expires_at) VALUES (?, ?, ?, ?, ?)
        `).run(tokenHash, stateHash, flow.nonce, flow.verifier, expiresAt);
    }

    consumeFlow(tokenHash: string, stateHash: string, now: number): OAuthFlow | undefined {
        return this.db.prepare(`
            DELETE FROM oauth_flows WHERE token_hash = ? AND state_hash = ? AND expires_at > ? RETURNING nonce, verifier
        `).get(tokenHash, stateHash, now) as OAuthFlow | undefined;
    }

    createSession(subject: string, invitedEmail: string | undefined, tokenHash: string, expiresAt: number, profile: GoogleProfile = {}): AuthUser | undefined {
        return transaction(this.db, () => {
            const found = this.findGoogleUser(subject, invitedEmail);
            if (!found?.enabled) {
                this.audit({ ...(found && { actorId: found.id }), action: 'auth.sign_in', outcome: 'denied' });
                return undefined;
            }
            const user = this.saveProfile(found, profile);
            this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, user.id, expiresAt);
            this.audit({ actorId: user.id, action: 'auth.sign_in', outcome: 'success' });
            return user;
        });
    }

    session(tokenHash: string, now: number): Session | undefined {
        const row = this.#lookupSession.get(tokenHash, now) as (UserRow & { expiresAt: number }) | undefined;
        return row && { user: authUser(row), expiresAt: row.expiresAt };
    }

    closeSession(tokenHash: string): void {
        transaction(this.db, () => {
            const row = this.db.prepare('DELETE FROM sessions WHERE token_hash = ? RETURNING user_id').get(tokenHash);
            if (row) this.audit({ actorId: Number(row.user_id), action: 'auth.sign_out', outcome: 'success' });
        });
    }

    audit(event: AuditInput): void {
        this.#writeEvent.run(Date.now(), event.actorId ?? null, event.source ?? 'web', event.action, event.target ?? null, event.outcome, event.requestId ?? null);
    }

    listAudit(beforeId?: number, limit = 50): AuditEvent[] {
        const select = `SELECT ${AUDIT_COLUMNS} FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id`;
        const pageSize = Math.min(100, Math.max(1, limit));
        const rows = beforeId === undefined
            ? this.db.prepare(`${select} ORDER BY e.id DESC LIMIT ?`).all(pageSize)
            : this.db.prepare(`${select} WHERE e.id < ? ORDER BY e.id DESC LIMIT ?`).all(beforeId, pageSize);
        return rows as unknown as AuditEvent[];
    }

    auditPage(page: number, pageSize = 50, range: AuditRange = {}): AuditPage {
        const size = Math.min(100, Math.max(1, pageSize));
        const where = 'WHERE e.occurred_at >= ? AND e.occurred_at <= ?';
        const bounds = [range.from ?? 0, range.to ?? Number.MAX_SAFE_INTEGER];
        const total = Number(this.db.prepare(`SELECT count(*) AS total FROM audit_events e ${where}`).get(...bounds)?.total ?? 0);
        const totalPages = Math.max(1, Math.ceil(total / size));
        const current = Math.min(Math.max(1, page), totalPages);
        const rows = this.db.prepare(`
            SELECT ${AUDIT_COLUMNS} FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
            ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?
        `).all(...bounds, size, (current - 1) * size);
        return { events: rows as unknown as AuditEvent[], page: current, pageSize: size, totalPages, total };
    }

    expire(now: number): void {
        transaction(this.db, () => this.deleteExpired(now));
    }

    prune(now = Date.now(), retentionDays = 90): { sessions: number; flows: number; events: number } {
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error('Audit retention must be a positive number of days.');
        const retentionMs = retentionDays * 86_400_000;
        return transaction(this.db, () => ({
            ...this.deleteExpired(now),
            events: Number(this.db.prepare('DELETE FROM audit_events WHERE occurred_at < ?').run(now - retentionMs).changes),
        }));
    }

    private deleteExpired(now: number): { sessions: number; flows: number } {
        return {
            sessions: Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes),
            flows: Number(this.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now).changes),
        };
    }

    private insertUser(email: string, role: AuthRole, action: string, actorId?: number): AuthUser {
        const normalized = normalizeEmail(email);
        const row = this.db.prepare(`
            INSERT INTO users (email, role) VALUES (?, ?) ON CONFLICT (email) DO NOTHING RETURNING ${USER_COLUMNS}
        `).get(normalized, role) as UserRow | undefined;
        if (!row) throw new ConflictError('This email is already registered.');
        this.auditUserAction(action, row.id, actorId);
        return authUser(row);
    }

    private approve(email: string, result: ApprovalSync): void {
        const user = this.userByEmail(email);
        if (!user) {
            this.insertUser(email, 'admin', 'user.invite');
            result.added.push(email);
        } else if (!user.enabled) {
            this.db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(user.id);
            this.auditUserAction('user.enable', user.id);
            result.enabled.push(email);
        }
    }

    private getUser(userId: number): AuthUser {
        const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
        if (!row) throw new NotFoundError('This user does not exist.');
        return authUser(row);
    }

    private requireOtherAdmin(userId: number): void {
        if (!this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND enabled = 1 AND id <> ? LIMIT 1").get(userId)) {
            throw new ConflictError('At least one administrator must stay enabled.');
        }
    }

    private deleteSessionRows(userId: number): number {
        return Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
    }

    private auditUserAction(action: string, userId: number | undefined, actorId?: number): void {
        this.audit({
            ...(actorId !== undefined && { actorId }),
            ...(userId !== undefined && { target: String(userId) }),
            source: actorId === undefined ? 'cli' : 'web',
            action,
            outcome: 'success',
        });
    }

    private saveProfile(user: AuthUser, profile: GoogleProfile): AuthUser {
        const name = profile.name?.trim().slice(0, 200) || user.name;
        const picture = isHttpsUrl(profile.picture) ? profile.picture : user.picture;
        if (name === user.name && picture === user.picture) return user;
        this.db.prepare('UPDATE users SET display_name = ?, picture_url = ? WHERE id = ?').run(name, picture, user.id);
        return { ...user, name, picture };
    }

    private findGoogleUser(subject: string, invitedEmail: string | undefined): AuthUser | undefined {
        const bound = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_subject = ?`).get(subject) as UserRow | undefined;
        if (bound) return authUser(bound);
        if (!invitedEmail) return undefined;
        const row = this.db.prepare(`
            UPDATE users SET google_subject = ? WHERE email = ? AND google_subject IS NULL AND enabled = 1
            RETURNING ${USER_COLUMNS}
        `).get(subject, invitedEmail) as UserRow | undefined;
        return row && authUser(row);
    }
}

function isHttpsUrl(value: string | undefined): value is string {
    if (!value || value.length > 2048) return false;
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}
