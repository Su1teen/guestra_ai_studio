import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const digest = value => createHash('sha256').update(value).digest('hex');
export async function loadMigrationPolicy() {
  const policy=JSON.parse(await readFile(new URL('./migration-policy.json',import.meta.url),'utf8'));
  const categories=new Map();
  for(const category of ['safe','integration','manual']) {
    if(!Array.isArray(policy[category]))throw new Error('INVALID_MIGRATION_POLICY');
    for(const name of policy[category]) {
      if(typeof name!=='string'||categories.has(name))throw new Error('INVALID_MIGRATION_POLICY');
      categories.set(name,category);
    }
  }
  // New files require an explicit reviewed classification in the same release.
  return name=>categories.get(name)??'manual';
}
export function identityFromEnv(system, env = process.env) {
  const environment = env.INTEGRATION_ENVIRONMENT ?? env.STUDIO_ENVIRONMENT ?? 'production';
  const owner = env.GUESTRA_DATABASE_OWNER ?? env.STUDIO_DATABASE_OWNER;
  const deployment = env.GUESTRA_DATABASE_DEPLOYMENT_ID ?? env.STUDIO_DATABASE_DEPLOYMENT_ID;
  if (owner !== system || !['test', 'sandbox', 'production'].includes(environment)
    || !deployment || !/^[a-zA-Z0-9_.:-]{8,160}$/.test(deployment)) throw new Error('DATABASE_IDENTITY_REQUIRED');
  return { system, environment, deployment };
}

/** One dedicated connection, a session lock, and one transaction per migration. */
export async function deploy(query, { identity, migrations, foreignTables, requiredTables,
  baselineApproved = false, integrationApproved = false, attestationTable, afterMigrations = async () => {} }) {
  const lock = 'guestra:deployment:' + identity.system;
  await query("SET lock_timeout='60s'");
  await query("SET statement_timeout='5min'");
  await query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
  try {
    const [owner] = await query("SELECT pg_has_role(current_user,datdba,'USAGE') AS owns_database FROM pg_database WHERE datname=current_database()");
    if (!owner?.owns_database) throw new Error('DATABASE_OWNER_ROLE_REQUIRED');
    const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const names = new Set(tables.map(t => t.table_name));
    if (foreignTables.some(t => names.has(t)) || requiredTables.some(t => !names.has(t)))
      throw new Error('DATABASE_OWNERSHIP_MISMATCH');
    if (attestationTable) {
      if (!['guestra_integration_deployment','studio_database_attestation'].includes(attestationTable)) throw new Error('INVALID_ATTESTATION_TABLE');
      if (names.has(attestationTable)) {
        const [previous] = await query(`SELECT environment,deployment_id FROM ${attestationTable} WHERE id=true`);
        if (previous && (previous.environment !== identity.environment || previous.deployment_id !== identity.deployment)) {
          // Stable IDs are safe operator metadata. Never create a new canonical marker on a conflicting database.
          console.error(JSON.stringify({code:'DATABASE_IDENTITY_CONFLICT',existingEnvironment:previous.environment,existingDeploymentId:previous.deployment_id}));
          throw new Error('DATABASE_IDENTITY_CONFLICT');
        }
      }
    }
    if (names.has('guestra_deployment_identity')) {
      const rows = await query('SELECT system,environment,deployment_id FROM guestra_deployment_identity');
      if (rows.length !== 1 || rows[0].system !== identity.system || rows[0].environment !== identity.environment
        || rows[0].deployment_id !== identity.deployment) throw new Error('DATABASE_IDENTITY_CONFLICT');
    }
    await query('BEGIN');
    try {
      await query("CREATE TABLE IF NOT EXISTS guestra_deployment_identity (id boolean PRIMARY KEY DEFAULT true CHECK(id),system text NOT NULL,environment text NOT NULL,deployment_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
      await query('INSERT INTO guestra_deployment_identity(id,system,environment,deployment_id) VALUES(true,$1,$2,$3) ON CONFLICT(id) DO NOTHING', [identity.system, identity.environment, identity.deployment]);
      await query("CREATE TABLE IF NOT EXISTS guestra_deploy_migrations (name text PRIMARY KEY,digest text NOT NULL,category text NOT NULL,baseline boolean NOT NULL DEFAULT false,applied_at timestamptz NOT NULL DEFAULT now())");
      await query('COMMIT');
    } catch (error) { await query('ROLLBACK'); throw error; }
    const ledger = await query('SELECT name,digest FROM guestra_deploy_migrations');
    const known = new Map(ledger.map(row => [row.name, row.digest]));
    const sources = [];
    const unique = new Set();
    // Verify every file before running any pending schema changes.
    for (const migration of migrations) {
      if (unique.has(migration.name)) throw new Error('DUPLICATE_MIGRATION_VERSION');
      unique.add(migration.name);
      const body = await readFile(migration.file, 'utf8');
      const checksum = digest(body);
      if (known.has(migration.name) && known.get(migration.name) !== checksum) throw new Error('MIGRATION_CHECKSUM_DRIFT:' + migration.name);
      if (migration.legacyDigest && migration.legacyDigest !== checksum) throw new Error('LEGACY_MIGRATION_CHECKSUM_DRIFT:' + migration.name);
      if (!known.has(migration.name) && migration.installed && !migration.legacyDigest && !baselineApproved)
        throw new Error('MIGRATION_BASELINE_APPROVAL_REQUIRED:' + migration.name);
      if (!known.has(migration.name) && !migration.installed && migration.category === 'manual')
        throw new Error('MANUAL_MIGRATION_REQUIRED:' + migration.name);
      sources.push({ ...migration, body, checksum });
    }
    for (const name of known.keys()) if (!unique.has(name)) throw new Error('MIGRATION_SOURCE_MISSING:' + name);
    for (const migration of sources) {
      if (known.has(migration.name)) continue;
      if (!migration.installed && migration.category === 'integration' && !integrationApproved) continue;
      await query('BEGIN');
      try {
        if (!migration.installed) {
          await query(migration.body);
          if (migration.record) await migration.record(query, migration.checksum);
        }
        await query('INSERT INTO guestra_deploy_migrations(name,digest,category,baseline) VALUES($1,$2,$3,$4)',
          [migration.name, migration.checksum, migration.category, Boolean(migration.installed)]);
        await query('COMMIT');
      } catch (error) { await query('ROLLBACK'); throw error; }
      console.log(JSON.stringify({ event: migration.installed ? 'migration_baselined' : 'migration_applied', name: migration.name }));
    }
    await afterMigrations(query);
    return { status: 'DATABASE_READY', integrationApproved };
  } finally { await query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
}

export async function attestIntegration(query, table, identity) {
  if (!['guestra_integration_deployment', 'studio_database_attestation'].includes(table)) throw new Error('INVALID_ATTESTATION_TABLE');
  const [row] = await query(`SELECT environment,deployment_id FROM ${table} WHERE id=true`);
  if (row && (row.environment !== identity.environment || row.deployment_id !== identity.deployment)) throw new Error('INTEGRATION_ATTESTATION_CONFLICT');
  if (!row) {
    if (table === 'studio_database_attestation') {
      await query(`INSERT INTO ${table}(id,system,environment,deployment_id) VALUES(true,$1,$2,$3)`, [identity.system, identity.environment, identity.deployment]);
    } else await query(`INSERT INTO ${table}(id,environment,deployment_id) VALUES(true,$1,$2)`, [identity.environment, identity.deployment]);
  }
}
