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
  findAvailable(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode | undefined>;
  markStaleStorageOffline(
    heartbeatTimeoutMs: number,
  ): Promise<RegisteredStorageNode[]>;
}

const LOAD_SCORE_EPSILON = 0.000_001;

export class StorageRegistry implements StorageRegistryStore {
  private readonly nodes = new Map<string, RegisteredStorageNode>();
  private selectionCursor = 0;

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
    const available = (await this.list())
      .filter((node) => isAvailableStorageNode(node, now, heartbeatTimeoutMs))
      .sort(compareStorageNodesByLoad);

    if (available.length === 0) {
      return undefined;
    }

    const bestLoadScore = calculateStorageLoadScore(available[0]);
    const bestCandidates = available.filter(
      (node) =>
        Math.abs(calculateStorageLoadScore(node) - bestLoadScore) <=
        LOAD_SCORE_EPSILON,
    );
    const selected =
      bestCandidates[this.selectionCursor % bestCandidates.length];

    this.selectionCursor =
      (this.selectionCursor + 1) % Number.MAX_SAFE_INTEGER;

    return selected;
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

function isAvailableStorageNode(
  node: RegisteredStorageNode,
  now: number,
  heartbeatTimeoutMs: number,
): boolean {
  const lastHeartbeatAt = new Date(node.lastHeartbeatAt).getTime();
  const isFresh =
    Number.isFinite(lastHeartbeatAt) &&
    now - lastHeartbeatAt <= heartbeatTimeoutMs;
  const hasSpace =
    node.capacityBytes === undefined ||
    node.usedBytes === undefined ||
    node.usedBytes < node.capacityBytes;

  return isFresh && node.status !== "offline" && hasSpace;
}

function compareStorageNodesByLoad(
  left: RegisteredStorageNode,
  right: RegisteredStorageNode,
): number {
  const loadDelta =
    calculateStorageLoadScore(left) - calculateStorageLoadScore(right);

  if (Math.abs(loadDelta) > LOAD_SCORE_EPSILON) {
    return loadDelta;
  }

  return left.storageId.localeCompare(right.storageId);
}

function calculateStorageLoadScore(node: RegisteredStorageNode): number {
  if (
    node.capacityBytes !== undefined &&
    node.capacityBytes > 0 &&
    node.usedBytes !== undefined
  ) {
    return node.usedBytes / node.capacityBytes;
  }

  if (node.usedBytes !== undefined) {
    return node.usedBytes / Number.MAX_SAFE_INTEGER;
  }

  return 0;
}
