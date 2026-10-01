import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BaselineMeta { url: string; viewport: string; createdAt: string; sha256: string; file: string; maskSelectors: string[] }

/**
 * Filesystem baseline store: <root>/<host>/<path-slug>-<hash>/<viewport>.png (+ .json metadata).
 * Baselines are only ever written through `save`, which is called by explicit human approval (API/CLI), never by the AI.
 */
export class BaselineStore {
  constructor(private readonly root: string) {}

  private dir(pageUrl: string): string {
    const u = new URL(pageUrl);
    const slug = (u.pathname + u.search).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';
    const hash = crypto.createHash('sha1').update(u.origin + u.pathname + u.search).digest('hex').slice(0, 8);
    return path.join(this.root, u.host.replace(/[^a-zA-Z0-9.-]/g, '_'), `${slug}-${hash}`);
  }
  private file(pageUrl: string, viewport: string): string { return path.join(this.dir(pageUrl), `${viewport.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`); }

  has(pageUrl: string, viewport: string): boolean { return fs.existsSync(this.file(pageUrl, viewport)); }
  get(pageUrl: string, viewport: string): Buffer | null {
    const f = this.file(pageUrl, viewport);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }
  filePath(pageUrl: string, viewport: string): string { return this.file(pageUrl, viewport); }

  save(pageUrl: string, viewport: string, png: Buffer, maskSelectors: string[] = []): BaselineMeta {
    const f = this.file(pageUrl, viewport);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, png);
    const meta: BaselineMeta = { url: pageUrl, viewport, createdAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(png).digest('hex'), file: f, maskSelectors };
    fs.writeFileSync(f.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
}
