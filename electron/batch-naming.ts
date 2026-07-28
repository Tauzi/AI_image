import type { GenerationSource } from './types';

const SOURCE_PREFIXES: Record<GenerationSource, string> = {
  single: '单图',
  batch: '多批次',
  template: '模板队列',
  'product-main': '商品主图',
  'product-main-square': '主图转方图',
  workbench: '生图台',
  stamp: '贴标',
  garment3d: '3D白底',
  resource: '资源处理',
  detail: '详情页重排',
  'detail-generate': '详情页生成',
  sku: 'SKU主图',
};

export interface BatchNaming {
  batchPrefix: string;
  filePrefix: string;
}

export function normalizeBatchPrefix(value: string, source: GenerationSource): string {
  const normalized = value
    .normalize('NFC')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[ .-]+$/g, '')
    .slice(0, 48)
    .trim();
  return normalized || SOURCE_PREFIXES[source];
}

export function createBatchNaming(source: GenerationSource, requestedPrefix: string, now = new Date()): BatchNaming {
  const batchPrefix = normalizeBatchPrefix(requestedPrefix, source);
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return { batchPrefix, filePrefix: `${batchPrefix}_${timestamp}` };
}
