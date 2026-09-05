/** The game server's port - one Go process serves both the WS upgrade endpoint and plain HTTP endpoints like /login on this same port (see cmd/game-server/main.go). */
export const SERVER_PORT = 8080;

/**
 * The hostname the page itself was loaded from - never hardcode
 * "localhost" for reaching the backend. "localhost" only ever means "this
 * device": fine when testing on the same laptop running both the dev
 * server and the backend, but broken on a phone reached via `vite --host`
 * over LAN (or any other device), where it resolves to that device itself
 * instead of the backend host, and the connection fails instantly.
 */
export function pageHostname(): string {
  return window.location.hostname;
}

/** Whether the page itself was loaded over HTTPS - if so, both the WS (wss:) and HTTP (https:) connections to the backend need the secure variant too, or the browser blocks them as mixed content. */
export function isSecurePage(): boolean {
  return window.location.protocol === 'https:';
}
