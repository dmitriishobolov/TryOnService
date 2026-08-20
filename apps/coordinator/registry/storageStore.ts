import type {
  RegisteredStorageNode,
  StorageHeartbeatRequest,
  StorageRegistrationRequest,
} from "../../shared/contracts/index.js";

export interface StorageRegistryStore {
  register(
    request: StorageRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredStorageNode>;
  heartbeat(
    request: StorageHeartbeatRequest,
  ): Promise<RegisteredStorageNode | undefined>;
  markOffline(storageId: string): Promise<RegisteredStorageNode | undefined>;
  list(): Promise<RegisteredStorageNode[]>;
  get(storageId: string): Promise<RegisteredStorageNode | undefined>;
  findAvailable(heartbeatTimeoutMs: number): Promise<RegisteredStorageNode | undefined>;
  markStaleStorageOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode[]>;
}

export class StorageRegistry implements StorageRegistryStore {
  private readonly nodes = new Map<string, RegisteredStorageNode>();

  async register(
    request: StorageRegistrationRequest,
    resolvedBaseUrl: string,
  ): Promise<RegisteredStorageNode> {
    const now = new Date().toISOString();
    const previous = this.nodes.get(request.storageId);
    const node: RegisteredStorageNode = {
      storageId: request.storageId,
      baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
      driver: request.driver,
      status: "ready",
      usedBytes: previous?.usedBytes,
      capacityBytes: request.capacityBytes,
      registeredAt: previous?.registeredAt ?? now,
      lastHeartbeatAt: now,
    };

    this.nodes.set(node.storageId, node);

    return node;
  }

  async heartbeat(
    request: StorageHeartbeatRequest,
  ): Promise<RegisteredStorageNode | undefined> {
    const node = this.nodes.get(request.storageId);

    if (!node) {
      return undefined;
    }

    const updated: RegisteredStorageNode = {
      ...node,
      status: request.status,
      usedBytes: request.usedBytes ?? node.usedBytes,
      capacityBytes: request.capacityBytes ?? node.capacityBytes,
      lastHeartbeatAt: new Date().toISOString(),
    };

    this.nodes.set(updated.storageId, updated);

    return updated;
  }

  async markOffline(storageId: string): Promise<RegisteredStorageNode | undefined> {
    const node = this.nodes.get(storageId);

    if (!node) {
      return undefined;
    }

    const updated: RegisteredStorageNode = {
      ...node,
      status: "offline",
    };

    this.nodes.set(storageId, updated);

    return updated;
  }

  async list(): Promise<RegisteredStorageNode[]> {
    return [...this.nodes.values()];
  }

  async get(storageId: string): Promise<RegisteredStorageNode | undefined> {
    return this.nodes.get(storageId);
  }

  async findAvailable(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode | undefined> {
    const now = Date.now();

    return (await this.list()).find((node) => {
      const lastHeartbeatAt = new Date(node.lastHeartbeatAt).getTime();
      const isFresh = now - lastHeartbeatAt <= heartbeatTimeoutMs;
      const hasSpace =
        node.capacityBytes === undefined ||
        node.usedBytes === undefined ||
        node.usedBytes < node.capacityBytes;

      return isFresh && node.status !== "offline" && hasSpace;
    });
  }

  async markStaleStorageOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode[]> {
    const now = Date.now();
    const changed: RegisteredStorageNode[] = [];

    for (const node of this.nodes.values()) {
      const lastHeartbeatAt = new Date(node.lastHeartbeatAt).getTime();

      if (
        node.status !== "offline" &&
        now - lastHeartbeatAt > heartbeatTimeoutMs
      ) {
        const offline = await this.markOffline(node.storageId);

        if (offline) {
          changed.push(offline);
        }
      }
    }

    return changed;
  }
}
