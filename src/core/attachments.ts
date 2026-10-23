import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from './errors';

/** A file to upload into the chat through the site's attach button. */
export interface Attachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
const TEXT_EXT = /^(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ps1|sql|yaml|yml|toml|ini|log|css|scss)$/;
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext === 'jpeg' ? 'jpg' : ext]),
);

export function mimeFromName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? (TEXT_EXT.test(ext) ? 'text/plain' : 'application/octet-stream');
}

/** Detects common image formats from their first bytes (Ollama sends bare base64 without a type). */
export function sniffMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  return 'application/octet-stream';
}

function make(name: string | undefined, mimeType: string, data: Buffer, index: number): Attachment {
  if (!data.length) throw new BridgeError('bad_request', `Attachment ${index + 1} is empty.`);
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new BridgeError('bad_request', `Attachment ${index + 1} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  }
  const ext = EXT_BY_MIME[mimeType] ?? 'bin';
  return { name: name?.trim() || `attachment-${index + 1}.${ext}`, mimeType, data };
}

export function fromBase64(base64: string, index: number, name?: string, mimeType?: string): Attachment {
  const data = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  return make(name, mimeType || (name ? mimeFromName(name) : sniffMime(data)), data, index);
}

/** Accepts data: URLs and http(s) URLs (downloaded here, like the OpenAI API does). */
export async function fromUrl(url: string, index: number, name?: string): Promise<Attachment> {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (m) {
    const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    return make(name, m[1] || sniffMime(data), data, index);
  }
  if (!/^https?:\/\//i.test(url)) throw new BridgeError('bad_request', `Attachment ${index + 1}: unsupported URL.`);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new BridgeError('bad_request', `Could not download attachment ${index + 1}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new BridgeError('bad_request', `Could not download attachment ${index + 1}: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) {
    throw new BridgeError('bad_request', `Attachment ${index + 1} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const urlName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  return make(name ?? (urlName.includes('.') ? urlName : undefined), type || sniffMime(data), data, index);
}

export function fromPath(file: string, index: number): Attachment {
  if (!path.isAbsolute(file)) throw new BridgeError('bad_request', `File path must be absolute: ${file}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new BridgeError('bad_request', `File not found: ${file}`);
  }
  if (!stat.isFile()) throw new BridgeError('bad_request', `Not a file: ${file}`);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new BridgeError('bad_request', `${path.basename(file)} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  }
  return make(path.basename(file), mimeFromName(file), fs.readFileSync(file), index);
}

export function checkCount(n: number): void {
  if (n > MAX_ATTACHMENTS) throw new BridgeError('bad_request', `At most ${MAX_ATTACHMENTS} attachments per message.`);
}

/**
 * Attachments in OpenAI chat messages: `image_url` parts and `file` parts (file_data as a data
 * URL or bare base64). Collected from every message, in order.
 */
export async function fromOpenAiMessages(messages: unknown[]): Promise<Attachment[]> {
  const jobs: { kind: 'url' | 'b64'; value: string; name?: string; mime?: string }[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === 'image_url') {
        const iu = part.image_url as { url?: unknown } | string | undefined;
        const url = typeof iu === 'string' ? iu : iu?.url;
        if (typeof url === 'string') jobs.push({ kind: 'url', value: url });
      } else if (part?.type === 'file') {
        const f = part.file as { filename?: string; file_data?: string } | undefined;
        if (typeof f?.file_data !== 'string') continue;
        if (f.file_data.startsWith('data:')) jobs.push({ kind: 'url', value: f.file_data, name: f.filename });
        else jobs.push({ kind: 'b64', value: f.file_data, name: f.filename });
      }
    }
  }
  checkCount(jobs.length);
  return Promise.all(
    jobs.map((j, i) => (j.kind === 'url' ? fromUrl(j.value, i, j.name) : Promise.resolve(fromBase64(j.value, i, j.name)))),
  );
}

/** Ollama sends images as bare base64 strings in `images`. */
export function fromOllamaImages(lists: unknown[]): Attachment[] {
  const images = lists.flatMap((l) => (Array.isArray(l) ? l : [])).filter((x): x is string => typeof x === 'string');
  checkCount(images.length);
  return images.map((b64, i) => fromBase64(b64.replace(/^data:[^,]*,/, ''), i));
}
