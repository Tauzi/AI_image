export type PromptToolRequest =
  | { mode: 'reverse'; imageDataUrl: string }
  | { mode: 'expand'; prompt: string };

interface TextServiceOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const REVERSE_PROMPT = `请作为一名顶级的 AI 绘画提示词专家，为我分析这张图片的提示词。

任务目标：
提取并反推这张图片的提示词，生成一份通用的 Prompt。

分析维度（请务必涵盖以下方面）：
画面风格、主体与场景、画面成分组成、构图方式、镜头与分镜类型、景别与视角、光影特质、色调与色彩科学、媒介与材质纹理、情绪与氛围、空间与透视、主体细节、背景细节、画质与后期、渲染/拍摄参数。

输出要求：
请直接输出一段完整的、高水准的中文提示词。
在提示词的开头或核心位置，使用 [在此处替换为您想要生成的主体内容] 作为占位符。
确保该 Prompt 具有高度通用性，用户只需更换占位符内容，即可在保持原图质感的同时生成全新的画面。
无需输出分析过程，请直接给出最终的 Prompt 文本。`;

const EXPAND_PROMPT = `请作为一名顶级的 AI 绘画提示词专家，将用户提供的简短提示词扩写、润色为一段可直接用于 AI 绘画的高质量中文提示词。

请在不改变用户核心创意、主体身份和明确约束的前提下，补足主体细节、环境与场景、构图、景别与视角、镜头语言、光影、色彩、材质纹理、氛围、空间层次、画质、渲染或摄影参数。内容要具体、连贯、有视觉重点，避免堆砌互相冲突的风格词。

无需解释、标题、分析过程、项目符号或 Markdown，只输出最终扩写后的完整中文提示词。

用户原始提示词：`;

function endpointFromBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('文字服务 API 地址无效，请在设置中检查');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('文字服务 API 地址必须使用 HTTP 或 HTTPS');
  return /\/chat\/completions$/i.test(url.pathname) ? url.toString() : `${value}/chat/completions`;
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('').trim();
}

function extractError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

function cleanResult(value: string): string {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export async function runPromptTool(request: PromptToolRequest, settings: TextServiceOptions): Promise<string> {
  if (!settings.apiKey.trim()) throw new Error('请先在设置中填写文字服务卡密');
  if (!settings.model.trim()) throw new Error('请先在设置中填写文字模型');

  const userContent = request.mode === 'reverse'
    ? [
        { type: 'text', text: REVERSE_PROMPT },
        { type: 'image_url', image_url: { url: request.imageDataUrl } },
      ]
    : `${EXPAND_PROMPT}\n${request.prompt.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(endpointFromBaseUrl(settings.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model.trim(),
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload: unknown = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(extractError(payload, `文字服务请求失败（HTTP ${response.status}）`));
    const result = cleanResult(extractText(payload));
    if (!result) throw new Error('文字服务没有返回可用的提示词');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('文字服务请求超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
