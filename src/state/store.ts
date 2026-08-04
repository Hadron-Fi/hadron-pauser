import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PauserSnapshot, isValidSnapshot } from "./snapshot.js";

/**
 * Snapshot persistence backends, selected via env (deployment concern, not
 * config.json): STATE_S3_BUCKET [+ STATE_S3_KEY] for ECS (Fargate disks are
 * ephemeral; the terraform module provisions the bucket + task role), or
 * STATE_PATH for docker/Railway volumes. Neither set => persistence off,
 * which is safe: a fresh start only re-arms the drawdown window.
 * All failures are soft — load returns null, save throws to the caller's
 * catch — the watchdog never dies over its own memory.
 */

export interface SnapshotStore {
  describe(): string;
  load(): Promise<PauserSnapshot | null>;
  save(snap: PauserSnapshot): Promise<void>;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly path: string) {}

  describe(): string {
    return `file:${this.path}`;
  }

  async load(): Promise<PauserSnapshot | null> {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return isValidSnapshot(raw) ? raw : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.warn(`[state] unreadable snapshot at ${this.path}, starting fresh:`, (err as Error).message);
      return null;
    }
  }

  async save(snap: PauserSnapshot): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.path); // atomic on the same filesystem
  }
}

export class S3SnapshotStore implements SnapshotStore {
  private clientPromise: Promise<any> | null = null;

  constructor(
    private readonly bucket: string,
    private readonly key: string,
  ) {}

  describe(): string {
    return `s3://${this.bucket}/${this.key}`;
  }

  /** Lazy import so non-AWS deployments never load the SDK. */
  private client(): Promise<any> {
    this.clientPromise ??= import("@aws-sdk/client-s3").then(
      (m) => new m.S3Client({}),
    );
    return this.clientPromise;
  }

  async load(): Promise<PauserSnapshot | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const res = await (await this.client()).send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      const body = await res.Body.transformToString();
      const raw = JSON.parse(body);
      return isValidSnapshot(raw) ? raw : null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
  }

  async save(snap: PauserSnapshot): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(snap),
        ContentType: "application/json",
      }),
    );
  }
}

export function storeFromEnv(env = process.env): SnapshotStore | null {
  if (env.STATE_S3_BUCKET) {
    return new S3SnapshotStore(env.STATE_S3_BUCKET, env.STATE_S3_KEY ?? "hadron-pauser.json");
  }
  if (env.STATE_PATH) return new FileSnapshotStore(env.STATE_PATH);
  return null;
}
