import { ClientPacket, ServerPacket } from './generated/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** How often a PingRequest is sent while connected, in ms. */
const PING_INTERVAL_MS = 3000;

/**
 * Thin WebSocket + protobuf wrapper around the game server's ClientPacket/
 * ServerPacket protocol (see proto/protocol.proto - mirrored from the
 * backend repo, not authored here). Deliberately does nothing beyond
 * transport: encode/send a ClientPacket, decode incoming ServerPackets and
 * hand them to a callback. No reconnect, no entity store, no AOI handling -
 * those land once this transport is proven against the real server.
 *
 * The one exception is ping/pong: it's pure transport-latency bookkeeping
 * (nothing gameplay-related depends on it), so it's measured and reported
 * here via onPingChange rather than being surfaced through onPacket like
 * every other server message.
 */
export class WorldConnection {
  onPacket: ((payload: ServerPacket['payload']) => void) | null = null;
  onStatusChange: ((status: ConnectionStatus) => void) | null = null;
  /** Latest round-trip time in ms, or null while disconnected/not yet measured. */
  onPingChange: ((pingMs: number | null) => void) | null = null;

  private ws: WebSocket | null = null;
  private nextSequence = 1;
  private pingIntervalId: number | undefined;

  connect(url: string): void {
    this.close();

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.onStatusChange?.('connecting');

    ws.addEventListener('open', () => {
      this.onStatusChange?.('open');
      this.startPinging();
    });
    ws.addEventListener('close', () => {
      this.onStatusChange?.('closed');
      this.stopPinging();
    });
    ws.addEventListener('error', (event) => console.error('[WorldConnection] error', event));
    ws.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const packet = ServerPacket.decode(new Uint8Array(event.data));
      if (packet.payload?.$case === 'pong') {
        this.onPingChange?.(performance.now() - packet.payload.pong.clientTime);
        return;
      }
      this.onPacket?.(packet.payload);
    });
  }

  /**
   * Sends a MovementInput; the sequence number is assigned internally and
   * increments per call. `facing` is the character's actual orientation
   * (see compassRotation.ts's facingToRotation) - not necessarily the same
   * compass direction as dirX/dirZ, since moving backward or strafing keeps
   * the character facing whichever way it already was rather than turning
   * to face the movement itself.
   */
  sendMovement(dirX: number, dirZ: number, running: boolean, facing: number): void {
    this.send({ payload: { $case: 'movement', movement: { sequence: this.nextSequence++, dirX, dirZ, running, facing } } });
  }

  sendChatAll(message: string): void {
    this.send({ payload: { $case: 'chatAll', chatAll: { message } } });
  }

  sendWhisper(targetPlayerId: number, message: string): void {
    this.send({ payload: { $case: 'whisper', whisper: { targetPlayerId, message } } });
  }

  close(): void {
    this.stopPinging();
    this.ws?.close();
    this.ws = null;
  }

  private startPinging(): void {
    this.sendPing();
    this.pingIntervalId = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingIntervalId !== undefined) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = undefined;
    }
    this.onPingChange?.(null);
  }

  private sendPing(): void {
    this.send({ payload: { $case: 'ping', ping: { clientTime: Math.round(performance.now()) } } });
  }

  private send(packet: ClientPacket): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(ClientPacket.encode(packet).finish());
  }
}
