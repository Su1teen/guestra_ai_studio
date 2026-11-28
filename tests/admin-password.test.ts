import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { database, migrate } from "../server/db";
import { seed } from "../server/seed";
import { passwordMatches } from "../server/auth";

it("rotates the stored administrator hash when ADMIN_PASSWORD changes", async () => {
  const db = await database(undefined, resolve(".local", "persistence-tests", randomUUID()));
  const saved = { e: process.env.ADMIN_EMAIL, p: process.env.ADMIN_PASSWORD };
  try {
    await migrate(db);
    process.env.ADMIN_EMAIL = "Admin@Example.test";
    process.env.ADMIN_PASSWORD = "first-test-password";
    await seed(db, false);
    const hashOf = async () =>
      (await db.query<{ password_hash: string }>("SELECT password_hash FROM studio_users WHERE email='admin@example.test'"))[0].password_hash;
    const first = await hashOf();
    await seed(db, false);
    expect(await hashOf()).toBe(first);
    process.env.ADMIN_PASSWORD = "second-test-password";
    await seed(db, false);
    const next = await hashOf();
    expect(passwordMatches("second-test-password", next)).toBe(true);
    expect(passwordMatches("first-test-password", next)).toBe(false);
  } finally {
    process.env.ADMIN_EMAIL = saved.e;
    process.env.ADMIN_PASSWORD = saved.p;
    if (saved.e === undefined) delete process.env.ADMIN_EMAIL;
    if (saved.p === undefined) delete process.env.ADMIN_PASSWORD;
    await db.close();
  }
});
