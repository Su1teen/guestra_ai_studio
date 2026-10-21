import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const secret = prefix => prefix + randomBytes(48).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
export function generate(input) {
  const { mapping, existing, urls, postgresServices } = input;
  const environment = input.environment ?? 'production';
  if (!['production', 'sandbox', 'test'].includes(environment) || !input.propertyMappingConfirmed
    || !mapping || ['crmPropertyId', 'crmTenantId', 'pmsPropertyId', 'pmsTenantId'].some(k =>
      typeof mapping[k] !== 'string' || !mapping[k] || /LOOKUP|REPLACE|EXAMPLE|PLACEHOLDER/i.test(mapping[k])))
    throw new Error('Verified real tenant/property IDs are required; never invent them');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mapping.pmsPropertyId)) throw new Error('PMS property must be a real UUID');
  for (const name of ['crm', 'pms', 'studio']) {
    const u = new URL(urls[name]);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Public HTTPS service URLs are required');
    if (!existing[name] || Object.values(existing[name]).some(v => typeof v !== 'string')) throw new Error('Full existing ENV snapshots are required');
  }
  const pms = { ...existing.pms }, crm = { ...existing.crm }, studio = { ...existing.studio };
  for(const name of ['crm','pms','studio']) {
    const deployment=name==='studio'?(studio.STUDIO_DATABASE_DEPLOYMENT_ID||input.databaseDeploymentIds?.studio):input.databaseDeploymentIds?.[name];
    if(typeof deployment!=='string'||!/^[a-zA-Z0-9_.:-]{8,160}$/.test(deployment)||/LOOKUP|SET_ONCE|KEEP_EXISTING/.test(deployment))throw new Error('Stable database deployment identities must be supplied explicitly');
  }
  const tenantMapping = { ...mapping, environment };
  const commandSecret = existing.crm.PMS_COMMAND_SECRET ?? existing.pms.PMS_COMMAND_SECRET ?? secret('');
  if (existing.crm.PMS_COMMAND_SECRET && existing.pms.PMS_COMMAND_SECRET && existing.crm.PMS_COMMAND_SECRET !== existing.pms.PMS_COMMAND_SECRET)
    throw new Error('Existing command secrets conflict; explicit rotation required');
  const studioCrmKey = studio.CRM_API_KEY || secret('gcrm_studio_read_');
  const inboxKey = pms.CRM_AGENT_KEY || secret('gcrm_pms_inbox_');
  const studioPmsKey = studio.PMS_API_KEY || secret('ck_studio_read_');
  const crmPmsKey = crm.PMS_CONNECT_KEY || secret('ck_crm_service_');
  if (new Set([studioCrmKey, inboxKey, studioPmsKey, crmPmsKey]).size !== 4) throw new Error('Each credential profile requires an independent key');
  const common = { GUESTRA_DEPLOY_AUTOMATION_ENABLED: 'true', GUESTRA_MIGRATION_BASELINE_APPROVED: 'true', GUESTRA_BUSINESS_WRITES_ENABLED: 'false' };
  Object.assign(pms, common, { GUESTRA_DATABASE_OWNER: 'guestra_pms', GUESTRA_DATABASE_DEPLOYMENT_ID: input.databaseDeploymentIds.pms,
    GUESTRA_INTEGRATION_MIGRATIONS_APPROVED: 'false', GUESTRA_REGISTRY_ENABLED: 'true', CONNECT_AUTH_REQUIRED: 'true',
    CONNECT_CREDENTIAL_BOOTSTRAP_ENABLED: 'true', INTEGRATION_ENVIRONMENT: environment,
    CONNECT_QUOTE_SIGNING_SECRET: pms.CONNECT_QUOTE_SIGNING_SECRET || secret(''), PMS_COMMAND_SECRET: commandSecret,
    GUESTRA_INTEGRATION_V2_ENABLED: 'false', GUESTRA_INBOX_ENABLED: 'false', VITE_GUESTRA_INBOX_ENABLED: 'false',
    CRM_AGENT_URL: urls.crm.replace(/\/$/, '') + '/api/integrations/agent', CRM_AGENT_KEY: inboxKey,
    CRM_PROPERTY_MAPPINGS: JSON.stringify([tenantMapping]), GUESTRA_PROPERTY_MAPPING_CONFIRMED: 'true' });
  const bootstrap = pms.CONNECT_CREDENTIALS_BOOTSTRAP ? JSON.parse(pms.CONNECT_CREDENTIALS_BOOTSTRAP) : [];
  for (const profile of [
    { label: 'guestra-studio-read', key: studioPmsKey, scopes: ['integration.read'] },
    { label: 'guestra-crm-service', key: crmPmsKey, scopes: ['integration.read', 'integration.write', 'events.read'] },
  ]) {
    const old = bootstrap.find(row => row.label === profile.label && row.propertyId === mapping.pmsPropertyId);
    if (old && (old.key !== profile.key || old.environment !== environment || JSON.stringify([...old.scopes].sort())!==JSON.stringify([...profile.scopes].sort()))) throw new Error('Existing PMS bootstrap conflicts; explicit rotation required');
    if (!old) bootstrap.push({ id: randomUUID(), propertyId: mapping.pmsPropertyId, environment, ...profile });
  }
  pms.CONNECT_CREDENTIALS_BOOTSTRAP = JSON.stringify(bootstrap);
  const principals = JSON.parse(crm.CRM_INTEGRATION_PRINCIPALS || '[]');
  const workspaceIds = (studio.N8N_WORKSPACE_IDS || '').split(',').filter(Boolean);
  if (!workspaceIds.length) throw new Error('Use existing Studio workspace IDs');
  for (const profile of [
    { id: 'studio-read', keyHash: hash(studioCrmKey), environment, propertyIds: [mapping.crmPropertyId], scopes: ['integration.read', 'agent.read', 'inspector.read'], workspaceIds },
    { id: 'pms-inbox', keyHash: hash(inboxKey), environment, propertyIds: [mapping.crmPropertyId], scopes: ['integration.read', 'inbox.read', 'inbox.handoff'] },
  ]) {
    const old = principals.find(row => row.id === profile.id);
    if (old && (old.keyHash !== profile.keyHash || old.environment !== environment || !old.propertyIds.includes(mapping.crmPropertyId)))
      throw new Error('Existing CRM principal conflicts with consumer key or property; explicit rotation required');
    if(old && (profile.scopes.some(scope=>!old.scopes.includes(scope)) || profile.workspaceIds?.some(workspace=>!old.workspaceIds?.includes(workspace))))throw new Error('Existing CRM principal is missing required scopes or workspaces');
    if (!old) principals.push(profile);
  }
  Object.assign(crm, common, { GUESTRA_DATABASE_OWNER: 'guestra_crm', GUESTRA_DATABASE_DEPLOYMENT_ID: input.databaseDeploymentIds.crm,
    GUESTRA_INTEGRATION_MIGRATIONS_APPROVED: 'false', GUESTRA_REGISTRY_ENABLED: 'false', GUESTRA_PROPERTY_MAPPING_CONFIRMED: 'true',
    CRM_PMS_INTEGRATION_ENABLED: 'false', INTEGRATION_ENVIRONMENT: environment, CRM_INTEGRATION_PRINCIPALS: JSON.stringify(principals),
    PMS_CONNECT_URL: urls.pms.replace(/\/$/, '') + '/api/v1/connect', PMS_CONNECT_KEY: crmPmsKey,
    PMS_COMMAND_SECRET: commandSecret, PMS_EVENT_SECRET: crm.PMS_EVENT_SECRET || secret(''), PMS_PROPERTY_MAPPINGS: JSON.stringify([tenantMapping]) });
  Object.assign(studio, { GUESTRA_DEPLOY_AUTOMATION_ENABLED: 'true', GUESTRA_MIGRATION_BASELINE_APPROVED: 'true',
    STUDIO_DATABASE_OWNER: 'guestra_ai_studio', STUDIO_DATABASE_DEPLOYMENT_ID: studio.STUDIO_DATABASE_DEPLOYMENT_ID || input.databaseDeploymentIds.studio,
    STUDIO_AUTO_MIGRATE: 'false', STUDIO_ENVIRONMENT: environment, STUDIO_SANDBOX: 'false', CRM_API_VERSION: 'v2',
    CRM_API_URL: pms.CRM_AGENT_URL, CRM_API_KEY: studioCrmKey,
    PMS_API_URL: crm.PMS_CONNECT_URL, PMS_API_KEY: studioPmsKey,
    CRM_PROPERTY_ID: mapping.crmPropertyId, CRM_TENANT_ID: mapping.crmTenantId, PMS_PROPERTY_ID: mapping.pmsPropertyId, PMS_TENANT_ID: mapping.pmsTenantId,
    INTEGRATION_ALLOWED_HOSTS: [...new Set([new URL(urls.crm).hostname, new URL(urls.pms).hostname,
      ...(studio.N8N_WEBHOOK_URL ? [new URL(studio.N8N_WEBHOOK_URL).hostname] : [])])].join(',') });
  for (const [name, values] of Object.entries({ crm, pms, studio })) {
    if (!values.DATABASE_URL) {
      if (!postgresServices?.[name]) throw new Error('Existing DATABASE_URL or verified Railway Postgres service name required');
      values.DATABASE_URL = '${{' + postgresServices[name] + '.DATABASE_URL}}';
    }
  }
  const laterKey = secret('gcrm_n8n_service_');
  const later = { CRM_API_URL: pms.CRM_AGENT_URL, CRM_API_KEY: laterKey, PMS_API_URL: crm.PMS_CONNECT_URL,
    N8N_TOKEN: studio.N8N_TOKEN || secret(''), N8N_CALLBACK_SECRET: studio.N8N_CALLBACK_SECRET || secret(''),
    CRM_PRINCIPAL_TO_REGISTER_LATER: JSON.stringify({id:'n8n-service',keyHash:hash(laterKey),environment,propertyIds:[mapping.crmPropertyId],workspaceIds,
      scopes:['integration.read','integration.write','integration.reconcile','events.read','events.consume','agent.read','agent.write',
        ...['get_context','classify_conversation','get_property_knowledge','get_accommodation_options','check_accommodation_availability',
          'create_or_update_request','update_request_lifecycle','create_offer','book_accommodation','get_service_options','check_service_availability',
          'book_service','reschedule_service','cancel_service','get_stay_context','get_folio_summary','create_guest_request','check_stay_extension','extend_stay',
          'handoff_to_human','update_guest_profile','update_conversation_memory','amend_accommodation','cancel_accommodation'].map(tool=>'tool:'+tool)]}),
    CRM_PROPERTY_ID: mapping.crmPropertyId, PMS_PROPERTY_ID: mapping.pmsPropertyId, ENVIRONMENT: environment };
  return { crm, pms, studio, later };
}
// JSON-valued variables use literal single quotes: dotenv parsers otherwise
// retain the backslashes in JSON.stringify's escaped double quotes.
export const envText = values => Object.entries(values).map(([key, value]) => `${key}=${value.includes('"')&&!value.includes("'")?"'"+value+"'":JSON.stringify(value)}`).join('\n') + '\n';
export async function writeConfig(input, directory) {
  const result = generate(input);
  await mkdir(directory, { mode: 0o700 }); // Refuse overwrite: restarting this command must not silently rotate secrets.
  if (process.platform === 'win32') {
    const account = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
    const acl = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'], { windowsHide: true });
    if (acl.status !== 0) throw new Error('Could not restrict generated directory permissions');
  }
  const report = ['# Railway ENV changes', '', 'Prepare profile: business writes and optional integration triggers stay disabled.', ''];
  for (const name of ['crm', 'pms', 'studio']) {
    const file = resolve(directory, `guestra-${name === 'studio' ? 'ai-studio' : name}.env`);
    await writeFile(file, envText(result[name]), { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    report.push(`## ${name.toUpperCase()}`, '', '| Variable | Action |', '|---|---|');
    for (const [key, value] of Object.entries(result[name])) report.push(`| ${key} | ${input.existing[name][key] === value ? 'KEEP' : key in input.existing[name] ? 'CHANGE' : 'ADD'}${/SECRET|KEY|TOKEN|BOOTSTRAP$/.test(key) && !(key in input.existing[name]) ? ' · GENERATED' : ''} |`);
    report.push('');
  }
  await writeFile(resolve(directory, 'n8n-later.env'), envText(result.later), { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(directory, 'ENV-CHANGES.md'), report.join('\n'), { mode: 0o600, flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), inputPath = args[args.indexOf('--input') + 1], output = args[args.indexOf('--output') + 1];
  if (!args.includes('--input') || !args.includes('--output')) throw new Error('Usage: integrations:generate-config -- --input private-config.json --output ops/railway/generated');
  await writeConfig(JSON.parse(await readFile(inputPath, 'utf8')), resolve(output));
  console.log('Railway configuration files generated; secrets were not printed.');
}
