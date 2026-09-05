import { SERVER_PORT, isSecurePage, pageHostname } from './serverHost';

/** Override with VITE_HTTP_URL when the backend's HTTP endpoints live at a different origin than the page - independent of VITE_WS_URL (OnlineScene.ts), since a real deployment could split them, though today both are served by the same Go process/port. */
function defaultHttpBase(): string {
  return `${isSecurePage() ? 'https:' : 'http:'}//${pageHostname()}:${SERVER_PORT}`;
}

/** Mirrors the backend's UserRole enum (internal/... User model) - sent as a lowercase string, not the Go side's raw int, so the wire value stays meaningful in devtools and stable if the enum's ordinals ever get reordered. */
export type UserRole = 'player' | 'vip' | 'moderator' | 'gamemaster' | 'admin';

export interface LoginResult {
  /** Opaque session token - pass it to the WS connect URL's `?token=` query param (see OnlineScene) so the server can authenticate the realtime connection without repeating the credential check there. */
  token: string;
  /** Optional because the backend may not send it yet (older/demo login) - treat a missing role as unknown, not as 'player'. */
  role?: UserRole;
}

interface ErrorBody {
  error?: string;
  banned?: boolean;
  bannedReason?: string;
  /** RFC3339 timestamp; absent/empty means a permanent ban. */
  bannedUntil?: string;
}

/** Thrown instead of a plain Error when the backend rejects login/register because the account is banned (HTTP 403 with `banned: true`) - lets the UI show the reason/expiry instead of a generic failure message. */
export class AccountBannedError extends Error {
  reason?: string;
  until?: string;

  constructor(message: string, reason?: string, until?: string) {
    super(message);
    this.name = 'AccountBannedError';
    this.reason = reason;
    this.until = until;
  }
}

/** Shared by login()/register() - both post {username, password} to a different path and expect the same {token, role}/{error} response shape (register auto-logs-in on success, same as login). */
async function postCredentials(path: string, username: string, password: string, failureVerb: string): Promise<LoginResult> {
  const httpBase = (import.meta.env.VITE_HTTP_URL as string | undefined) ?? defaultHttpBase();
  const res = await fetch(`${httpBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    if (body?.banned) {
      throw new AccountBannedError(body.error ?? 'Account banned', body.bannedReason, body.bannedUntil);
    }
    throw new Error(body?.error ?? `${failureVerb} failed (${res.status})`);
  }
  return res.json() as Promise<LoginResult>;
}

/**
 * Logs in over plain HTTP, not the WS/protobuf channel. Login is a
 * one-shot, potentially slow (password hashing) operation - keeping it off
 * the realtime WS session machinery entirely, rather than adding a
 * ClientPacket/ServerPacket pair for it, means it can never risk blocking
 * the world loop or an existing player's live connection. The backend is
 * expected to still accept any non-empty username/password for now (see
 * LoginScreen's own doc comment) - this makes that demo login real over
 * the network (an actual request, an actual issued token the server
 * tracks) instead of a client-only fake, so the auth-gated WS handshake
 * can be built and tested for real ahead of a real account system.
 */
export function login(username: string, password: string): Promise<LoginResult> {
  return postCredentials('/login', username, password, 'Login');
}

/**
 * Registers a new account, same transport/shape as login() (see its doc
 * comment) - returns a session token immediately (auto-login on
 * successful registration) rather than requiring a separate login step
 * right after. Not yet backed by a real persisted account system on the
 * backend as of writing - see RegisterScreen's own doc comment.
 */
export function register(username: string, password: string): Promise<LoginResult> {
  return postCredentials('/register', username, password, 'Registration');
}
