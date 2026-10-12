import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Database } from "./db.js";
import type { Role } from "../shared/domain.js";
import { ApiError } from "./errors.js";
export interface Principal {
  userId: string;
  workspaceId: string;
  name: string;
  role: Role;
}
declare global {
  namespace Express {
    interface Request {
      principal: Principal;
    }
  }
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function passwordMatches(password: string, hash: string) {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const value = scryptSync(password, salt, 64);
  const stored = Buffer.from(key, "hex");
  return value.length === stored.length && timingSafeEqual(value, stored);
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function session(
  db: Database,
  res: Response,
  userId: string,
  workspaceId: string,
) {
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO auth_sessions(token_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
    [hash(token), userId, workspaceId],
  );
  res.cookie("studio_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 3600 * 1000,
    path: "/",
  });
}
export function authenticate(db: Database) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.headers.cookie
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("studio_session="))
        ?.split("=")[1];
      if (!token) throw new ApiError(401, "UNAUTHORIZED", "Войдите в Studio");
      const row = (
        await db.query<{
          user_id: string;
          workspace_id: string;
          name: string;
          role: Role;
        }>(
          "SELECT s.user_id,s.workspace_id,u.name,m.role FROM auth_sessions s JOIN studio_users u ON u.id=s.user_id JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id WHERE s.token_hash=$1 AND s.expires_at>now()",
          [hash(token)],
        )
      )[0];
      if (!row) throw new ApiError(401, "UNAUTHORIZED", "Сессия истекла");
      req.principal = {
        userId: row.user_id,
        workspaceId: row.workspace_id,
        name: row.name,
        role: row.role,
      };
      next();
    } catch (e) {
      next(e);
    }
  };
}
export function roles(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!allowed.includes(req.principal.role))
      return next(new ApiError(403, "FORBIDDEN", "Недостаточно прав"));
    next();
  };
}
