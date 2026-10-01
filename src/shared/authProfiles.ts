import fs from 'node:fs';
import { z } from 'zod';
import { AuthConfigSchema, JwtLocationSchema, type AuthConfig, type JwtLocation } from './types.js';

/**
 * Auth profiles live on the SERVER (qa.auth.json, gitignored). The UI/API only ever sees profile names.
 * The secret itself comes from an env var or a mounted file and is resolved right before authenticating.
 */
const SourceSchema = z.union([z.object({ env: z.string().min(1) }).strict(), z.object({ file: z.string().min(1) }).strict()]);
export const AuthProfileSchema = z.object({
  location: JwtLocationSchema,
  key: z.string().optional(),
  scheme: z.string().optional(),
  source: SourceSchema,
}).strict();
export const AuthProfilesFileSchema = z.object({ profiles: z.record(z.string(), AuthProfileSchema) }).strict();
export type AuthProfile = z.infer<typeof AuthProfileSchema>;

export interface AuthProfileSummary { name: string; location: JwtLocation }

export class AuthProfileResolver {
  constructor(private profiles: Record<string, AuthProfile> = {}, private env: NodeJS.ProcessEnv = process.env) {}

  static fromFile(file = process.env.QA_AUTH_PROFILES ?? 'qa.auth.json', env: NodeJS.ProcessEnv = process.env): AuthProfileResolver {
    if (!fs.existsSync(file)) return new AuthProfileResolver({}, env);
    const parsed = AuthProfilesFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid auth profiles file ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return new AuthProfileResolver(parsed.data.profiles, env);
  }

  /** Names + locations only. Never includes the secret or where it is read from. */
  list(): AuthProfileSummary[] {
    return Object.entries(this.profiles).map(([name, p]) => ({ name, location: p.location }));
  }
  has(name: string): boolean { return Object.prototype.hasOwnProperty.call(this.profiles, name); }

  /** Reads the secret and returns the AuthConfig. Error messages name the env var/file but never the value. */
  resolve(name: string): AuthConfig {
    if (!this.has(name)) throw new Error(`Unknown auth profile "${name}"`);
    const p = this.profiles[name]!;
    let jwt: string | undefined;
    if ('env' in p.source) {
      jwt = this.env[p.source.env];
      if (!jwt) throw new Error(`Auth profile "${name}": environment variable ${p.source.env} is not set`);
    } else {
      try { jwt = fs.readFileSync(p.source.file, 'utf8').trim(); } catch { throw new Error(`Auth profile "${name}": cannot read secret file ${p.source.file}`); }
      if (!jwt) throw new Error(`Auth profile "${name}": secret file ${p.source.file} is empty`);
    }
    return AuthConfigSchema.parse({ jwt: jwt.trim(), location: p.location, key: p.key, scheme: p.scheme ?? 'Bearer' });
  }
}
