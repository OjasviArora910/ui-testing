import { accessibilityRules } from '../accessibility/rules.js';
import { functionalRules } from '../functional/rules.js';
import { consistencyRules } from '../geometry/consistency.js';
import { geometryRules } from '../geometry/rules.js';
import { responsiveRules } from '../geometry/responsive.js';
import { networkRules } from '../network/rules.js';
import type { QAConfig } from '../shared/config.js';
import { visualRules } from '../visual/rules.js';
import { compileCustomRule } from './configured.js';
import { RuleRegistry } from './registry.js';

export * from './types.js';
export * from './helpers.js';
export * from './registry.js';
export * from './configured.js';

export const builtinRules = [...geometryRules, ...consistencyRules, ...responsiveRules, ...networkRules, ...functionalRules, ...accessibilityRules, ...visualRules];

/** Registry with every built-in rule, the declarative rules from config, and any plugin modules listed in config. */
export async function buildRegistry(config: QAConfig, cwd = process.cwd()): Promise<RuleRegistry> {
  const reg = new RuleRegistry();
  for (const r of builtinRules) reg.register(r);
  for (const def of config.rules.custom) reg.register(compileCustomRule(def));
  await reg.loadPlugins(config.rules.plugins, cwd);
  return reg;
}
