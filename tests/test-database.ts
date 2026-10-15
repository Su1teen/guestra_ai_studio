import { database } from "../server/db";
export function testDatabase() {
  const value = process.env.TEST_DATABASE_URL;
  if (value) {
    const url = new URL(value);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/(studio_test|[a-z0-9_]+_integration_test)$/.test(url.pathname)
    )
      throw new Error(
        "TEST_DATABASE_URL must target isolated loopback test PostgreSQL",
      );
  }
  return database(value, "memory://");
}
