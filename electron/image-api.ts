import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssetRecord, StoredSettings } from './types';

const API_BASE_URL = 'https://mianyunai.com/v1';
const ASYNC_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 8_000;
const MAX_POST_ATTEMPTS = 3;

interface PostWaiter {
  limit: number;
  resolve: () => void;
}

let activePostRequests = 0;
const postWaiters: PostWaiter[] = [];

function pumpPostQueue(): void {
  while (postWaiters.length > 0) {
    const next = postWaiters[0];
    if (activePostRequests >= next.limit) return;
    postWaiters.shift();
    activePostRequests += 1;
    next.resolve();
  }
}

async function acquirePostSlot(limitValue: number): Promise<void> {
  const limit = Math.min(50, Math.max(1, Math.floor(limitValue) || 10));
  if (postWaiters.length === 0 && activePostRequests < limit) {
    activePostRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => postWaiters.push({ limit, resolve }));
}

function releasePostSlot(): void {
  activePostRequests = Math.max(0, activePostRequests - 1);
  pumpPostQueue();
}

async function withPostSlot<T>(limit: number, operation: () => Promise<T>): Promise<T> {
  await acquirePostSlot(limit);
  try {
    return await operation();
  } finally {
    releasePostSlot();
  }
}

interface GenerateImageInput {
  settings: StoredSettings;
  apiKey: string;
  prompt: string;
  model: string;
  ratio: string;
  resolution: string;
  references: AssetRecord[];
}

interface GeneratedImage {
  bytes: Buffer;
  extension: string;
  attempts: number;
}

interface DownloadedImage {
  bytes: Buffer;
  extension: string;
}

interface ApiBody {
  id?: string;
  status?: string;
  progress?: string;
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string } | string;
  message?: string;
}

function apiAspectRatio(value: string): string {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(value.trim());
  if (!match) throw new Error(`非法生图比例：${value}，比例必须是正整数 W:H`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error(`非法生图比例：${value}`);
  const longShortRatio = Math.max(width, height) / Math.min(width, height);
  if (longShortRatio > 3) throw new Error(`非法生图比例：${value}，长短边比例不能超过 3:1`);
  return `${width}:${height}`;
}

function endpoint(kind: 'generations' | 'edits', taskId?: string): string {
  return `${API_BASE_URL}/images/${kind}${taskId ? `/${encodeURIComponent(taskId)}` : ''}`;
}

function errorDetail(body: ApiBody, status?: number): string {
  const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
  return detail || (status ? `生图服务返回 HTTP ${status}` : '生图任务执行失败');
}

async function readApiBody(response: Response): Promise<ApiBody> {
  const body = await response.json().catch(() => ({})) as ApiBody;
  if (!response.ok) throw new Error(errorDetail(body, response.status));
  return body;
}

async function downloadResult(body: ApiBody): Promise<DownloadedImage | null> {
  const image = body.data?.[0];
  if (image?.b64_json) return { bytes: Buffer.from(image.b64_json, 'base64'), extension: '.png' };
  if (!image?.url) return null;
  const download = await fetch(image.url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error(`图片下载失败（HTTP ${download.status}）`);
  const mime = download.headers.get('content-type') ?? '';
  const extension = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
  return { bytes: Buffer.from(await download.arrayBuffer()), extension };
}

async function pollTask(
  kind: 'generations' | 'edits',
  taskId: string,
  headers: { Authorization: string },
): Promise<DownloadedImage> {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetch(endpoint(kind, taskId), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readApiBody(response);
    const result = await downloadResult(body);
    if (result) return result;
    const status = body.status?.toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status ?? '')) {
      throw new Error(errorDetail(body));
    }
  }
  throw new Error('异步生图任务等待超时，请稍后在任务记录中重试');
}

function multipartHeader(name: string, filename?: string, mimeType?: string): Buffer {
  const disposition = filename
    ? `Content-Disposition: form-data; name="${name}"; filename="${filename.replace(/[\r\n"]/g, '_')}"\r\nContent-Type: ${mimeType || 'application/octet-stream'}`
    : `Content-Disposition: form-data; name="${name}"`;
  return Buffer.from(`${disposition}\r\n\r\n`, 'utf8');
}

function createMultipartBody(
  boundary: string,
  fields: Array<[string, string]>,
  references: AssetRecord[],
): Buffer {
  const chunks: Buffer[] = [];
  const openPart = () => chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));

  for (const [name, value] of fields) {
    openPart();
    chunks.push(multipartHeader(name), Buffer.from(value, 'utf8'), Buffer.from('\r\n', 'utf8'));
  }

  for (const reference of references.slice(0, 9)) {
    openPart();
    chunks.push(
      multipartHeader('image', path.basename(reference.localPath), reference.mimeType),
      fs.readFileSync(reference.localPath),
      Buffer.from('\r\n', 'utf8'),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function retryError(error: unknown, attempts: number): Error & { attempts: number } {
  const value = error instanceof Error ? error : new Error(String(error));
  return Object.assign(value, { attempts });
}

async function postWithFixedBody(
  kind: 'generations' | 'edits',
  headers: Record<string, string>,
  body: string | Buffer,
  concurrencyLimit: number,
): Promise<GeneratedImage> {
  let lastError: unknown;
  for (let attempts = 1; attempts <= MAX_POST_ATTEMPTS; attempts += 1) {
    try {
      const responseBody = await withPostSlot(concurrencyLimit, async () => {
        const response = await fetch(endpoint(kind), {
          method: 'POST',
          headers,
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(60_000),
        });
        return readApiBody(response);
      });
      const immediate = await downloadResult(responseBody);
      const result = immediate ?? (responseBody.id ? await pollTask(kind, responseBody.id, { Authorization: headers.Authorization }) : null);
      if (!result) throw new Error('生图服务未返回任务 ID 或可识别的图片数据');
      return { ...result, attempts };
    } catch (error) {
      lastError = error;
    }
  }
  throw retryError(lastError, MAX_POST_ATTEMPTS);
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  if (!input.apiKey) throw new Error('请先在设置中填写 API Key');
  const headers = { Authorization: `Bearer ${input.apiKey}` };
  const isAsync = input.settings.invocationMode === 'async';
  const aspectRatio = apiAspectRatio(input.ratio);
  const quality = input.resolution.toUpperCase() === '2K' ? 'high' : 'medium';

  if (input.references.length === 0) {
    const body = JSON.stringify({
      async: isAsync,
      model: input.model,
      n: 1,
      prompt: input.prompt,
      quality,
      aspect_ratio: aspectRatio,
    });
    return postWithFixedBody('generations', { ...headers, 'Content-Type': 'application/json' }, body, input.settings.concurrencyLimit);
  }

  const boundary = `----MufenImageAI${randomUUID().replace(/-/g, '')}`;
  const body = createMultipartBody(boundary, [
    ['async', String(isAsync)],
    ['model', input.model],
    ['prompt', input.prompt],
    ['n', '1'],
    ['quality', quality],
    ['aspect_ratio', aspectRatio],
  ], input.references);
  return postWithFixedBody('edits', {
    ...headers,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }, body, input.settings.concurrencyLimit);
}
