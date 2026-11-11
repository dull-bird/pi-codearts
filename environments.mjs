import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const DEFAULT_PATHS = {
  account: '/snap-manager/v1/current/user',
  agents: '/v1/agent-center/agents/useragents',
  detail: '/v1/agent-center/agents/detail',
  chat: '/api/v2/chat/completions',
  heartbeat: '/snap-manager/v1/chat-session/heartbeat',
  models: '/v1/models',
  variants: '/v1/model/thinking-variants',
  usage: '/snap-manager/v1/statistics/plugin',
};
const DEFAULT_AGENT = 'a8bcb36232554267a5142361cc25a393';

function httpsUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid CodeArts ${field}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`CodeArts ${field} must be HTTPS without credentials, query or fragment`);
  }
  return url;
}
function route(value, field) {
  if (value === null && ['account', 'heartbeat', 'variants', 'usage'].includes(field)) return null;
  if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[?#\\\s]/.test(value)
      || new URL(value, 'https://invalid.example').pathname !== value) {
    throw new Error(`Invalid CodeArts path: ${field}`);
  }
  return value;
}
export function validateModels(models) {
  if (!Array.isArray(models)) throw new Error('CodeArts models must be an array');
  return models.map(m => {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) throw new Error('CodeArts model needs an id');
    for (const n of ['contextWindow', 'maxTokens']) {
      if (m[n] !== undefined && (!Number.isSafeInteger(m[n]) || m[n] <= 0)) throw new Error(`Invalid model ${n}`);
    }
    if (m.input !== undefined && (!Array.isArray(m.input) || !m.input.length || m.input.some(x => !['text', 'image'].includes(x)))) {
      throw new Error('Invalid model input capabilities');
    }
    if (m.thinkingLevelMap !== undefined && (!m.thinkingLevelMap || typeof m.thinkingLevelMap !== 'object' || Object.entries(m.thinkingLevelMap).some(([k,v]) => !['off','minimal','low','medium','high','xhigh','max'].includes(k) || (v !== null && typeof v !== 'string')))) throw new Error('Invalid model thinkingLevelMap');
    return {id: m.id, name: m.name || m.id, reasoning: m.reasoning === true,
      ...(m.thinkingLevelMap ? {thinkingLevelMap: m.thinkingLevelMap} : {}),
      input: m.input || ['text'], contextWindow: m.contextWindow || 32768, maxTokens: m.maxTokens || 4096,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
  });
}
export function normalizeEnvironment(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid CodeArts environment');
  const id = config.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error('Environment id must be 1-40 lowercase letters, digits or hyphens');
  const api = httpsUrl(config.apiOrigin, 'apiOrigin');
  if (api.pathname !== '/') throw new Error('apiOrigin must contain an origin only; customize paths separately');
  const authorize = httpsUrl(config.authorizeUrl, 'authorizeUrl');
  const token = httpsUrl(config.tokenUrl, 'tokenUrl');
  if (typeof config.clientId !== 'string' || !config.clientId.trim() || /[\r\n]/.test(config.clientId)) throw new Error('CodeArts clientId is required');
  const paths = Object.fromEntries(Object.entries({...DEFAULT_PATHS, ...config.paths}).map(([k, v]) => {
    if (!Object.hasOwn(DEFAULT_PATHS,k)) throw new Error(`Unknown CodeArts path: ${k}`);
    return [k, route(v, k)];
  }));
  if (!paths.chat.endsWith('/chat/completions')) throw new Error('Chat path must end with /chat/completions');
  const discovery = config.discovery || 'agents';
  if (!['agents', 'openai', 'static'].includes(discovery)) throw new Error('Unknown CodeArts discovery strategy');
  for(const field of ['scope','agentId','localAuthDir'])if(config[field]!==undefined&&typeof config[field]!=='string')throw new Error(`CodeArts ${field} must be a string`);
  const stateMode=config.stateMode || 'pkce';
  if(!['pkce','required'].includes(stateMode))throw new Error('Unsupported OAuth state mode');
  const pkceMethod = config.pkceMethod || 'SHA-256';
  if (!['SHA-256', 'S256'].includes(pkceMethod)) throw new Error('Unsupported PKCE method');
  for (const flag of ['allowTemporaryLogin', 'allowLocalLogin']) {
    if (config[flag] !== undefined && typeof config[flag] !== 'boolean') throw new Error(`${flag} must be boolean`);
  }
  return {id, label: typeof config.label === 'string' ? config.label : id,
    apiOrigin: api.origin, authorizeUrl: authorize.href, tokenUrl: token.href, clientId: config.clientId,
    paths, pkceMethod, stateMode, scope: typeof config.scope === 'string' ? config.scope : '',
    agentId: typeof config.agentId === 'string' ? config.agentId : '', discovery,
    models: validateModels(config.models || []),
    allowTemporaryLogin: config.allowTemporaryLogin === true, allowLocalLogin: config.allowLocalLogin === true,
    localAuthDir: config.localAuthDir ? resolve(config.localAuthDir.replace(/^~(?=\/)/, homedir())) : join(homedir(), '.codeartsdoer/cli-data')};
}
export const OFFICIAL = normalizeEnvironment({id: 'official', label: 'CodeArts（官方）',
  apiOrigin: 'https://snap-access.cn-north-4.myhuaweicloud.com',
  authorizeUrl: 'https://codearts.huaweicloud.com/portal/authorize',
  tokenUrl: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens', clientId: 'CodeArts_Tui'});
export const DEFAULT_AGENT_ID = DEFAULT_AGENT;
export function providerId(environment) { return environment.id === 'official' ? 'codearts' : `codearts-${environment.id}`; }
export function fingerprint(environment) {
  // Model selection/labels may change without migrating a credential to another auth server.
  const e = normalizeEnvironment(environment);
  return createHash('sha256').update(JSON.stringify([e.id, e.apiOrigin, e.authorizeUrl, e.tokenUrl, e.clientId, e.scope, e.pkceMethod, e.stateMode])).digest('hex');
}
export function bindEnvironment(auth, environment = OFFICIAL) {
  return {...auth, environment: {id: environment.id, fingerprint: fingerprint(environment)}};
}
export function assertEnvironment(auth, environment = OFFICIAL) {
  if (auth.environment) {
    if (auth.environment.id !== environment.id || auth.environment.fingerprint !== fingerprint(environment)) {
      throw new Error(`CodeArts environment changed or credential belongs elsewhere; run /login ${providerId(environment)}`);
    }
  } else if (fingerprint(environment) !== fingerprint(OFFICIAL)) {
    // Only credentials issued by the previous, single-environment version may migrate implicitly.
    throw new Error(`Unbound credential cannot be used in another environment; run /login ${providerId(environment)}`);
  }
  return environment;
}
export function configPath(agentDir) { return process.env.PI_CODEARTS_CONFIG || join(agentDir, 'codearts.json'); }
export async function loadEnvironments(path) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return [OFFICIAL]; throw new Error('Cannot parse CodeArts environment configuration'); }
  if (config.version !== 1 || !Array.isArray(config.environments)) throw new Error('CodeArts config requires version: 1 and environments: []');
  const officialOptions=config.official || {};
  if(Object.keys(officialOptions).some(k=>!['allowTemporaryLogin','allowLocalLogin','localAuthDir','models'].includes(k)))throw new Error('Official endpoint changes require a separate environment');
  const official=Object.keys(officialOptions).length?normalizeEnvironment({...OFFICIAL,...officialOptions}):OFFICIAL;
  const seen = new Set(['official']);
  return [official, ...config.environments.map(raw => {
    const environment = normalizeEnvironment(raw);
    if (seen.has(environment.id)) throw new Error(`Duplicate/reserved CodeArts environment id: ${environment.id}`);
    seen.add(environment.id); return environment;
  })];
}
export async function saveEnvironment(path, environment) {
  const normalized = normalizeEnvironment(environment);
  if (normalized.id === 'official') throw new Error('The verified official environment cannot be overwritten; create a separate environment');
  const environments = await loadEnvironments(path);
  const next = environments.filter(e => e.id !== 'official' && e.id !== normalized.id);
  next.push(normalized);
  await mkdir(dirname(path), {recursive: true});
  const tmp = `${path}.${randomUUID()}.tmp`;
  const official=environments.find(e=>e.id==='official');
  const officialOptions=official?{allowTemporaryLogin:official.allowTemporaryLogin,allowLocalLogin:official.allowLocalLogin,localAuthDir:official.localAuthDir,models:official.models}:{};
  await writeFile(tmp, JSON.stringify({version: 1, official:officialOptions, environments: next}, null, 2) + '\n', {mode: 0o600});
  await rename(tmp, path);
}
// Read only explicit endpoint fields from known client config files. No binary execution,
// no subnet/domain probing, and no credentials are read or sent during discovery.
export async function detectClientEnvironments(paths = [
  join(homedir(), '.codeartsdoer/codearts_cli.json'),
  join(homedir(), '.codeartsdoer/codearts-data/codearts.json'),
]) {
  const candidates = [];
  for (const path of paths) {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const options = raw.provider?.['inferhub-provider']?.options;
      if (!options?.inferhubBaseUrl || !options.authorizeUrl || !options.tokenUrl) continue;
      const environment = normalizeEnvironment({id: 'detected', label: 'CodeArts（本机配置）',
        apiOrigin: options.inferhubBaseUrl, authorizeUrl: options.authorizeUrl, tokenUrl: options.tokenUrl,
        clientId: options.clientId || 'CodeArts_Tui', agentId: options.agentId});
      if (!candidates.some(c => fingerprint(c.environment) === fingerprint(environment))) candidates.push({source: path, environment});
    } catch { /* Incomplete/unrecognized client configurations are not trusted or guessed. */ }
  }
  return candidates;
}
export function chatBaseUrl(environment = OFFICIAL) {
  return environment.apiOrigin + environment.paths.chat.slice(0, -'/chat/completions'.length);
}
