import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { QAConfig } from '../shared/config.js';
import { FindingSchema, type Finding } from '../shared/types.js';
import type { Rule, RuleContext, RuleRunResult } from './types.js';

/**
 * Plugin registry. Rules are registered by id; config can disable them or override severities.
 * Every produced finding is validated against FindingSchema (a `defect` without basis is rejected here).
 */
export class RuleRegistry {
  private rules = new Map<string, Rule>();

  register(rule: Rule): this {
    if (this.rules.has(rule.id)) throw new Error(`Rule "${rule.id}" is already registered`);
    this.rules.set(rule.id, rule);
    return this;
  }
  unregister(id: string): boolean { return this.rules.delete(id); }
  get(id: string): Rule | undefined { return this.rules.get(id); }
  list(): Rule[] { return [...this.rules.values()]; }

  enabled(config: Pick<QAConfig, 'rules'>): Rule[] {
    const off = new Set(config.rules.disabled);
    return this.list().filter((r) => !off.has(r.id));
  }

  async run(ctx: RuleContext, filter?: (rule: Rule) => boolean): Promise<RuleRunResult> {
    const result: RuleRunResult = { findings: [], errors: [], rulesRun: [] };
    for (const rule of this.enabled(ctx.config)) {
      if (filter && !filter(rule)) continue;
      result.rulesRun.push(rule.id);
      try {
        const produced = await rule.evaluate(ctx);
        for (const raw of produced) {
          const override = ctx.config.rules.severityOverrides[raw.ruleId] ?? ctx.config.rules.severityOverrides[rule.id];
          const candidate: Finding = override ? { ...raw, severity: override } : raw;
          const parsed = FindingSchema.safeParse(candidate);
          if (parsed.success) result.findings.push(parsed.data);
          else result.errors.push({ ruleId: rule.id, message: `invalid finding rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}` });
        }
      } catch (e) {
        result.errors.push({ ruleId: rule.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  }

  /** Loads rule plugins (JS/TS modules default-exporting Rule | Rule[]) listed in config. */
  async loadPlugins(files: string[], cwd = process.cwd()): Promise<void> {
    for (const f of files) {
      const mod = await import(pathToFileURL(path.resolve(cwd, f)).href) as { default?: Rule | Rule[]; rules?: Rule[] };
      const exported = mod.default ?? mod.rules;
      if (!exported) throw new Error(`Rule plugin ${f} has no default export`);
      for (const r of Array.isArray(exported) ? exported : [exported]) this.register(r);
    }
  }
}
