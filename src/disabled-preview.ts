export class RegionDurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async alarm(): Promise<void> {
    // The preview is intentionally parked. Clear any legacy recurring alarm
    // from earlier preview versions and do not schedule another one.
    await this.ctx.storage.deleteAlarm();
  }

  async fetch(): Promise<Response> {
    // If anything reaches the Durable Object, make sure a stale alarm cannot
    // restart the simulation.
    await this.ctx.storage.deleteAlarm();
    return new Response(JSON.stringify({ disabled: true, service: "moyo-garden-pbr-preview" }), {
      status: 410,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  webSocketMessage(socket: WebSocket): void {
    try {
      socket.close(1012, "preview disabled");
    } catch {
      // Already closed.
    }
  }

  webSocketClose(): void {}
  webSocketError(): void {}
}

export default {
  async fetch(): Promise<Response> {
    return new Response("MoYoGarden preview worker is disabled.\n", {
      status: 410,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
