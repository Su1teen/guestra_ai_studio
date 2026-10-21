import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, envText } from './generate-config.mjs';
const input=()=>({environment:'production',propertyMappingConfirmed:true,
  mapping:{crmPropertyId:'crm-real-property',crmTenantId:'crm-real-tenant',pmsPropertyId:'a0000001-0000-4000-a000-000000000001',pmsTenantId:'pms-real-tenant'},
  urls:{crm:'https://crm.test.invalid',pms:'https://pms.test.invalid',studio:'https://studio.test.invalid'},
  databaseDeploymentIds:{crm:'crm-stable-v1',pms:'pms-stable-v1',studio:'studio-stable-v1'},
  existing:{crm:{DATABASE_URL:'postgresql://keep-crm',AGENT_OUTBOUND_WEBHOOK_TOKEN:'legacy-token'},pms:{DATABASE_URL:'postgresql://keep-pms',REDIS_URL:'redis://keep-redis',AUTH_ENABLED:'false'},studio:{DATABASE_URL:'postgresql://keep-studio',N8N_WORKSPACE_IDS:'existing-workspace',STUDIO_DATABASE_DEPLOYMENT_ID:'existing-stable-id'}}});
test('generated contracts agree and preserve all existing database, staff and legacy settings',()=>{
  const config=input(),out=generate(config);
  assert.equal(out.crm.PMS_COMMAND_SECRET,out.pms.PMS_COMMAND_SECRET);
  for(const name of ['crm','pms','studio'])assert.equal(out[name].DATABASE_URL,config.existing[name].DATABASE_URL);
  assert.equal(out.pms.AUTH_ENABLED,'false');assert.equal(out.pms.REDIS_URL,'redis://keep-redis');
  assert.equal(out.crm.AGENT_OUTBOUND_WEBHOOK_TOKEN,'legacy-token');
  assert.equal(out.studio.STUDIO_DATABASE_DEPLOYMENT_ID,'existing-stable-id');
  const credentials=JSON.parse(out.pms.CONNECT_CREDENTIALS_BOOTSTRAP);
  assert.equal(credentials[0].key,out.studio.PMS_API_KEY);assert.equal(credentials[1].key,out.crm.PMS_CONNECT_KEY);
  assert.notEqual(credentials[0].key,credentials[1].key);
  assert.equal(out.pms.GUESTRA_INTEGRATION_MIGRATIONS_APPROVED,'false');assert.equal(out.crm.GUESTRA_BUSINESS_WRITES_ENABLED,'false');
  assert.equal(out.crm.CRM_PMS_INTEGRATION_ENABLED,'false');assert.equal(out.pms.GUESTRA_INTEGRATION_V2_ENABLED,'false');
  assert.ok(envText(out.pms).includes('CONNECT_CREDENTIALS_BOOTSTRAP="['));
});
test('refuses fake identities, unconfirmed mapping and conflicting signing policy',()=>{
  const c=input();c.mapping.pmsTenantId='LOOKUP_REQUIRED';assert.throws(()=>generate(c));
  const d=input();d.propertyMappingConfirmed=false;assert.throws(()=>generate(d));
  const e=input();e.existing.crm.PMS_COMMAND_SECRET='a'.repeat(40);e.existing.pms.PMS_COMMAND_SECRET='b'.repeat(40);assert.throws(()=>generate(e),/conflict/);
});
