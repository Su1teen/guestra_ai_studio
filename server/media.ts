import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { Repository, record } from "./repository.js";
import { ApiError } from "./errors.js";
import type { Attachment, RecordBase } from "../shared/domain.js";
import type { ObjectStorage } from "./integrations.js";
import { permittedUrl } from "./integrations.js";
export interface Asset extends Attachment, RecordBase {
  storageKey: string;
  expiresAt: string;
  scanStatus: "clean" | "local_unscanned" | "quarantined";
  ownerId: string;
}
export class LocalStorage implements ObjectStorage {
  constructor(private directory: string) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key))
      throw new ApiError(400, "INVALID_KEY", "Неверный media key");
    const path = resolve(this.directory, key);
    if (
      !path.startsWith(resolve(this.directory) + "\\") &&
      !path.startsWith(resolve(this.directory) + "/")
    )
      throw new Error("Unsafe path");
    return path;
  }
  async put(key: string, bytes: Buffer) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(key), bytes, { flag: "wx", mode: 0o600 });
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key));
  }
}
export function detectMedia(b: Buffer, mime: string) {
  const ok =
    mime === "image/png"
      ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? b[0] === 255 && b[1] === 216
        : mime === "image/webp"
          ? b.toString("ascii", 0, 4) === "RIFF" &&
            b.toString("ascii", 8, 12) === "WEBP"
          : mime === "application/pdf"
            ? b.toString("ascii", 0, 5) === "%PDF-"
            : mime === "audio/wav"
              ? b.toString("ascii", 0, 4) === "RIFF" &&
                b.toString("ascii", 8, 12) === "WAVE"
              : mime === "audio/mpeg"
                ? b.toString("ascii", 0, 3) === "ID3" ||
                  (b[0] === 255 && (b[1] & 224) === 224)
                : mime === "audio/ogg"
                  ? b.toString("ascii", 0, 4) === "OggS"
                  : ["audio/webm", "video/webm"].includes(mime)
                    ? b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
                    : mime === "video/mp4"
                      ? b.toString("ascii", 4, 8) === "ftyp"
                      : mime === "text/plain"
                        ? b.length > 0 &&
                          !b.includes(0) &&
                          !b.toString().startsWith("MZ")
                        : mime ===
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                          ? b.toString("ascii", 0, 2) === "PK"
                          : false;
  if (!ok)
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA",
      "Формат или содержимое файла не поддерживается",
    );
  return mime.startsWith("image/")
    ? ("image" as const)
    : mime.startsWith("audio/")
      ? ("audio" as const)
      : mime.startsWith("video/")
        ? ("video" as const)
        : ("document" as const);
}
export class MediaService {
  storage: ObjectStorage;
  constructor(
    public cfg: Config,
    storage?: ObjectStorage,
  ) {
    this.storage = storage ?? new LocalStorage(cfg.mediaDir);
  }
  async upload(
    repo: Repository,
    ownerId: string,
    name: string,
    mime: string,
    bytes: Buffer,
  ) {
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
      throw new ApiError(
        413,
        "MEDIA_TOO_LARGE",
        "Файл должен быть меньше 20 МБ",
      );
    const kind = detectMedia(bytes, mime);
    let scanStatus: Asset["scanStatus"] = "local_unscanned";
    if (this.cfg.scannerUrl) {
      const response = await fetch(
        permittedUrl(this.cfg.scannerUrl, this.cfg),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.cfg.scannerToken,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        },
      );
      if (!response.ok || (await response.json()).clean !== true)
        throw new ApiError(422, "MEDIA_QUARANTINED", "Файл не прошёл проверку");
      scanStatus = "clean";
    }
    if (!this.cfg.local && scanStatus !== "clean")
      throw new ApiError(
        503,
        "SCANNER_REQUIRED",
        "Для подключённой среды требуется проверка файлов",
      );
    const asset = record({
      fileName:
        basename(name)
          .replace(/[\r\n\u0000-\u001f]/g, "")
          .slice(0, 160) || "attachment",
      mimeType: mime,
      size: bytes.length,
      kind,
      storageKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      scanStatus,
      ownerId,
    });
    await this.storage.put(asset.storageKey, bytes);
    try {
      await repo.put("media_assets", asset, { storage_key: asset.storageKey });
    } catch (e) {
      await this.storage.remove(asset.storageKey);
      throw e;
    }
    return asset;
  }
  sign(workspace: string, id: string, purpose: "view" | "workflow" = "view") {
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const signature = createHmac("sha256", this.cfg.signingSecret)
      .update(`${workspace}:${id}:${expiry}:${purpose}`)
      .digest("hex");
    return `/api/media/${id}/content?w=${encodeURIComponent(workspace)}&exp=${expiry}&purpose=${purpose}&sig=${signature}`;
  }
  verify(
    workspace: string,
    id: string,
    expiry: number,
    purpose: string,
    signature: string,
  ) {
    if (
      !["view", "workflow"].includes(purpose) ||
      expiry < Date.now() / 1000 ||
      expiry > Date.now() / 1000 + 301
    )
      throw new ApiError(403, "MEDIA_URL_EXPIRED", "Ссылка истекла");
    const expected = createHmac("sha256", this.cfg.signingSecret)
      .update(`${workspace}:${id}:${expiry}:${purpose}`)
      .digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ApiError(403, "INVALID_SIGNATURE", "Неверная ссылка");
  }
  async authorized(repo: Repository, id: string) {
    const asset = await repo.get<Asset>("media_assets", id);
    if (!asset) throw new ApiError(404, "MEDIA_NOT_FOUND", "Файл не найден");
    if (
      Date.parse(asset.expiresAt) < Date.now() ||
      asset.scanStatus === "quarantined"
    )
      throw new ApiError(410, "MEDIA_EXPIRED", "Файл недоступен");
    return asset;
  }
}
