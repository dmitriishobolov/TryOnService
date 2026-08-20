import type {
  ClientHeartbeatRequest,
  ClientRegistrationRequest,
  RegisteredClient,
} from "../../shared/contracts/index.js";

export interface ClientRegistryStore {
  register(
    request: ClientRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredClient>;
  heartbeat(request: ClientHeartbeatRequest): Promise<RegisteredClient | undefined>;
  get(clientId: string): Promise<RegisteredClient | undefined>;
  list(): Promise<RegisteredClient[]>;
  markOffline(clientId: string): Promise<RegisteredClient | undefined>;
  markStaleClientsOffline(heartbeatTimeoutMs: number): Promise<RegisteredClient[]>;
}

export class ClientRegistry implements ClientRegistryStore {
  private readonly clients = new Map<string, RegisteredClient>();

  async register(
    request: ClientRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredClient> {
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

  async heartbeat(
    request: ClientHeartbeatRequest,
  ): Promise<RegisteredClient | undefined> {
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

  async get(clientId: string): Promise<RegisteredClient | undefined> {
    return this.clients.get(clientId);
  }

  async list(): Promise<RegisteredClient[]> {
    return [...this.clients.values()];
  }

  async markOffline(clientId: string): Promise<RegisteredClient | undefined> {
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

  async markStaleClientsOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredClient[]> {
    const now = Date.now();
    const changed: RegisteredClient[] = [];

    for (const client of this.clients.values()) {
      const lastHeartbeatAt = new Date(client.lastHeartbeatAt).getTime();

      if (
        client.status !== "offline" &&
        now - lastHeartbeatAt > heartbeatTimeoutMs
      ) {
        const offline = await this.markOffline(client.clientId);

        if (offline) {
          changed.push(offline);
        }
      }
    }

    return changed;
  }
}
