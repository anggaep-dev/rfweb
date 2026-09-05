import { AccountBannedError } from './AuthClient';

/** Turns a banned-account rejection into one human-readable line for LoginScreen/RegisterScreen's error display. */
export function formatBannedError(err: AccountBannedError): string {
  const until = err.until ? ` until ${new Date(err.until).toLocaleString()}` : ' permanently';
  const reason = err.reason ? `: ${err.reason}` : '.';
  return `Account banned${until}${reason}`;
}
