import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploy, identityFromEnv, attestIntegration, loadMigrationPolicy } from './deploy-engine.mjs';
if (process.env.GUESTRA_DEPLOY_AUTOMATION_ENABLED !== 'true') {
  console.log('Deployment automation disabled; apply the reviewed Railway bootstrap configuration to enable it.');
} else {
  const identity = identityFromEnv('guestra_ai_studio');
  const category = await loadMigrationPolicy();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const query = async (text, args = []) => (await client.query(text, args)).rows ?? [];
  try {
    const [ledger] = await query("SELECT to_regclass('public.schema_migrations') AS name");
    const installed = ledger.name ? await query('SELECT version FROM schema_migrations') : [];
    const migrations = (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort().map(file => ({
      name: 'core/' + file, file: resolve('migrations', file), installed: installed.some(row => row.version === file), category: category('core/' + file),
      record: async query => { await query('INSERT INTO schema_migrations(version) VALUES($1)', [file]); },
    }));
    if(installed.some(row=>!migrations.some(m=>m.name==='core/'+row.version)))throw new Error('MIGRATION_SOURCE_MISSING');
    await deploy(query, { identity, migrations, foreignTables: ['guests', 'leads', 'reservations', 'folios', 'payments', 'workflow_entity'],
      attestationTable: 'studio_database_attestation',
      requiredTables: ['workspaces', 'studio_users'], baselineApproved: process.env.GUESTRA_MIGRATION_BASELINE_APPROVED === 'true',
      afterMigrations: async query => {
        await query("SELECT r.id FROM agent_runs r JOIN message_attempts a ON a.workspace_id=r.workspace_id AND a.data->>'runId'=r.id JOIN conversation_refs c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id LIMIT 0");
        await attestIntegration(query, 'studio_database_attestation', identity);
      } });
    console.log('STUDIO_READY');
  } catch (error) {
    console.error('Pre-deploy refused:', /^[A-Z_]+(?::[a-zA-Z0-9_./-]+)?$/.test(error.message) ? error.message : 'DATABASE_PREFLIGHT_FAILED', error.code ?? '');
    process.exitCode = 1;
  } finally { await client.end(); }
}
