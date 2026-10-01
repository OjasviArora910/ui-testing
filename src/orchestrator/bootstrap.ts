import path from 'node:path';
import { createProviderFromEnv, type AIProvider } from '../ai/index.js';
import type { BrowserControllerOptions } from '../browser/index.js';
import { QADatabase } from '../database/db.js';
import { EvidenceStore } from '../evidence/index.js';
import { AuthProfileResolver } from '../shared/authProfiles.js';
import { loadConfig, type QAConfig } from '../shared/config.js';
import { Redactor } from '../shared/redactor.js';
import { BaselineStore } from '../visual/index.js';
import { Orchestrator } from './orchestrator.js';

export interface Platform { orchestrator: Orchestrator; config: QAConfig; redactor: Redactor; provider: AIProvider | null; profiles: AuthProfileResolver }

/** Wires the platform from server-side config + environment. One central Redactor is shared by every component. */
export function createPlatform(opts: { configFile?: string; configOverrides?: unknown; provider?: AIProvider | null; launch?: Partial<BrowserControllerOptions>; dbFile?: string; env?: NodeJS.ProcessEnv; trace?: boolean } = {}): Platform {
  const env = opts.env ?? process.env;
  const config = loadConfig(opts.configFile, opts.configOverrides ?? {});
  const redactor = new Redactor();
  const dataDir = path.resolve(config.paths.dataDir);
  const profiles = AuthProfileResolver.fromFile(env.QA_AUTH_PROFILES ?? 'qa.auth.json', env);
  const provider = opts.provider !== undefined ? opts.provider : createProviderFromEnv(redactor, env);
  const db = QADatabase.open(opts.dbFile ?? path.join(dataDir, 'qa.sqlite'), redactor);
  const launch: Partial<BrowserControllerOptions> = { ...(env.QA_CHROMIUM_PATH ? { executablePath: env.QA_CHROMIUM_PATH } : {}), ...(env.QA_NO_SANDBOX === '1' ? { launchArgs: ['--no-sandbox'] } : {}), ...opts.launch };
  const orchestrator = new Orchestrator({
    db, redactor, profiles, provider, baseConfig: config, launch, trace: opts.trace,
    evidence: new EvidenceStore(path.join(dataDir, 'evidence'), redactor),
    baselines: new BaselineStore(path.resolve(config.paths.baselineDir)),
    reportsDir: path.join(dataDir, 'runs'),
    maxConcurrentRuns: Number(env.QA_MAX_CONCURRENT_RUNS ?? 1),
  });
  return { orchestrator, config, redactor, provider, profiles };
}
