import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deploy, identityFromEnv } from './deploy-engine.mjs';
const url = process.env.DEPLOY_TEST_DATABASE_URL;
const identity = {system:'guestra_test',environment:'test',deployment:'isolated-deployment-v1'};
async function connect(connectionString) {
  const require = createRequire(import.meta.url);
  try {
    const pg = require('pg'), client = new pg.Client({connectionString}); await client.connect();
    return {query:async(s,a=[]) => (await client.query(s,a)).rows ?? [], close:()=>client.end()};
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const postgres = createRequire(new URL('../../packages/database/package.json', import.meta.url))('postgres');
    const sql = postgres(connectionString,{max:1,onnotice:()=>{}});
    return {query:(s,a=[])=>sql.unsafe(s,a),close:()=>sql.end()};
  }
}
test('ownership requires explicit stable identity and a recognized environment', () => {
  assert.throws(()=>identityFromEnv('guestra_pms',{}),/IDENTITY/);
  assert.throws(()=>identityFromEnv('guestra_pms',{GUESTRA_DATABASE_OWNER:'guestra_crm',GUESTRA_DATABASE_DEPLOYMENT_ID:'permanent-v1'}),/IDENTITY/);
  assert.deepEqual(identityFromEnv('guestra_pms',{GUESTRA_DATABASE_OWNER:'guestra_pms',GUESTRA_DATABASE_DEPLOYMENT_ID:'permanent-v1'}),{system:'guestra_pms',environment:'production',deployment:'permanent-v1'});
});
test('populated PostgreSQL: opt-in triggers, concurrent deploy, drift, rollback and ownership', {skip:!url}, async () => {
  const target = new URL(url);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname) && /(?:_integration_test|\/haip_test|\/studio_test)$/.test(target.pathname),'isolated loopback test database required');
  const admin = await connect(new URL('/postgres',target).href);
  const name = 'guestra_deploy_' + randomBytes(8).toString('hex');
  await admin.query(`CREATE DATABASE "${name}"`);
  const db = await connect(new URL('/'+name,target).href), second = await connect(new URL('/'+name,target).href);
  const dir = await mkdtemp(join(tmpdir(),'guestra-deploy-'));
  try {
    await db.query("CREATE TABLE retained_business_rows(id integer PRIMARY KEY, amount integer NOT NULL); INSERT INTO retained_business_rows VALUES(1,900),(2,400)");
    const a=join(dir,'0001.sql'),b=join(dir,'0002.sql'),c=join(dir,'0003.sql');
    await writeFile(a,'ALTER TABLE retained_business_rows ADD COLUMN note text;');
    await writeFile(b,"CREATE TABLE event_receipts(id integer); CREATE FUNCTION capture_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO event_receipts VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER capture_test AFTER INSERT ON retained_business_rows FOR EACH ROW EXECUTE FUNCTION capture_test();");
    const options={identity,foreignTables:['foreign_business'],requiredTables:['retained_business_rows'],migrations:[
      {name:'0001.sql',file:a,category:'safe'},{name:'0002.sql',file:b,category:'integration'}]};
    await Promise.all([deploy(db.query,options),deploy(second.query,options)]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM retained_business_rows"))[0].n,2);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='capture_test'"))[0].n,0);
    await deploy(db.query,{...options,integrationApproved:true});
    await db.query('INSERT INTO retained_business_rows(id,amount) VALUES(3,100)');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM event_receipts'))[0].n,1);
    await deploy(db.query,options);
    assert.equal((await db.query('SELECT sum(amount)::int AS n FROM retained_business_rows'))[0].n,1400);
    await writeFile(a,'ALTER TABLE retained_business_rows ADD COLUMN changed text;');
    await assert.rejects(deploy(db.query,options),/CHECKSUM_DRIFT/);
    await writeFile(a,'ALTER TABLE retained_business_rows ADD COLUMN note text;');
    await writeFile(c,'CREATE TABLE rollback_probe(id integer); SELECT * FROM deliberately_missing_table;');
    await assert.rejects(deploy(db.query,{...options,migrations:[...options.migrations,{name:'0003.sql',file:c,category:'safe'}]}));
    assert.equal((await db.query("SELECT to_regclass('public.rollback_probe') AS name"))[0].name,null);
    await assert.rejects(deploy(db.query,{...options,identity:{...identity,deployment:'different-deployment-v2'}}),/IDENTITY_CONFLICT/);
    await db.query('CREATE TABLE foreign_business(id integer)');
    await assert.rejects(deploy(db.query,options),/OWNERSHIP_MISMATCH/);
  } finally {
    await db.close(); await second.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.close(); await rm(dir,{recursive:true,force:true});
  }
});
