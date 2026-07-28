import type { ServerResponse } from "node:http";

export type BurnerEvent = { type: string; data: unknown; at: string };

export class EventHub {
  private clients = new Set<ServerResponse>();

  add(response: ServerResponse): () => void {
    this.clients.add(response);
    response.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    return () => this.clients.delete(response);
  }

  emit(type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify({ type, data, at: new Date().toISOString() })}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  heartbeat(): void {
    for (const client of this.clients) client.write(": heartbeat\n\n");
  }
}
