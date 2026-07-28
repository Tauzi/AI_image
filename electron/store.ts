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
  ImageRatioPreset,
  PromptTemplate,
  PublicSettings,
  ResourceCategory,
  SettingsInput,
  StoredImageService,
  StoredSettings,
  StoredState,
  StoredTextService,
  TagCategory,
  TagGroup,
} from './types';
import { createDefaultTagGroups } from './default-tags';

const DEFAULT_MODEL = 'gpt-image-2-async';
const DEFAULT_SERVICE_ID = 'default-image-service';
const DEFAULT_SERVICE_URL = 'https://mianyunai.com/v1';
const DEFAULT_TEXT_SERVICE_ID = 'default-text-service';
const DEFAULT_TEXT_MODEL = 'gpt-4.1-mini';
const DEFAULT_IMAGE_RATIOS: ImageRatioPreset[] = [
  { id: 'ratio-square', name: '1:1', size: '1024x1024' },
  { id: 'ratio-portrait', name: '3:4', size: '768x1024' },
  { id: 'ratio-tall', name: '9:16', size: '576x1024' },
];
const DEFAULT_RESOURCE_CATEGORIES: Array<Pick<ResourceCategory, 'id' | 'name'>> = [
  { id: 'resource-model', name: '模特' },
  { id: 'resource-background', name: '背景' },
  { id: 'resource-product', name: '商品/服装' },
  { id: 'resource-other', name: '其他' },
];
const LEGACY_SHARED_DIMENSIONS = ['图片类型', '展示方式', '模特类型', '动作', '核心卖点', '适用场景', '背景', '视觉风格', '文案排版'];

function modelForInvocation(model: string, invocationMode: StoredSettings['invocationMode']): string {
  const normalized = model.trim();
  if (invocationMode === 'sync') return normalized.endsWith('-async') ? normalized.slice(0, -'-async'.length) : normalized;
  if (normalized === 'gpt-image-2') return 'gpt-image-2-async';
  if (normalized === 'gpt-image-2-2k') return 'gpt-image-2-2k-async';
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`API 地址无效：${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址必须使用 http 或 https');
  return normalized;
}

function normalizeImageRatios(value: unknown): ImageRatioPreset[] {
  const custom = Array.isArray(value) ? value : [];
  const normalized = DEFAULT_IMAGE_RATIOS.map((preset) => ({ ...preset }));
  const names = new Set(normalized.map((preset) => preset.name));
  for (const [index, raw] of custom.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const preset = raw as Partial<ImageRatioPreset>;
    const name = preset.name?.trim();
    const size = preset.size?.trim().toLowerCase().replace('×', 'x');
    if (!name || !size || !/^[1-9]\d*x[1-9]\d*$/.test(size) || names.has(name)) continue;
    normalized.push({ id: preset.id || `custom-ratio-${index + 1}`, name, size });
    names.add(name);
  }
  return normalized;
}

function saveApiKey(service: StoredImageService | StoredTextService, apiKey: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    service.apiKeyProtected = safeStorage.encryptString(apiKey).toString('base64');
    service.apiKeyPlain = '';
  } else {
    service.apiKeyPlain = apiKey;
    service.apiKeyProtected = '';
  }
}

function readApiKey(service: StoredImageService | StoredTextService): string {
  if (!service.apiKeyProtected) return service.apiKeyPlain;
  try {
    return safeStorage.decryptString(Buffer.from(service.apiKeyProtected, 'base64'));
  } catch {
    return '';
  }
}

type LegacyTagGroup = Partial<TagGroup> & { id?: string; name?: string; dimensions?: TagCategory[] };

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

function createDefaultResourceCategories(): ResourceCategory[] {
  const createdAt = new Date().toISOString();
  return DEFAULT_RESOURCE_CATEGORIES.map((category) => ({ ...category, createdAt }));
}

function addWardrobeChangeTag(groups: TagGroup[], defaults: TagGroup[]): TagGroup[] {
  const defaultGroup = defaults.find((group) => group.id === 'standard-model');
  if (!defaultGroup) return groups;
  return groups.map((group) => group.id !== 'standard-model' ? group : {
    ...group,
    subcategories: group.subcategories.map((subcategory) => {
      const defaultSubcategory = defaultGroup.subcategories.find((candidate) => candidate.id === subcategory.id);
      const defaultTag = defaultSubcategory?.dimensions.find((dimension) => dimension.name === '图片类型')
        ?.tags.find((tag) => tag.name === '模特换衣');
      if (!defaultTag) return subcategory;
      return {
        ...subcategory,
        dimensions: subcategory.dimensions.map((dimension) => dimension.name !== '图片类型'
          || dimension.tags.some((tag) => tag.name === '模特换衣')
          ? dimension
          : { ...dimension, tags: [...dimension.tags, { ...defaultTag }] }),
      };
    }),
  });
}

function defaultState(outputDirectory: string): StoredState {
  return {
    version: 6,
    settings: {
      defaultModel: DEFAULT_MODEL,
      invocationMode: 'async',
      activeServiceId: DEFAULT_SERVICE_ID,
      services: [{
        id: DEFAULT_SERVICE_ID,
        name: '默认生图服务',
        baseUrl: DEFAULT_SERVICE_URL,
        apiKeyProtected: '',
        apiKeyPlain: '',
      }],
      activeTextServiceId: DEFAULT_TEXT_SERVICE_ID,
      textServices: [{
        id: DEFAULT_TEXT_SERVICE_ID,
        name: '默认AI文字服务',
        baseUrl: DEFAULT_SERVICE_URL,
        model: DEFAULT_TEXT_MODEL,
        apiKeyProtected: '',
        apiKeyPlain: '',
      }],
      imageRatios: DEFAULT_IMAGE_RATIOS,
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
    resourceCategories: createDefaultResourceCategories(),
    outputDirectory,
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
      workbenchFreeMode: true,
      workbenchGroupId: '',
      workbenchSubcategoryId: '',
      workbenchPrompt: '',
      workbenchSelections: {},
      workbenchBatchPrefix: '生图台',
      skuReferenceAssets: [],
      skuVariants: [{ id: randomUUID(), attribute: '', color: '', size: '', customPrompt: '' }],
      skuBatchTag: 'sku',
      skuRatio: '1:1',
      skuResolution: '1K',
      skuModel: DEFAULT_MODEL,
      productMainReference: null,
      productMainRequirement: '保持商品款式、颜色、材质、结构和品牌细节准确，主体完整清晰，构图适合电商平台主图，背景干净，光线自然专业，不添加无关文字、Logo、水印或道具。',
      productMainTypes: ['正面展示'],
      productMainBatchPrefix: '商品主图',
      productMainResolution: '1K',
      productMainModel: DEFAULT_MODEL,
      productMainRatio: '1:1',
      productMainPromptText: '',
      productMainPrompts: [],
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
  private outputRoot: string;
  private readonly statePath: string;
  private state: StoredState;

  constructor() {
    this.root = app.getPath('userData');
    this.assetDirectory = path.join(this.root, 'assets');
    this.outputRoot = path.join(this.root, 'outputs');
    this.statePath = path.join(this.root, 'workspace.json');
    fs.mkdirSync(this.assetDirectory, { recursive: true });
    this.state = this.load();
    this.outputRoot = this.state.outputDirectory;
    fs.mkdirSync(this.outputRoot, { recursive: true });
    this.persist();
  }

  get outputDirectory(): string {
    return this.outputRoot;
  }

  private load(): StoredState {
    if (!fs.existsSync(this.statePath)) return defaultState(this.outputRoot);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<StoredState>;
      const fallback = defaultState(this.outputRoot);
      let tagGroups = Number(parsed.version) >= 2 && Array.isArray(parsed.tagGroups) && parsed.tagGroups.length > 0
        ? normalizeTagGroups(parsed.tagGroups as LegacyTagGroup[], fallback.tagGroups)
        : fallback.tagGroups;
      if (Number(parsed.version) < 5) tagGroups = addWardrobeChangeTag(tagGroups, fallback.tagGroups);
      const parsedSettings = parsed.settings as Partial<StoredSettings> | undefined;
      const legacyProtected = parsedSettings?.apiKeyProtected ?? '';
      const legacyPlain = parsedSettings?.apiKeyPlain ?? '';
      const parsedServices = Array.isArray(parsedSettings?.services) ? parsedSettings.services : [];
      const services: StoredImageService[] = parsedServices.length > 0
        ? parsedServices.map((service, index) => ({
            id: service.id || `image-service-${index + 1}`,
            name: service.name?.trim() || `生图服务 ${index + 1}`,
            baseUrl: normalizeBaseUrl(service.baseUrl || DEFAULT_SERVICE_URL),
            apiKeyProtected: service.apiKeyProtected || '',
            apiKeyPlain: service.apiKeyPlain || '',
          }))
        : [{
            id: DEFAULT_SERVICE_ID,
            name: '默认生图服务',
            baseUrl: DEFAULT_SERVICE_URL,
            apiKeyProtected: legacyProtected,
            apiKeyPlain: legacyPlain,
          }];
      const parsedTextServices = Array.isArray(parsedSettings?.textServices) ? parsedSettings.textServices : [];
      const textServices: StoredTextService[] = parsedTextServices.length > 0
        ? parsedTextServices.map((service, index) => ({
            id: service.id || `text-service-${index + 1}`,
            name: service.name?.trim() || `AI文字服务 ${index + 1}`,
            baseUrl: normalizeBaseUrl(service.baseUrl || DEFAULT_SERVICE_URL),
            model: service.model?.trim() || DEFAULT_TEXT_MODEL,
            apiKeyProtected: service.apiKeyProtected || '',
            apiKeyPlain: service.apiKeyPlain || '',
          }))
        : [{
            id: DEFAULT_TEXT_SERVICE_ID,
            name: '默认AI文字服务',
            baseUrl: DEFAULT_SERVICE_URL,
            model: DEFAULT_TEXT_MODEL,
            apiKeyProtected: '',
            apiKeyPlain: '',
          }];
      const imageRatios = normalizeImageRatios(parsedSettings?.imageRatios);
      const settings: StoredSettings = {
        ...fallback.settings,
        ...parsedSettings,
        services,
        textServices,
        imageRatios,
        activeServiceId: services.some((service) => service.id === parsedSettings?.activeServiceId)
          ? parsedSettings!.activeServiceId!
          : services[0].id,
        activeTextServiceId: textServices.some((service) => service.id === parsedSettings?.activeTextServiceId)
          ? parsedSettings!.activeTextServiceId!
          : textServices[0].id,
      };
      delete settings.apiKeyProtected;
      delete settings.apiKeyPlain;
      delete (settings as unknown as Record<string, unknown>).concurrencyLimit;
      if (!settings.defaultModel || ['gpt-image-1', 'dall-e-3'].includes(settings.defaultModel)) settings.defaultModel = DEFAULT_MODEL;
      if (!['async', 'sync'].includes(settings.invocationMode)) settings.invocationMode = 'async';
      settings.defaultModel = modelForInvocation(settings.defaultModel, settings.invocationMode);
      const draft = {
        ...fallback.draft,
        ...parsed.draft,
        queueShared: { ...fallback.draft.queueShared, ...parsed.draft?.queueShared },
        queueOutput: { ...fallback.draft.queueOutput, ...parsed.draft?.queueOutput },
      };
      if (Number(parsed.version) < 4) draft.workbenchFreeMode = true;
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
      if (!imageRatios.some((preset) => preset.name === draft.queueOutput.frontRatio)) draft.queueOutput.frontRatio = imageRatios[0].name;
      if (!imageRatios.some((preset) => preset.name === draft.queueOutput.sideRatio)) draft.queueOutput.sideRatio = imageRatios[1]?.name ?? imageRatios[0].name;
      draft.queueOutput.frontRatios = [draft.queueOutput.frontRatio];
      draft.queueOutput.sideRatios = [draft.queueOutput.sideRatio];
      draft.outputRatios = [imageRatios.some((preset) => preset.name === draft.outputRatios?.[0]) ? draft.outputRatios![0] : imageRatios[1]?.name ?? imageRatios[0].name];
      const normalizeTaskAssets = (task: DraftState['tasks'][number]) => ({
        ...task,
        productAssets: Array.isArray(task.productAssets)
          ? task.productAssets
          : [task.references?.garment, task.references?.side].filter((asset): asset is AssetRecord => Boolean(asset)),
        resourceAssets: Array.isArray(task.resourceAssets)
          ? task.resourceAssets
          : [task.references?.face].filter((asset): asset is AssetRecord => Boolean(asset)),
      });
      draft.tasks = Array.isArray(draft.tasks)
        ? draft.tasks.map((task) => {
            const group = tagGroups.find((item) => item.id === task.tagGroupId) ?? tagGroups[0];
            const subcategory = group?.subcategories.find((item) => item.id === task.tagSubcategoryId) ?? group?.subcategories[0];
            return normalizeTaskAssets({
              ...task,
              tagGroupId: group?.id || '',
              tagSubcategoryId: subcategory?.id || '',
              ratio: imageRatios.some((preset) => preset.name === task.ratio) ? task.ratio : imageRatios[0].name,
              resolution: ['1K', '2K'].includes(task.resolution) ? task.resolution : task.resolution === '2K' || task.resolution === '4K' ? '2K' : '1K',
            });
          })
        : [];
      draft.detailTasks = Array.isArray(draft.detailTasks) ? draft.detailTasks.map(normalizeTaskAssets) : [];
      draft.queueSharedResources = Array.isArray(draft.queueSharedResources) ? draft.queueSharedResources : [];
      draft.skuReferenceAssets = Array.isArray(draft.skuReferenceAssets) ? draft.skuReferenceAssets : [];
      draft.skuVariants = Array.isArray(draft.skuVariants) && draft.skuVariants.length > 0
        ? draft.skuVariants.map((variant) => ({
            id: variant.id || randomUUID(),
            attribute: typeof variant.attribute === 'string' ? variant.attribute : '',
            color: typeof variant.color === 'string' ? variant.color : '',
            size: typeof variant.size === 'string' ? variant.size : '',
            customPrompt: typeof variant.customPrompt === 'string' ? variant.customPrompt : '',
          }))
        : fallback.draft.skuVariants;
      draft.skuBatchTag = typeof draft.skuBatchTag === 'string' && draft.skuBatchTag.trim() ? draft.skuBatchTag : 'sku';
      draft.skuRatio = imageRatios.some((preset) => preset.name === draft.skuRatio) ? draft.skuRatio : imageRatios[0].name;
      draft.skuResolution = ['1K', '2K'].includes(draft.skuResolution ?? '') ? draft.skuResolution : '1K';
      draft.skuModel = typeof draft.skuModel === 'string' && draft.skuModel.trim()
        ? modelForInvocation(draft.skuModel, settings.invocationMode)
        : settings.defaultModel;
      draft.productMainReference = draft.productMainReference && typeof draft.productMainReference === 'object'
        ? draft.productMainReference
        : null;
      draft.productMainRequirement = typeof draft.productMainRequirement === 'string'
        ? draft.productMainRequirement
        : fallback.draft.productMainRequirement;
      draft.productMainTypes = Array.isArray(draft.productMainTypes) && draft.productMainTypes.length > 0
        ? draft.productMainTypes.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        : fallback.draft.productMainTypes;
      draft.productMainBatchPrefix = typeof draft.productMainBatchPrefix === 'string' && draft.productMainBatchPrefix.trim()
        ? draft.productMainBatchPrefix
        : '商品主图';
      draft.productMainResolution = ['1K', '2K'].includes(draft.productMainResolution ?? '') ? draft.productMainResolution : '1K';
      draft.productMainModel = typeof draft.productMainModel === 'string' && draft.productMainModel.trim()
        ? modelForInvocation(draft.productMainModel, settings.invocationMode)
        : settings.defaultModel;
      draft.productMainRatio = typeof draft.productMainRatio === 'string'
        && (imageRatios.some((preset) => preset.name === draft.productMainRatio) || /^[1-9]\d*[x×][1-9]\d*$/i.test(draft.productMainRatio.trim()))
        ? draft.productMainRatio.trim().replace('×', 'x')
        : imageRatios[0].name;
      draft.productMainPromptText = typeof draft.productMainPromptText === 'string' ? draft.productMainPromptText : '';
      draft.productMainPrompts = Array.isArray(draft.productMainPrompts)
        ? draft.productMainPrompts.slice(0, 8).map((item, index) => ({
            id: item?.id || randomUUID(),
            title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : `主图 ${index + 1}`,
            prompt: typeof item?.prompt === 'string' ? item.prompt : '',
          }))
        : [];
      const resourceCategories = Array.isArray(parsed.resourceCategories) && parsed.resourceCategories.length > 0
        ? parsed.resourceCategories.filter((category) => category?.id && category?.name).map((category) => ({
            id: category.id,
            name: category.name.trim(),
            createdAt: category.createdAt || new Date().toISOString(),
          }))
        : fallback.resourceCategories;
      const categoryIds = new Set(resourceCategories.map((category) => category.id));
      const assets = Array.isArray(parsed.assets) ? parsed.assets.map((asset) => ({
        ...asset,
        resourceCategoryId: asset.isLibraryResource && categoryIds.has(asset.resourceCategoryId ?? '')
          ? asset.resourceCategoryId
          : asset.isLibraryResource ? resourceCategories[0]?.id : undefined,
      })) : [];
      const outputDirectory = typeof parsed.outputDirectory === 'string' && path.isAbsolute(parsed.outputDirectory)
        ? path.resolve(parsed.outputDirectory)
        : this.outputRoot;
      return {
        ...fallback,
        ...parsed,
        version: 6,
        settings,
        draft,
        assets,
        generations,
        batches: Array.isArray(parsed.batches) ? parsed.batches : [],
        templates: Array.isArray(parsed.templates) ? parsed.templates : fallback.templates,
        tagGroups,
        resourceCategories,
        outputDirectory,
      };
    } catch {
      return defaultState(this.outputRoot);
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
      activeServiceId: this.state.settings.activeServiceId,
      services: this.state.settings.services.map((service) => ({
        id: service.id,
        name: service.name,
        baseUrl: service.baseUrl,
        hasApiKey: Boolean(service.apiKeyProtected || service.apiKeyPlain),
      })),
      activeTextServiceId: this.state.settings.activeTextServiceId,
      textServices: this.state.settings.textServices.map((service) => ({
        id: service.id,
        name: service.name,
        baseUrl: service.baseUrl,
        model: service.model,
        hasApiKey: Boolean(service.apiKeyProtected || service.apiKeyPlain),
      })),
      imageRatios: this.state.settings.imageRatios.map((preset) => ({ ...preset })),
      hasApiKey: this.state.settings.services.some((service) =>
        service.id === this.state.settings.activeServiceId && Boolean(service.apiKeyProtected || service.apiKeyPlain),
      ),
      hasTextApiKey: this.state.settings.textServices.some((service) =>
        service.id === this.state.settings.activeTextServiceId && Boolean(service.apiKeyProtected || service.apiKeyPlain),
      ),
    };
    return {
      settings,
      assets: [...this.state.assets],
      generations: [...this.state.generations],
      batches: [...this.state.batches],
      templates: [...this.state.templates],
      tagGroups: [...this.state.tagGroups],
      draft: this.state.draft,
      resourceCategories: [...this.state.resourceCategories],
      workspaceDirectory: this.root,
      outputDirectory: this.outputDirectory,
      configFile: this.statePath,
    };
  }

  updateSettings(input: SettingsInput): PublicSettings {
    const existingServices = new Map(this.state.settings.services.map((service) => [service.id, service]));
    const serviceInputs = input.services.length > 0 ? input.services : [{
      id: DEFAULT_SERVICE_ID,
      name: '默认生图服务',
      baseUrl: DEFAULT_SERVICE_URL,
      apiKey: '',
    }];
    const services = serviceInputs.map((service, index) => {
      const existing = existingServices.get(service.id);
      const next: StoredImageService = {
        id: service.id || randomUUID(),
        name: service.name.trim() || `生图服务 ${index + 1}`,
        baseUrl: normalizeBaseUrl(service.baseUrl),
        apiKeyProtected: existing?.apiKeyProtected ?? '',
        apiKeyPlain: existing?.apiKeyPlain ?? '',
      };
      if (service.apiKey?.trim()) saveApiKey(next, service.apiKey.trim());
      return next;
    });
    const existingTextServices = new Map(this.state.settings.textServices.map((service) => [service.id, service]));
    const textServiceInputs = input.textServices.length > 0 ? input.textServices : [{
      id: DEFAULT_TEXT_SERVICE_ID,
      name: '默认AI文字服务',
      baseUrl: DEFAULT_SERVICE_URL,
      model: DEFAULT_TEXT_MODEL,
      apiKey: '',
    }];
    const textServices = textServiceInputs.map((service, index) => {
      const existing = existingTextServices.get(service.id);
      const next: StoredTextService = {
        id: service.id || randomUUID(),
        name: service.name.trim() || `AI文字服务 ${index + 1}`,
        baseUrl: normalizeBaseUrl(service.baseUrl),
        model: service.model.trim() || DEFAULT_TEXT_MODEL,
        apiKeyProtected: existing?.apiKeyProtected ?? '',
        apiKeyPlain: existing?.apiKeyPlain ?? '',
      };
      if (service.apiKey?.trim()) saveApiKey(next, service.apiKey.trim());
      return next;
    });
    const next: StoredSettings = {
      ...this.state.settings,
      defaultModel: modelForInvocation(input.defaultModel.trim() || DEFAULT_MODEL, input.invocationMode),
      invocationMode: input.invocationMode,
      activeServiceId: services.some((service) => service.id === input.activeServiceId) ? input.activeServiceId : services[0].id,
      services,
      activeTextServiceId: textServices.some((service) => service.id === input.activeTextServiceId) ? input.activeTextServiceId : textServices[0].id,
      textServices,
      imageRatios: normalizeImageRatios(input.imageRatios),
    };
    const ratioOptions = next.imageRatios.map((preset) => preset.name);
    const normalizeRatio = (ratio: string | undefined, fallbackIndex = 0) => ratio && ratioOptions.includes(ratio)
      ? ratio
      : ratioOptions[fallbackIndex] ?? ratioOptions[0];
    const normalizeQueueOutput = (output: DraftState['queueOutput']): DraftState['queueOutput'] => {
      const frontRatio = normalizeRatio(output.frontRatio);
      const sideRatio = normalizeRatio(output.sideRatio, 1);
      return { ...output, frontRatio, sideRatio, frontRatios: [frontRatio], sideRatios: [sideRatio] };
    };
    this.state.settings = next;
    this.state.draft = {
      ...this.state.draft,
      tasks: this.state.draft.tasks.map((task) => ({ ...task, ratio: normalizeRatio(task.ratio, 1) })),
      detailTasks: this.state.draft.detailTasks?.map((task) => ({ ...task, ratio: normalizeRatio(task.ratio, 1) })),
      outputRatios: [normalizeRatio(this.state.draft.outputRatios?.[0], 1)],
      skuRatio: normalizeRatio(this.state.draft.skuRatio),
      skuModel: modelForInvocation(this.state.draft.skuModel || next.defaultModel, next.invocationMode),
      productMainModel: modelForInvocation(this.state.draft.productMainModel || next.defaultModel, next.invocationMode),
      productMainRatio: /^[1-9]\d*x[1-9]\d*$/i.test(this.state.draft.productMainRatio ?? '')
        ? this.state.draft.productMainRatio
        : normalizeRatio(this.state.draft.productMainRatio),
      queueOutput: normalizeQueueOutput(this.state.draft.queueOutput),
    };
    this.state.templates = this.state.templates.map((template) => template.queueOutput
      ? { ...template, queueOutput: normalizeQueueOutput(template.queueOutput) }
      : template);
    this.persist();
    return this.snapshot().settings;
  }

  getSettingsForGeneration(serviceId = this.state.settings.activeServiceId): { settings: StoredSettings; service: StoredImageService; apiKey: string } {
    const service = this.state.settings.services.find((item) => item.id === serviceId)
      ?? this.state.settings.services.find((item) => item.id === this.state.settings.activeServiceId)
      ?? this.state.settings.services[0];
    return { settings: this.state.settings, service, apiKey: readApiKey(service) };
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

  importAsset(sourcePath: string, resourceCategoryId?: string): AssetRecord {
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
      resourceCategoryId,
      isLibraryResource: Boolean(resourceCategoryId),
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

  getTextServiceForGeneration(serviceId = this.state.settings.activeTextServiceId): { service: StoredTextService; apiKey: string } {
    const service = this.state.settings.textServices.find((item) => item.id === serviceId)
      ?? this.state.settings.textServices.find((item) => item.id === this.state.settings.activeTextServiceId)
      ?? this.state.settings.textServices[0];
    if (!service) throw new Error('请先添加 AI 文字服务');
    return { service, apiKey: readApiKey(service) };
  }

  saveResourceCategories(categories: ResourceCategory[]): ResourceCategory[] {
    const seen = new Set<string>();
    const normalized = categories.flatMap((category) => {
      const name = category.name.trim();
      const id = category.id.trim();
      if (!id || !name || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name, createdAt: category.createdAt || new Date().toISOString() }];
    });
    if (normalized.length === 0) throw new Error('资源库至少需要保留一个分类');
    const available = new Set(normalized.map((category) => category.id));
    this.state.assets = this.state.assets.map((asset) => asset.isLibraryResource && !available.has(asset.resourceCategoryId ?? '')
      ? { ...asset, resourceCategoryId: normalized[0].id }
      : asset);
    this.state.resourceCategories = normalized;
    this.persist();
    return [...normalized];
  }

  updateResource(assetId: string, update: { name?: string; resourceCategoryId?: string; resourceProcessingPrompt?: string }): AssetRecord {
    const asset = this.state.assets.find((item) => item.id === assetId && item.isLibraryResource);
    if (!asset) throw new Error('资源不存在');
    if (update.resourceCategoryId && !this.state.resourceCategories.some((category) => category.id === update.resourceCategoryId)) {
      throw new Error('目标资源分类不存在');
    }
    if (typeof update.name === 'string' && update.name.trim()) asset.name = update.name.trim();
    if (update.resourceCategoryId) asset.resourceCategoryId = update.resourceCategoryId;
    if (typeof update.resourceProcessingPrompt === 'string' && update.resourceProcessingPrompt.trim()) {
      asset.resourceProcessingPrompt = update.resourceProcessingPrompt.trim();
    }
    this.persist();
    return { ...asset };
  }

  replaceResourceImage(assetId: string, bytes: Buffer, extension: string): AssetRecord {
    const asset = this.state.assets.find((item) => item.id === assetId && item.isLibraryResource);
    if (!asset) throw new Error('要替换的资源不存在');
    if (bytes.length === 0) throw new Error('白底图数据为空，原图未替换');
    const normalizedExtension = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension.toLowerCase())
      ? extension.toLowerCase()
      : '.png';
    const destination = path.join(this.assetDirectory, `${asset.id}-${Date.now()}${normalizedExtension}`);
    fs.writeFileSync(destination, bytes);
    const previousPath = asset.localPath;
    const updated: AssetRecord = {
      ...asset,
      localPath: destination,
      mimeType: mimeFromExtension(destination),
    };
    const replaceReferences = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(replaceReferences);
        return;
      }
      const record = value as Record<string, unknown>;
      if (record.id === assetId && record.kind === 'reference') Object.assign(record, updated);
      Object.values(record).forEach(replaceReferences);
    };
    replaceReferences(this.state);
    this.persist();
    if (path.resolve(previousPath) !== path.resolve(destination)) {
      try { if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath); } catch { /* The new resource file is already authoritative. */ }
    }
    return { ...updated };
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

  getGeneration(recordId: string): GenerationRecord | undefined {
    const record = this.state.generations.find((item) => item.id === recordId);
    return record ? { ...record } : undefined;
  }

  setGenerationReview(recordId: string, reviewStatus: GenerationRecord['reviewStatus'] | null): GenerationRecord {
    const record = this.state.generations.find((item) => item.id === recordId && item.source === 'product-main');
    if (!record || record.status !== 'success') throw new Error('只能审核已生成成功的 3:4 商品主图');
    if (reviewStatus) record.reviewStatus = reviewStatus;
    else delete record.reviewStatus;
    this.persist();
    return { ...record };
  }

  clearProductMainPageRecords(): number {
    const records = this.state.generations.filter((record) => record.source === 'product-main' && Boolean(record.taskSnapshot?.dimensions?.主图编号) && !record.hiddenFromProductMain);
    if (records.some((record) => record.status === 'pending')) throw new Error('商品主图仍在生成，请等待当前任务完成后再清空');
    records.forEach((record) => { record.hiddenFromProductMain = true; });
    if (records.length > 0) this.persist();
    return records.length;
  }

  addGenerationToResource(recordId: string, resourceCategoryId: string): AssetRecord {
    const record = this.state.generations.find((item) => item.id === recordId && item.status === 'success');
    if (!record?.outputPath || !fs.existsSync(record.outputPath)) throw new Error('生成图片不存在或已被删除');
    if (!this.state.resourceCategories.some((category) => category.id === resourceCategoryId)) throw new Error('目标资源分类不存在');
    const existing = this.state.assets.find((asset) => asset.isLibraryResource && asset.sourceGenerationId === recordId);
    if (existing) {
      existing.resourceCategoryId = resourceCategoryId;
      this.persist();
      return { ...existing };
    }
    const imported = this.importAsset(record.outputPath, resourceCategoryId);
    const asset = this.state.assets.find((item) => item.id === imported.id)!;
    asset.sourceGenerationId = recordId;
    this.persist();
    return { ...asset };
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
      productAssets: task.productAssets?.filter((asset) => path.resolve(asset.localPath) !== normalized),
      resourceAssets: task.resourceAssets?.filter((asset) => path.resolve(asset.localPath) !== normalized),
    });
    this.state.draft.tasks = this.state.draft.tasks.map(cleanTask);
    this.state.draft.detailTasks = this.state.draft.detailTasks?.map(cleanTask);
    if (this.state.draft.queueShared.front && path.resolve(this.state.draft.queueShared.front.localPath) === normalized) this.state.draft.queueShared.front = null;
    if (this.state.draft.queueShared.side && path.resolve(this.state.draft.queueShared.side.localPath) === normalized) this.state.draft.queueShared.side = null;
    this.state.draft.queueSharedResources = this.state.draft.queueSharedResources?.filter((asset) => path.resolve(asset.localPath) !== normalized);
    this.state.draft.skuReferenceAssets = this.state.draft.skuReferenceAssets?.filter((asset) => path.resolve(asset.localPath) !== normalized);
    if (this.state.draft.productMainReference && path.resolve(this.state.draft.productMainReference.localPath) === normalized) this.state.draft.productMainReference = null;
    this.state.draft.workbenchNodes = this.state.draft.workbenchNodes?.map((node) => ({
      ...node,
      referenceAssetIds: node.referenceAssetIds.filter((assetId) => this.state.assets.some((asset) => asset.id === assetId)),
    }));
    this.state.generations = this.state.generations.map((record) => record.taskSnapshot
      ? { ...record, taskSnapshot: cleanTask(record.taskSnapshot) }
      : record);
    this.state.templates = this.state.templates.map((template) => ({
      ...template,
      sharedFront: template.sharedFront && path.resolve(template.sharedFront.localPath) === normalized ? null : template.sharedFront,
      sharedSide: template.sharedSide && path.resolve(template.sharedSide.localPath) === normalized ? null : template.sharedSide,
    }));
    this.persist();
    return beforeAssets !== this.state.assets.length || beforeGenerations !== this.state.generations.length;
  }

  moveOutputDirectory(targetDirectory: string): string {
    const oldDirectory = path.resolve(this.outputRoot);
    const target = path.resolve(targetDirectory);
    const comparableOld = process.platform === 'win32' ? oldDirectory.toLowerCase() : oldDirectory;
    const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    if (comparableTarget === comparableOld) return target;
    if (comparableTarget.startsWith(`${comparableOld}${path.sep}`)) throw new Error('新的输出目录不能放在当前输出目录内部');

    fs.mkdirSync(target, { recursive: true });
    const files: string[] = [];
    const pendingDirectories = [oldDirectory];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop()!;
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pendingDirectories.push(entryPath);
        else if (entry.isFile()) files.push(entryPath);
      }
    }

    const copied: string[] = [];
    const destinations = new Map<string, string>();
    const previousRecords = this.state.generations;
    const previousOutputDirectory = this.state.outputDirectory;
    try {
      for (const sourcePath of files) {
        const relativePath = path.relative(oldDirectory, sourcePath);
        const relativeDirectory = path.dirname(relativePath);
        const parsed = path.parse(relativePath);
        const destinationDirectory = path.join(target, relativeDirectory === '.' ? '' : relativeDirectory);
        fs.mkdirSync(destinationDirectory, { recursive: true });
        let destination = path.join(destinationDirectory, parsed.base);
        let suffix = 1;
        while (fs.existsSync(destination)) {
          destination = path.join(destinationDirectory, `${parsed.name} (${suffix})${parsed.ext}`);
          suffix += 1;
        }
        fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
        copied.push(destination);
        destinations.set(path.resolve(sourcePath), destination);
      }
      this.state.generations = this.state.generations.map((record) => {
        if (!record.outputPath) return record;
        const destination = destinations.get(path.resolve(record.outputPath));
        return destination ? { ...record, outputPath: destination } : record;
      });
      this.state.outputDirectory = target;
      this.outputRoot = target;
      this.persist();
      destinations.forEach((_destination, sourcePath) => {
        try { if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath); } catch { /* The migrated copy is already authoritative. */ }
      });
      return target;
    } catch (error) {
      this.state.generations = previousRecords;
      this.state.outputDirectory = previousOutputDirectory;
      this.outputRoot = oldDirectory;
      copied.forEach((filePath) => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* Keep rollback best-effort. */ }
      });
      throw error;
    }
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
