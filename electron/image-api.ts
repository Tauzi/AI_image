import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssetRecord, StoredImageService, StoredSettings } from './types';

const ASYNC_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 8_000;
const MAX_POST_ATTEMPTS = 3;

interface GenerateImageInput {
  settings: StoredSettings;
  service: StoredImageService;
  apiKey: string;
  prompt: string;
  model: string;
  ratio: string;
  resolution: string;
  references: AssetRecord[];
  onTaskAccepted?: (kind: 'generations' | 'edits', taskId: string) => void;
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

function apiImageSize(settings: StoredSettings, ratio: string): string {
  const size = settings.imageRatios.find((preset) => preset.name === ratio)?.size ?? ratio;
  const normalized = size.trim().toLowerCase().replace('×', 'x');
  if (!/^[1-9]\d*x[1-9]\d*$/.test(normalized)) throw new Error(`生图尺寸无效：${size}`);
  return normalized;
}

export function modelForInvocation(model: string, invocationMode: StoredSettings['invocationMode']): string {
  const normalized = model.trim();
  if (invocationMode === 'sync') return normalized.endsWith('-async') ? normalized.slice(0, -'-async'.length) : normalized;
  if (normalized === 'gpt-image-2') return 'gpt-image-2-async';
  if (normalized === 'gpt-image-2-2k') return 'gpt-image-2-2k-async';
  return normalized;
}

function endpoint(baseUrl: string, kind: 'generations' | 'edits', taskId?: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/images/${kind}${taskId ? `/${encodeURIComponent(taskId)}` : ''}`;
}

function errorDetail(body: ApiBody, status?: number): string {
  const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
  const moderationMessage = (value: string) => {
    const normalized = value.toLowerCase();
    return normalized.includes('image_unsafe')
      || normalized.includes('content moderation')
      || normalized.includes('safety polic')
      || normalized.includes('unsafe')
      || normalized.includes('未通过内容审查');
  };
  if (detail) return moderationMessage(detail) ? '您的提示词或参考素材未通过内容审查，请修改后重新提交。' : detail;
  const rawUrl = body.data?.[0]?.url;
  if (rawUrl?.startsWith('poll failed:')) {
    const payload = rawUrl.replace(/^poll failed:\s*\d+\s*/, '');
    try {
      const parsed = JSON.parse(payload) as { error_code?: string; message?: string };
      if (parsed.error_code === 'image_unsafe' || (parsed.message && moderationMessage(parsed.message))) return '您的提示词或参考素材未通过内容审查，请修改后重新提交。';
      return [parsed.error_code, parsed.message].filter(Boolean).join('：') || payload;
    } catch {
      return payload;
    }
  }
  return status ? `生图服务返回 HTTP ${status}` : '生图任务执行失败';
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
  baseUrl: string,
): Promise<DownloadedImage> {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetch(endpoint(baseUrl, kind, taskId), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readApiBody(response);
    const status = body.status?.toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status ?? '')) {
      throw new Error(errorDetail(body));
    }
    const result = await downloadResult(body);
    if (result) return result;
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
  baseUrl: string,
  onTaskAccepted?: (kind: 'generations' | 'edits', taskId: string) => void,
): Promise<GeneratedImage> {
  let lastError: unknown;
  for (let attempts = 1; attempts <= MAX_POST_ATTEMPTS; attempts += 1) {
    try {
      const response = await fetch(endpoint(baseUrl, kind), {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(60_000),
      });
      const responseBody = await readApiBody(response);
      const responseStatus = responseBody.status?.toLowerCase();
      if (['failed', 'error', 'cancelled', 'canceled'].includes(responseStatus ?? '')) {
        throw new Error(errorDetail(responseBody));
      }
      const immediate = await downloadResult(responseBody);
      if (!immediate && responseBody.id) onTaskAccepted?.(kind, responseBody.id);
      const result = immediate ?? (responseBody.id ? await pollTask(kind, responseBody.id, { Authorization: headers.Authorization }, baseUrl) : null);
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
  const model = modelForInvocation(input.model, input.settings.invocationMode);
  const size = apiImageSize(input.settings, input.ratio);
  const quality = input.resolution.toUpperCase() === '2K' ? 'high' : 'medium';

  if (input.references.length === 0) {
    const body = JSON.stringify({
      async: isAsync,
      model,
      n: 1,
      prompt: input.prompt,
      quality,
      size,
    });
    return postWithFixedBody('generations', { ...headers, 'Content-Type': 'application/json' }, body, input.service.baseUrl, input.onTaskAccepted);
  }

  const boundary = `----EcommerceWorkbench${randomUUID().replace(/-/g, '')}`;
  const body = createMultipartBody(boundary, [
    ['async', String(isAsync)],
    ['model', model],
    ['prompt', input.prompt],
    ['n', '1'],
    ['quality', quality],
    ['size', size],
  ], input.references);
  return postWithFixedBody('edits', {
    ...headers,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }, body, input.service.baseUrl, input.onTaskAccepted);
}

export async function resumeImageTask(kind: 'generations' | 'edits', taskId: string, apiKey: string, baseUrl: string): Promise<GeneratedImage> {
  if (!apiKey) throw new Error('API Key 缺失，无法恢复异步任务查询');
  const result = await pollTask(kind, taskId, { Authorization: `Bearer ${apiKey}` }, baseUrl);
  return { ...result, attempts: 1 };
}
