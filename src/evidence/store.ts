import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Redactor } from '../shared/redactor.js';

export type EvidenceKind =
  | 'screenshot' | 'element-crop' | 'dom' | 'aria' | 'geometry' | 'network' | 'console'
  | 'visual-baseline' | 'visual-current' | 'visual-diff' | 'trace' | 'metadata';

export interface EvidenceRef {
  /** Content-addressed id: `ev_<sha256 prefix>`. This is what findings reference. */
  id: string;
  runId: string;
  kind: EvidenceKind;
  /** Path relative to the evidence root (never absolute). */
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
  label: string;
  page?: string;
  viewport?: string;
  createdAt: string;
}

export interface SaveMeta { label?: string; page?: string; viewport?: string }

const ID_PATTERN = /^ev_[a-f0-9]{16}$/;
const MIME: Record<string, string> = { png: 'image/png', json: 'application/json', html: 'text/html', txt: 'text/plain', yaml: 'text/yaml', zip: 'application/zip' };

/**
 * Filesystem evidence store (MVP). Every file is hashed (sha256) and referenced by a content-addressed id.
 * Text/JSON is redacted before it touches disk; binaries (screenshots, traces) cannot be redacted and are
 * therefore kept only on the local filesystem, never sent to the AI unless config.ai.sendScreenshots is set.
 */
export class EvidenceStore {
  constructor(private readonly root: string, private readonly redactor: Redactor) {
    fs.mkdirSync(root, { recursive: true });
  }

  private write(runId: string, kind: EvidenceKind, buf: Buffer, ext: string, meta: SaveMeta): EvidenceRef {
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const id = `ev_${sha256.slice(0, 16)}`;
    const rel = path.join(runId, kind, `${id}.${ext}`);
    const abs = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
    return { id, runId, kind, path: rel.split(path.sep).join('/'), sha256, bytes: buf.length, mime: MIME[ext] ?? 'application/octet-stream', label: meta.label ?? kind, page: meta.page, viewport: meta.viewport, createdAt: new Date().toISOString() };
  }

  saveText(runId: string, kind: EvidenceKind, text: string, ext = 'txt', meta: SaveMeta = {}): EvidenceRef {
    return this.write(runId, kind, Buffer.from(this.redactor.redact(text), 'utf8'), ext, meta);
  }
  saveJson(runId: string, kind: EvidenceKind, value: unknown, meta: SaveMeta = {}): EvidenceRef {
    return this.write(runId, kind, Buffer.from(JSON.stringify(this.redactor.redactDeep(value), null, 2), 'utf8'), 'json', meta);
  }
  saveBinary(runId: string, kind: EvidenceKind, buf: Buffer, ext: string, meta: SaveMeta = {}): EvidenceRef {
    return this.write(runId, kind, buf, ext, meta);
  }

  /** Absolute path for a ref, guaranteed to stay inside the root. */
  absolutePath(ref: Pick<EvidenceRef, 'path'>): string {
    const abs = path.resolve(this.root, ref.path);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Evidence path escapes the store root');
    return abs;
  }
  read(ref: Pick<EvidenceRef, 'path'>): Buffer { return fs.readFileSync(this.absolutePath(ref)); }

  /** Re-hash the file on disk and compare with the recorded hash (tamper/corruption check). */
  verify(ref: Pick<EvidenceRef, 'path' | 'sha256'>): boolean {
    try { return crypto.createHash('sha256').update(this.read(ref)).digest('hex') === ref.sha256; } catch { return false; }
  }

  static isValidId(id: string): boolean { return ID_PATTERN.test(id); }
}
