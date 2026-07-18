import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSnapshot,
  AssetRecord,
  BatchRecord,
  DraftState,
  GenerationRecord,
  PromptTemplate,
  PublicSettings,
  StoredSettings,
  StoredState,
  TagCategory,
  TagGroup,
} from './types';
import { createDefaultTagGroups } from './default-tags';

const DEFAULT_MODEL = 'gpt-image-2-async';
const LEGACY_SHARED_DIMENSIONS = ['图片类型', '展示方式', '模特类型', '动作', '核心卖点', '适用场景', '背景', '视觉风格', '文案排版'];

type LegacyTagGroup = Partial<TagGroup> & { id?: string; name?: string; dimensions?: TagCategory[] };

function migrateLegacyPromptText<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('8岁东亚小女孩', '专业舞蹈儿童女模特') as T;
  if (Array.isArray(value)) return value.map((item) => migrateLegacyPromptText(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, migrateLegacyPromptText(item)])) as T;
  }
  return value;
}

function normalizeTagGroups(rawGroups: LegacyTagGroup[], defaults: TagGroup[]): TagGroup[] {
  return rawGroups.map((raw, groupIndex) => {
    const fallbackGroup = defaults.find((group) => group.id === raw.id) ?? defaults[groupIndex];
    const id = raw.id || fallbackGroup?.id || randomUUID();
    const legacyDimensions = Array.isArray(raw.dimensions) ? raw.dimensions : [];
    const rawSubcategories = Array.isArray(raw.subcategories)
      ? raw.subcategories.filter((subcategory) => !(id === 'standard-model' && subcategory.id === 'standard-model-general'))
      : [];
    const existingSubcategories = rawSubcategories.length > 0
      ? rawSubcategories.map((subcategory) => {
          const dimensions = Array.isArray(subcategory.dimensions) ? subcategory.dimensions : [];
          const fallbackSubcategory = fallbackGroup?.subcategories.find((candidate) => candidate.id === subcategory.id);
          const usesSharedDocumentLayout = subcategory.id !== `${id}-general`
            && dimensions.length === LEGACY_SHARED_DIMENSIONS.length
            && dimensions.every((dimension, index) => dimension.name === LEGACY_SHARED_DIMENSIONS[index]);
          if (fallbackSubcategory && usesSharedDocumentLayout) return fallbackSubcategory;
          return {
            ...subcategory,
            id: subcategory.id || randomUUID(),
            name: subcategory.name || '未命名小分类',
            dimensions,
          };
        })
      : legacyDimensions.length > 0 && id !== 'standard-model'
        ? [{
            id: `${id}-general`,
            name: fallbackGroup?.subcategories[0]?.name || '默认小分类',
            dimensions: legacyDimensions,
          }]
        : fallbackGroup?.subcategories.slice(0, 1) ?? [];
    const defaultAdditions = (fallbackGroup?.subcategories ?? []).filter((candidate) =>
      !existingSubcategories.some((subcategory) => subcategory.id === candidate.id),
    );
    const combinedSubcategories = [...existingSubcategories, ...defaultAdditions];
    const defaultOrder = new Map((fallbackGroup?.subcategories ?? []).map((subcategory, index) => [subcategory.id, index]));
    combinedSubcategories.sort((left, right) =>
      (defaultOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (defaultOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
    return {
      id,
      name: raw.name || fallbackGroup?.name || '未命名大分类',
      promptTemplate: raw.promptTemplate || fallbackGroup?.promptTemplate || '',
      subcategories: combinedSubcategories,
    };
  });
}

function defaultTagCategories(): TagCategory[] {
  const source: Record<string, Array<[string, string]>> = {
    动作: [
      ['自然站立', '自然放松站立，身体重心稳定，手臂自然垂落'],
      ['行走抓拍', '自然行走中的动态抓拍，步态舒展，衣摆轻微摆动'],
      ['回眸', '身体略微侧转并自然回眸，姿态优雅，视线看向镜头'],
      ['轻扶衣摆', '一只手轻扶衣摆，另一只手自然放松，突出服装轮廓'],
    ],
    构图: [
      ['全身构图', '完整全身构图，人物从头到脚完整入镜，主体居中'],
      ['三分之二身', '三分之二身构图，保留服装主体与人物姿态'],
      ['半身构图', '腰部以上半身构图，突出上装细节与人物神态'],
      ['近景特写', '近景特写构图，突出面部、面料纹理与精细配饰'],
    ],
    表情: [
      ['自然微笑', '自然克制的微笑，眼神放松，真实亲和'],
      ['清冷克制', '清冷克制的表情，眼神平静，嘴角自然'],
      ['松弛自然', '松弛自然的神态，面部肌肉放松'],
      ['自信明快', '自信明快的表情，眼神有力量'],
    ],
    发型: [
      ['自然长发', '自然顺滑长发，发丝清晰，轮廓干净'],
      ['利落短发', '利落短发造型，层次清晰，耳侧整洁'],
      ['低马尾', '简洁低马尾，发丝自然，额前碎发轻盈'],
      ['轻盈卷发', '轻盈自然卷发，卷度柔和，发量真实'],
    ],
    妆容: [
      ['自然裸妆', '自然裸妆，肤色通透，保留真实皮肤纹理'],
      ['干净淡妆', '干净淡妆，眉眼清晰，唇色自然'],
      ['通透妆感', '通透清爽妆感，光泽克制，色彩协调'],
      ['无面部装饰', '面部无贴纸、无彩绘、无夸张装饰'],
    ],
    背景: [
      ['纯色影棚', '干净纯色影棚背景，背景简洁，无杂物'],
      ['极简室内', '现代极简室内空间，陈设克制，层次自然'],
      ['城市街景', '真实城市街景，背景轻微虚化，环境光自然'],
      ['自然户外', '清新自然户外环境，光线柔和，景深自然'],
    ],
    摄影参数: [
      ['商业柔光', '商业摄影柔光布光，曝光准确，材质细节清晰'],
      ['自然窗光', '柔和自然窗光，明暗过渡真实，肤色准确'],
      ['清晰硬光', '清晰可控的硬光，阴影边缘利落，视觉明确'],
      ['电影感侧光', '克制的电影感侧光，层次丰富，主体轮廓清晰'],
    ],
  };
  return Object.entries(source).map(([name, tags]) => ({
    id: randomUUID(),
    name,
    tags: tags.map(([tagName, prompt]) => ({ id: randomUUID(), name: tagName, prompt })),
  }));
}

function defaultState(): StoredState {
  return {
    version: 1,
    settings: {
      defaultModel: DEFAULT_MODEL,
      invocationMode: 'async',
      concurrencyLimit: 10,
      apiKeyProtected: '',
      apiKeyPlain: '',
    },
    assets: [],
    generations: [],
    batches: [],
    templates: [
      {
        id: randomUUID(),
        name: '电商棚拍',
        prompt: '写实商业摄影，商品主体清晰，干净影棚光，材质细节真实，画面无文字、无水印。',
        createdAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: '生活方式场景',
        prompt: '自然生活方式摄影，环境真实，光线柔和，主体与背景关系自然，画面无文字、无水印。',
        createdAt: new Date().toISOString(),
      },
    ],
    tagGroups: createDefaultTagGroups(),
    draft: {
      mode: 'batch',
      batchTag: 'multi',
      model: DEFAULT_MODEL,
      tasks: [],
      queueShared: { front: null, side: null },
      queueOutput: { frontQuantity: 10, sideQuantity: 0, frontRatio: '1:1', sideRatio: '3:4', frontRatios: ['1:1'], sideRatios: ['3:4'] },
      queueRandomInitialized: false,
      detailSharedPrompt: '',
      detailTasks: [],
      detailBatchTag: 'relayout',
      outputRatios: ['3:4'],
      stampPrompt: '',
      workbenchFreeMode: false,
      workbenchGroupId: '',
      workbenchSubcategoryId: '',
      workbenchPrompt: '',
      workbenchSelections: {},
    },
  };
}

function mimeFromExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return types[extension] ?? 'application/octet-stream';
}

export class LocalStore {
  private readonly root: string;
  readonly assetDirectory: string;
  readonly outputDirectory: string;
  private readonly statePath: string;
  private state: StoredState;

  constructor() {
    this.root = app.getPath('userData');
    this.assetDirectory = path.join(this.root, 'assets');
    this.outputDirectory = path.join(this.root, 'outputs');
    this.statePath = path.join(this.root, 'workspace.json');
    fs.mkdirSync(this.assetDirectory, { recursive: true });
    fs.mkdirSync(this.outputDirectory, { recursive: true });
    this.state = this.load();
    this.persist();
  }

  private load(): StoredState {
    if (!fs.existsSync(this.statePath)) return defaultState();
    try {
      const parsed = migrateLegacyPromptText(JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<StoredState>);
      const fallback = defaultState();
      const tagGroups = Array.isArray(parsed.tagGroups) && parsed.tagGroups.length > 0
        ? normalizeTagGroups(parsed.tagGroups as LegacyTagGroup[], fallback.tagGroups)
        : fallback.tagGroups;
      const settings = { ...fallback.settings, ...parsed.settings };
      if (!settings.defaultModel || ['gpt-image-1', 'dall-e-3'].includes(settings.defaultModel)) settings.defaultModel = DEFAULT_MODEL;
      if (!['async', 'sync'].includes(settings.invocationMode)) settings.invocationMode = 'async';
      settings.concurrencyLimit = Math.min(50, Math.max(1, Math.floor(Number(settings.concurrencyLimit) || 10)));
      const draft = {
        ...fallback.draft,
        ...parsed.draft,
        queueShared: { ...fallback.draft.queueShared, ...parsed.draft?.queueShared },
        queueOutput: { ...fallback.draft.queueOutput, ...parsed.draft?.queueOutput },
      };
      const generations = Array.isArray(parsed.generations) ? parsed.generations.map((record) => {
        const normalized = {
          ...record,
          source: record.source || (record.taskName.startsWith('生图台') ? 'workbench' : 'batch'),
          batchPrefix: record.batchPrefix || `LEGACY-${record.batchId.slice(0, 8)}`,
          attempts: record.attempts || 1,
        };
        if (normalized.status !== 'pending') {
          delete normalized.remoteTaskId;
          delete normalized.remoteKind;
        }
        return normalized;
      }) : [];
      if (!draft.model || ['gpt-image-1', 'dall-e-3'].includes(draft.model)) draft.model = DEFAULT_MODEL;
      if (!['single', 'batch', 'template'].includes(draft.mode)) draft.mode = 'batch';
      draft.queueOutput.frontQuantity = Number.isFinite(draft.queueOutput.frontQuantity) ? Math.max(0, Math.floor(draft.queueOutput.frontQuantity)) : 10;
      draft.queueOutput.sideQuantity = Number.isFinite(draft.queueOutput.sideQuantity) ? Math.max(0, Math.floor(draft.queueOutput.sideQuantity)) : 0;
      if (!['1:1', '3:4'].includes(draft.queueOutput.frontRatio)) draft.queueOutput.frontRatio = '1:1';
      if (!['1:1', '3:4'].includes(draft.queueOutput.sideRatio)) draft.queueOutput.sideRatio = '3:4';
      draft.tasks = Array.isArray(draft.tasks)
        ? draft.tasks.map((task) => {
            const group = tagGroups.find((item) => item.id === task.tagGroupId) ?? tagGroups[0];
            const subcategory = group?.subcategories.find((item) => item.id === task.tagSubcategoryId) ?? group?.subcategories[0];
            return {
              ...task,
              tagGroupId: group?.id || '',
              tagSubcategoryId: subcategory?.id || '',
              ratio: ['1:1', '3:4', '16:9'].includes(task.ratio) ? task.ratio : '3:4',
              resolution: ['1K', '2K'].includes(task.resolution) ? task.resolution : task.resolution === '2K' || task.resolution === '4K' ? '2K' : '1K',
            };
          })
        : [];
      return {
        ...fallback,
        ...parsed,
        settings,
        draft,
        assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        generations,
        batches: Array.isArray(parsed.batches) ? parsed.batches : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : fallback.templates,
        tagGroups,
      };
    } catch {
      return defaultState();
    }
  }

  private persist(): void {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, (key, value) => key === 'preview' ? undefined : value, 2), 'utf8');
  }

  snapshot(): AppSnapshot {
    const missingPaths = new Set<string>();
    this.state.assets.forEach((asset) => { if (!fs.existsSync(asset.localPath)) missingPaths.add(asset.localPath); });
    this.state.generations.forEach((record) => { if (record.status === 'success' && record.outputPath && !fs.existsSync(record.outputPath)) missingPaths.add(record.outputPath); });
    missingPaths.forEach((missingPath) => this.deleteImageByPath(missingPath));
    const settings: PublicSettings = {
      defaultModel: this.state.settings.defaultModel,
      invocationMode: this.state.settings.invocationMode,
      concurrencyLimit: this.state.settings.concurrencyLimit,
      hasApiKey: Boolean(this.state.settings.apiKeyProtected || this.state.settings.apiKeyPlain),
    };
    return {
      settings,
      assets: [...this.state.assets],
      generations: [...this.state.generations],
      batches: [...this.state.batches],
      templates: [...this.state.templates],
      tagGroups: [...this.state.tagGroups],
      draft: this.state.draft,
      workspaceDirectory: this.root,
      outputDirectory: this.outputDirectory,
      configFile: this.statePath,
    };
  }

  updateSettings(input: Omit<PublicSettings, 'hasApiKey'> & { apiKey?: string }): PublicSettings {
    const next: StoredSettings = {
      ...this.state.settings,
      defaultModel: input.defaultModel.trim() || DEFAULT_MODEL,
      invocationMode: input.invocationMode,
      concurrencyLimit: Math.min(50, Math.max(1, Math.floor(Number(input.concurrencyLimit) || 10))),
    };
    if (input.apiKey?.trim()) {
      const apiKey = input.apiKey.trim();
      if (safeStorage.isEncryptionAvailable()) {
        next.apiKeyProtected = safeStorage.encryptString(apiKey).toString('base64');
        next.apiKeyPlain = '';
      } else {
        next.apiKeyPlain = apiKey;
        next.apiKeyProtected = '';
      }
    }
    this.state.settings = next;
    this.persist();
    return this.snapshot().settings;
  }

  getSettingsForGeneration(): { settings: StoredSettings; apiKey: string } {
    let apiKey = this.state.settings.apiKeyPlain;
    if (this.state.settings.apiKeyProtected) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(this.state.settings.apiKeyProtected, 'base64'));
      } catch {
        apiKey = '';
      }
    }
    return { settings: this.state.settings, apiKey };
  }

  saveDraft(draft: DraftState): void {
    this.state.draft = draft;
    this.persist();
  }

  saveTemplates(templates: PromptTemplate[]): void {
    this.state.templates = templates;
    this.persist();
  }

  saveTags(tagGroups: TagGroup[]): void {
    this.state.tagGroups = tagGroups;
    this.persist();
  }

  importAsset(sourcePath: string): AssetRecord {
    const extension = path.extname(sourcePath).toLowerCase() || '.png';
    const id = randomUUID();
    const destination = path.join(this.assetDirectory, `${id}${extension}`);
    fs.copyFileSync(sourcePath, destination);
    const record: AssetRecord = {
      id,
      name: path.basename(sourcePath),
      localPath: destination,
      mimeType: mimeFromExtension(destination),
      kind: 'reference',
      createdAt: new Date().toISOString(),
    };
    this.state.assets.unshift(record);
    this.persist();
    return record;
  }

  importGeneratedImage(sourcePath: string): AssetRecord {
    this.readImageAsDataUrl(sourcePath);
    return this.importAsset(sourcePath);
  }

  saveDataImage(dataUrl: string, name: string): AssetRecord {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
    if (!match) throw new Error('只能保存 PNG 格式的画布图片');
    const id = randomUUID();
    const destination = path.join(this.assetDirectory, `${id}.png`);
    fs.writeFileSync(destination, Buffer.from(match[1], 'base64'));
    const record: AssetRecord = {
      id,
      name: `${name.replace(/[<>:\"/\\|?*]/g, '-').trim() || 'canvas'}.png`,
      localPath: destination,
      mimeType: 'image/png',
      kind: 'reference',
      createdAt: new Date().toISOString(),
    };
    this.state.assets.unshift(record);
    this.persist();
    return record;
  }

  getAsset(id: string): AssetRecord | undefined {
    return this.state.assets.find((asset) => asset.id === id);
  }

  readImageAsDataUrl(filePath: string): string {
    const normalized = path.resolve(filePath).toLowerCase();
    const allowedRoots = [this.assetDirectory, this.outputDirectory].map((root) => path.resolve(root).toLowerCase());
    if (!allowedRoots.some((root) => normalized.startsWith(`${root}${path.sep}`))) {
      throw new Error('不允许读取应用目录之外的文件');
    }
    const content = fs.readFileSync(filePath);
    return `data:${mimeFromExtension(filePath)};base64,${content.toString('base64')}`;
  }

  createBatch(tag: string, total: number): BatchRecord {
    const batch: BatchRecord = {
      id: randomUUID(),
      tag: tag.trim() || `batch-${new Date().toISOString().slice(0, 10)}`,
      total,
      completed: 0,
      succeeded: 0,
      failed: 0,
      status: 'running',
      createdAt: new Date().toISOString(),
      completedAt: '',
    };
    this.state.batches.unshift(batch);
    this.persist();
    return batch;
  }

  addGeneration(record: GenerationRecord): void {
    this.state.generations.unshift(record);
    if (record.status === 'pending') {
      this.persist();
      return;
    }
    this.completeGeneration(record);
  }

  completeGeneration(record: GenerationRecord): void {
    const completedRecord = { ...record, remoteTaskId: undefined, remoteKind: undefined };
    const existing = this.state.generations.findIndex((item) => item.id === record.id);
    if (existing >= 0) this.state.generations[existing] = completedRecord;
    else this.state.generations.unshift(completedRecord);
    const batch = this.state.batches.find((item) => item.id === record.batchId);
    if (batch) {
      batch.completed += 1;
      if (record.status === 'success') batch.succeeded += 1;
      else batch.failed += 1;
      if (batch.completed >= batch.total) {
        batch.status = 'completed';
        batch.completedAt = new Date().toISOString();
      }
    }
    this.persist();
  }

  updateGeneration(recordId: string, update: Partial<GenerationRecord>): void {
    const record = this.state.generations.find((item) => item.id === recordId);
    if (!record) return;
    Object.assign(record, update);
    this.persist();
  }

  pendingGenerations(): GenerationRecord[] {
    return this.state.generations.filter((record) => record.status === 'pending').map((record) => ({ ...record }));
  }

  deleteImageByPath(localPath: string): boolean {
    const normalized = path.resolve(localPath);
    const allowedRoots = [this.assetDirectory, this.outputDirectory].map((root) => path.resolve(root));
    if (!allowedRoots.some((root) => normalized.startsWith(`${root}${path.sep}`))) throw new Error('只能删除软件工作目录中的图片');
    if (fs.existsSync(normalized)) fs.unlinkSync(normalized);
    const beforeAssets = this.state.assets.length;
    const beforeGenerations = this.state.generations.length;
    this.state.assets = this.state.assets.filter((asset) => path.resolve(asset.localPath) !== normalized);
    this.state.generations = this.state.generations.filter((record) => !record.outputPath || path.resolve(record.outputPath) !== normalized);
    const cleanTask = (task: DraftState['tasks'][number]) => ({
      ...task,
      references: Object.fromEntries(Object.entries(task.references).map(([key, asset]) => [key, asset && path.resolve(asset.localPath) === normalized ? null : asset])) as typeof task.references,
      detailAssets: task.detailAssets?.filter((asset) => path.resolve(asset.localPath) !== normalized),
    });
    this.state.draft.tasks = this.state.draft.tasks.map(cleanTask);
    this.state.draft.detailTasks = this.state.draft.detailTasks?.map(cleanTask);
    if (this.state.draft.queueShared.front && path.resolve(this.state.draft.queueShared.front.localPath) === normalized) this.state.draft.queueShared.front = null;
    if (this.state.draft.queueShared.side && path.resolve(this.state.draft.queueShared.side.localPath) === normalized) this.state.draft.queueShared.side = null;
    this.state.templates = this.state.templates.map((template) => ({
      ...template,
      sharedFront: template.sharedFront && path.resolve(template.sharedFront.localPath) === normalized ? null : template.sharedFront,
      sharedSide: template.sharedSide && path.resolve(template.sharedSide.localPath) === normalized ? null : template.sharedSide,
    }));
    this.persist();
    return beforeAssets !== this.state.assets.length || beforeGenerations !== this.state.generations.length;
  }

  getBatch(batchId: string): BatchRecord | undefined {
    return this.state.batches.find((batch) => batch.id === batchId);
  }

  deleteBatchRecord(batchId: string): boolean {
    const batch = this.state.batches.find((item) => item.id === batchId);
    if (!batch || batch.status === 'running') return false;
    this.state.batches = this.state.batches.filter((item) => item.id !== batchId);
    this.persist();
    return true;
  }

  deleteBatchRecordsBefore(cutoff: string): number {
    const cutoffTime = new Date(cutoff).getTime();
    if (!Number.isFinite(cutoffTime)) throw new Error('删除时间格式无效');
    const before = this.state.batches.length;
    this.state.batches = this.state.batches.filter((batch) => batch.status === 'running' || new Date(batch.createdAt).getTime() >= cutoffTime);
    const removed = before - this.state.batches.length;
    if (removed > 0) this.persist();
    return removed;
  }
}
