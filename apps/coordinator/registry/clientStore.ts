import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  RegisteredClient,
} from "../../shared/contracts/index.js";

export class ClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();

  register(
    request: ClientRegistrationRequest,
    resolvedBaseUrl: string,
  ): RegisteredClient {
    const now = new Date().toISOString();
    const previous = this.clients.get(request.clientId);
    const baseUrl = resolvedBaseUrl.replace(/\/$/, "");
    const client: RegisteredClient = {
      clientId: request.clientId,
      type: request.type,
      baseUrl,
      callbackUrl: `${baseUrl}${request.callbackPath}`,
      status: "ready",
      registeredAt: previous?.registeredAt ?? now,
      lastHeartbeatAt: now,
    };

    this.clients.set(client.clientId, client);

    return client;
  }

  heartbeat(request: ClientHeartbeatRequest): RegisteredClient | undefined {
    const client = this.clients.get(request.clientId);

    if (!client) {
      return undefined;
    }

    const updated: RegisteredClient = {
      ...client,
      status: request.status,
      lastHeartbeatAt: new Date().toISOString(),
    };

    this.clients.set(updated.clientId, updated);

    return updated;
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  list(): RegisteredClient[] {
    return [...this.clients.values()];
  }

  markOffline(clientId: string): RegisteredClient | undefined {
    const client = this.clients.get(clientId);

    if (!client) {
      return undefined;
    }

    const updated: RegisteredClient = {
      ...client,
      status: "offline",
    };

    this.clients.set(clientId, updated);

    return updated;
  }

  markStaleClientsOffline(heartbeatTimeoutMs: number): RegisteredClient[] {
    const now = Date.now();
    const changed: RegisteredClient[] = [];

    for (const client of this.clients.values()) {
      const lastHeartbeatAt = new Date(client.lastHeartbeatAt).getTime();

      if (
        client.status !== "offline" &&
        now - lastHeartbeatAt > heartbeatTimeoutMs
      ) {
        const offline = this.markOffline(client.clientId);

        if (offline) {
          changed.push(offline);
        }
      }
    }

    return changed;
  }
}
