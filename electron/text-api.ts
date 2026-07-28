import type { StoredTextService } from './types';

const PRODUCT_MAIN_SYSTEM_PROMPT = `你是一名拥有千万级 GMV 视觉操盘经验的顶级电商视觉总监、商业平面设计师、服饰类主图策略专家。你尤其擅长把一张服饰产品图片，拆解成一整套适配国内电商平台的主图中文生图提示词。`;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string } | string;
  message?: string;
}

function completionText(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((item) => item.text ?? '').join('\n').trim();
  return '';
}

function errorText(body: ChatCompletionResponse, status: number): string {
  const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
  return detail || `AI 文字服务返回 HTTP ${status}`;
}

export async function generateProductMainPrompts(input: {
  service: StoredTextService;
  apiKey: string;
  imageDataUrl: string;
  ratioLabel: string;
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error('请先在设置中配置当前 AI 文字服务的 API Key');
  const baseUrl = input.service.baseUrl.replace(/\/+$/, '');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.service.model,
      messages: [
        { role: 'system', content: PRODUCT_MAIN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `请分析这张换装后的服饰白底图，为同一商品规划 8 张差异明确、可直接用于生图的国内电商主图中文提示词。\n\n当前统一输出尺寸：${input.ratioLabel}。每一张都必须保持参考图中的人物、服装款式、颜色、材质、结构、Logo、姿势和比例准确，只改变构图、背景、卖点表达、排版和商业视觉策略。\n\n请严格输出 8 个连续段落，格式必须是：\n主图 1：标题\n中文生图提示词：完整提示词\n\n依次输出到“主图 8”。不要输出前言、总结、Markdown 代码块或第 9 张。每条提示词必须独立完整，并明确画面设定、商品约束、背景光线、构图、卖点策略、文字排版与负面约束。`,
            },
            { type: 'image_url', image_url: { url: input.imageDataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({})) as ChatCompletionResponse;
  if (!response.ok) throw new Error(errorText(body, response.status));
  const text = completionText(body);
  if (!text) throw new Error('AI 文字服务没有返回可用提示词');
  return text;
}
