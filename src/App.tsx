import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowRight,
  Archive,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  Copy,
  FolderOpen,
  Image,
  Images,
  Layers3,
  LockKeyhole,
  LoaderCircle,
  ImagePlus,
  Maximize2,
  Paintbrush,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shuffle,
  Sparkles,
  Tag,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import type {
  AppSnapshot,
  AssetRecord,
  DraftState,
  GenerationProgress,
  GenerationRecord,
  GenerationTask,
  PageId,
  PromptTemplate,
  PublicSettings,
  ReferenceSlots,
  TagCategory,
  TagGroup,
  TagSubcategory,
} from './types';
import logoUrl from './assets/logo.png';

const SETTINGS_ACCESS_PASSWORD = 'lilei888';

const DETAIL_SHARED_PROMPT = `请对这张电商详情页进行大幅度重新排版设计，必须产生明显不同于原图的全新布局。

核心要求——布局必须大幅改变：
- 将原图中的图片元素（模特照片、产品展示图）重新裁切、缩放、重新排列到完全不同的位置
- 改变图片之间的大小比例关系，例如原来等大的改为一大两小、原来横排的改为竖排或交错排列
- 改变整体构图方式：如原图是上下结构则改为左右分栏或对角线构图，原图是网格则改为瀑布流或杂志式排版
- 调整留白、间距、分割线的位置和比例
- 可以添加几何装饰元素（色块、线条、圆形框等）来丰富版面层次

内容保持不变：
- 服装款式、颜色、模特姿态与原图一致
- 文字信息保持原文不变
- 整体色调风格保持一致

输出一张高质量的电商详情页设计图，排版风格要与原图有显著差异。`;

const DEFAULT_STAMP_PROMPT = `请基于产品图生成高保真的电商定制材质与光影参考图，供后处理精准贴入客户 Logo。

参考图角色：
- 图1：产品图。必须严格保持产品的款式、颜色、材质、结构、比例以及全部原有图案。

参考图规则：
完整保留产品图中原有的 Logo、文字、人物和装饰图案，不得删除、覆盖、替换或重新排版。API 参考图不得绘制客户 Logo，也不得预留空白贴标块；客户 Logo 只由后处理精准回贴一次。除保持产品自然材质、光影和透视外，产品所有区域都应与图1一致。

参考图要求：
- 保持目标位置附近产品表面的原始透视、曲面、纹理、光照与阴影
- 不改变包体/产品结构，不新增无关装饰，不替换产品主体颜色与版型
- 输出自然、完整且可用于后处理贴标的材质与光影参考图

负面约束：删除原图案、修改原文字、清空贴标区域、预先生成客户 Logo、多余水印、无关文字、重绘产品主体。`;

const LABEL_DIMENSIONS = ['图片类型', '展示方式', '模特类型', '动作', '核心卖点', '适用场景', '背景', '视觉风格', '文案排版'];
const SUPPORTED_ASPECT_RATIOS = ['1:1', '3:4'];
const DEFAULT_IMAGE_MODEL = 'gpt-image-2-async';
const TWO_K_IMAGE_MODEL = 'gpt-image-2-2k-async';

const PAGE_META: Record<PageId, { title: string; subtitle: string }> = {
  studio: { title: 'AI 创作工作台', subtitle: '整理素材、组合参数并批量生成可交付图片' },
  workbench: { title: '生图工作台', subtitle: '选择标签组合提示词，在画布中持续迭代图片' },
  templates: { title: '提示词模板', subtitle: '保存稳定的视觉配方并快速复用' },
  assets: { title: '资产库', subtitle: '集中浏览全部生成图片，并按来源、模型与日期快速筛选' },
  'prompt-tools': { title: 'AI 提示词', subtitle: '从参考图提炼视觉语言，或扩写润色创作想法' },
  stamp: { title: '精准产品贴标', subtitle: '自由定位 Logo，自动去除底色并融合到服装或包包表面' },
  garment3d: { title: '3D服装白底图', subtitle: '将服装参考图生成居中的立体白底产品展示图' },
  'detail-generate': { title: '详情页生成', subtitle: '上传产品图并生成完整的电商详情页图片组' },
  detail: { title: '详情页重排', subtitle: '批量上传详情图，以共享或独立提示词生成全新排版' },
  tags: { title: '标签管理', subtitle: '管理可选择并替换到生图提示词中的标签' },
  batches: { title: '批次记录', subtitle: '追踪每次批量任务的完成情况' },
  settings: { title: '服务设置', subtitle: '配置生图、AI 文字服务与本地工作目录' },
};

function normalizedGenerationRatios(values: string[] | undefined, fallback: string): string[] {
  const selected = (values ?? []).filter((ratio) => SUPPORTED_ASPECT_RATIOS.includes(ratio));
  if (selected.length > 0) return SUPPORTED_ASPECT_RATIOS.filter((ratio) => selected.includes(ratio));
  return [SUPPORTED_ASPECT_RATIOS.includes(fallback) ? fallback : SUPPORTED_ASPECT_RATIOS[0]];
}

function queueRatioQuantity(output: DraftState['queueOutput'], direction: 'front' | 'side', ratio: string): number {
  const quantities = direction === 'front' ? output.frontRatioQuantities : output.sideRatioQuantities;
  const fallback = direction === 'front' ? output.frontQuantity : output.sideQuantity;
  const value = quantities?.[ratio];
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : Math.max(0, Math.floor(fallback));
}

function queueDirectionTotal(output: DraftState['queueOutput'], direction: 'front' | 'side'): number {
  const ratios = direction === 'front'
    ? normalizedGenerationRatios(output.frontRatios, output.frontRatio)
    : normalizedGenerationRatios(output.sideRatios, output.sideRatio);
  return ratios.reduce((sum, ratio) => sum + queueRatioQuantity(output, direction, ratio), 0);
}

function taskRatioQuantity(task: GenerationTask, ratio: string): number {
  const value = task.ratioQuantities?.[ratio];
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : Math.max(1, Math.floor(task.quantity || 1));
}

function modelForResolution(currentModel: string, resolution: string): string {
  if (resolution.toUpperCase() === '2K') return TWO_K_IMAGE_MODEL;
  return currentModel === TWO_K_IMAGE_MODEL ? DEFAULT_IMAGE_MODEL : currentModel;
}

function modelForInvocation(currentModel: string, invocationMode: PublicSettings['invocationMode']): string {
  const normalized = currentModel.trim();
  if (invocationMode === 'sync') return normalized.endsWith('-async') ? normalized.slice(0, -'-async'.length) : normalized;
  if (normalized === 'gpt-image-2') return DEFAULT_IMAGE_MODEL;
  if (normalized === 'gpt-image-2-2k') return TWO_K_IMAGE_MODEL;
  return normalized;
}

function newId(): string {
  return crypto.randomUUID();
}

function composePrompt(
  task: Pick<GenerationTask, 'dimensions' | 'direction' | 'category'>,
  tagGroup?: TagGroup,
  subcategory?: TagSubcategory,
): string {
  const categories = subcategory?.dimensions ?? [];
  const selections = Object.entries(task.dimensions).map(([dimensionName, tagName]) => {
    const dimension = categories.find((item) => item.name === dimensionName);
    const prompt = dimension?.tags.find((tag) => tag.name === tagName)?.prompt || tagName;
    return { dimensionName, prompt };
  }).filter((selection) => selection.prompt.trim());
  const selectionBlock = selections.map((selection) => `${selection.dimensionName}：${selection.prompt}`).join('\n');
  const fallback = `写实商业摄影，产品分类：${task.category}，展示方向：${task.direction}。\n${selectionBlock}\n商品结构、颜色、材质与参考图一致，画面干净真实，无Logo、无水印、无AI瑕疵。`;
  const sourceTemplate = tagGroup?.promptTemplate.trim() || fallback;
  const replacements = new Map<string, string>([
    ['小分类', subcategory?.name ?? task.category],
    ['方向', task.direction],
    ['标签组合', selectionBlock],
    ...selections.map((selection) => [selection.dimensionName, selection.prompt] as [string, string]),
  ]);
  let result = sourceTemplate;
  const directlyUsedDimensions = new Set<string>();
  for (const [key, value] of replacements) {
    const placeholder = `{{${key}}}`;
    if (result.includes(placeholder) && key !== '标签组合') directlyUsedDimensions.add(key);
    result = result.split(placeholder).join(value);
  }
  if (!sourceTemplate.includes('{{标签组合}}')) {
    const remaining = selections.filter((selection) => !directlyUsedDimensions.has(selection.dimensionName));
    if (remaining.length > 0) result += `\n\n${remaining.map((selection) => `${selection.dimensionName}：${selection.prompt}`).join('\n')}`;
  }
  return result.replace(/\{\{[^{}]+\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveRandomDimensions(subcategory: TagSubcategory | undefined, fixed: Record<string, string>): Record<string, string> {
  return Object.fromEntries((subcategory?.dimensions ?? []).filter((dimension) => dimension.tags.length > 0).map((dimension) => {
    const selected = dimension.tags.find((tag) => tag.name === fixed[dimension.name]);
    const random = dimension.tags[Math.floor(Math.random() * dimension.tags.length)];
    return [dimension.name, (selected ?? random).name];
  }));
}

function createTask(index: number, tagGroup?: TagGroup, selectedSubcategory?: TagSubcategory): GenerationTask {
  const subcategory = selectedSubcategory ?? tagGroup?.subcategories[0];
  const dimensions = Object.fromEntries((subcategory?.dimensions ?? []).filter((category) => category.tags.length > 0).map((category) => [category.name, category.tags[0].name]));
  const seed = { dimensions, direction: '正面', category: subcategory?.name ?? tagGroup?.name ?? '自由创作' };
  return {
    id: newId(),
    name: `服装任务 ${index}`,
    tagGroupId: tagGroup?.id ?? '',
    tagSubcategoryId: subcategory?.id ?? '',
    references: { garment: null, side: null, face: null },
    ...seed,
    ratio: '3:4',
    resolution: '1K',
    quantity: 1,
    prompt: composePrompt(seed, tagGroup, subcategory),
  };
}

function emptySnapshot(): AppSnapshot {
  const firstTask = createTask(1);
  return {
    settings: {
      defaultModel: 'gpt-image-2-async',
      invocationMode: 'async',
      hasApiKey: false,
      textModel: 'gpt-5.6-sol',
      hasTextApiKey: false,
    },
    assets: [],
    generations: [],
    batches: [],
    templates: [],
    tagGroups: [],
    draft: { mode: 'batch', batchTag: 'multi', model: 'gpt-image-2-async', tasks: [firstTask], queueShared: { front: null, side: null }, queueOutput: { frontQuantity: 10, sideQuantity: 0, frontRatio: '1:1', sideRatio: '3:4', frontRatios: ['1:1'], sideRatios: ['3:4'] }, queueRandomInitialized: false, detailSharedPrompt: '', detailTasks: [], detailBatchTag: 'relayout', outputRatios: ['3:4'], stampPrompt: '' },
    workspaceDirectory: '',
    outputDirectory: '',
    configFile: '',
  };
}

function formatDate(value: string): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function LocalImage({ asset, path, alt }: { asset?: AssetRecord; path?: string; alt: string }) {
  const [source, setSource] = useState(asset?.preview ?? '');
  const localPath = path ?? asset?.localPath;
  useEffect(() => {
    let active = true;
    const preview = asset?.preview ?? '';
    if (preview) setSource(preview);
    else if (localPath) {
      setSource('');
      window.imageStudio.readImage(localPath).then((value) => active && setSource(value)).catch(() => {
        if (active) setSource('');
        void window.imageStudio.reportMissingImage(localPath);
      });
    } else setSource('');
    return () => {
      active = false;
    };
  }, [localPath, asset?.preview]);
  if (!source) return <div className="image-loading"><LoaderCircle size={18} className="spin" /></div>;
  return <img src={source} alt={alt} onContextMenu={(event) => {
    if (!localPath) return;
    event.preventDefault();
    void window.imageStudio.showImageContextMenu(localPath, asset?.name || `${alt}.png`);
  }} />;
}

function ImagePreviewModal({ record, onClose, onPrevious, onNext }: { record: GenerationRecord; onClose: () => void; onPrevious?: () => void; onNext?: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') onPrevious?.();
      if (event.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, onPrevious, onNext]);

  return (
    <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label={`${record.taskName} 图片预览`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="image-preview-modal">
        <header>
          <div><strong>{record.taskName}</strong><span>{record.batchPrefix} · {record.model} · {record.ratio} · {record.resolution}</span></div>
          <button type="button" className="preview-close-button" onClick={onClose} title="关闭预览"><X size={19} /></button>
        </header>
        <div className="image-preview-stage"><LocalImage path={record.outputPath} alt={record.taskName} />{onPrevious && <button type="button" className="preview-navigation previous" onClick={onPrevious} title="上一张（←）"><ChevronLeft size={26} /></button>}{onNext && <button type="button" className="preview-navigation next" onClick={onNext} title="下一张（→）"><ChevronRight size={26} /></button>}</div>
        <footer><span>{formatDate(record.createdAt)}</span><button type="button" className="secondary" onClick={() => window.imageStudio.revealFile(record.outputPath)}><FolderOpen size={15} />定位文件</button></footer>
      </div>
    </div>
  );
}

function Sidebar({ page, onChange }: { page: PageId; onChange: (page: PageId) => void }) {
  const items: Array<{ id: PageId; label: string; icon: typeof Sparkles }> = [
    { id: 'studio', label: '生成', icon: Sparkles },
    { id: 'workbench', label: '生图台', icon: Paintbrush },
    { id: 'templates', label: '模板', icon: Layers3 },
    { id: 'assets', label: '资产库', icon: Archive },
    { id: 'prompt-tools', label: 'AI提示词', icon: WandSparkles },
    { id: 'stamp', label: '贴标', icon: Tag },
    { id: 'garment3d', label: '3D白底', icon: Boxes },
    { id: 'detail-generate', label: '详情页生成', icon: ImagePlus },
    { id: 'detail', label: '详情页重排', icon: Image },
    { id: 'tags', label: '标签', icon: Tag },
    { id: 'batches', label: '任务', icon: Boxes },
    { id: 'settings', label: '设置', icon: Settings },
  ];
  return (
    <aside className="sidebar">
      <div className="brand-mark" title="苜芬绘图AI"><img src={logoUrl} alt="苜芬绘图AI" /></div>
      <span className="brand-name">苜芬绘图AI</span>
      <nav>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.id}
              className={page === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => onChange(item.id)}
              title={item.label}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-status"><span className="status-dot" />本地</div>
    </aside>
  );
}

function Topbar({
  page,
  settings,
  onSettings,
  mode,
  onMode,
}: {
  page: PageId;
  settings: PublicSettings;
  onSettings: () => void;
  mode: DraftState['mode'];
  onMode: (mode: DraftState['mode']) => void;
}) {
  const meta = PAGE_META[page];
  const usesTextService = page === 'prompt-tools';
  const apiReady = usesTextService ? settings.hasTextApiKey : settings.hasApiKey;
  return (
    <header className="topbar">
      <div className="page-title">
        <h1>{meta.title}</h1>
        <p>{meta.subtitle}</p>
      </div>
      {page === 'studio' && (
        <div className="segmented" aria-label="生成模式">
          <button className={mode === 'single' ? 'selected' : ''} onClick={() => onMode('single')}>单图</button>
          <button className={mode === 'batch' ? 'selected' : ''} onClick={() => onMode('batch')}>多批次</button>
          <button className={mode === 'template' ? 'selected' : ''} onClick={() => onMode('template')}>模板队列</button>
        </div>
      )}
      <button className={apiReady ? 'api-state ready' : 'api-state'} onClick={onSettings}>
        {usesTextService
          ? settings.hasTextApiKey ? `${settings.textModel} 已配置` : '文字服务未配置'
          : settings.hasApiKey ? `${settings.invocationMode === 'async' ? '异步' : '同步'}服务已配置` : '卡密未配置'}
      </button>
    </header>
  );
}

function UploadSlot({
  label,
  asset,
  required,
  onPick,
  onRemove,
}: {
  label: string;
  asset: AssetRecord | null;
  required?: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="upload-field">
      <span>{label}{required && <b> *</b>}</span>
      <button className={asset ? 'upload-slot filled reference-contain' : 'upload-slot'} onClick={onPick} type="button" title={`选择${label}`}>
        {asset ? <LocalImage asset={asset} alt={label} /> : <Plus size={22} />}
      </button>
      {asset && (
        <button type="button" className="remove-image" title={`移除${label}`} onClick={onRemove}><X size={13} /></button>
      )}
    </div>
  );
}

function ChipGroup({ values, value, onChange }: { values: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="chip-row">
      {values.map((item) => (
        <button type="button" className={item === value ? 'chip selected' : 'chip'} onClick={() => onChange(item)} key={item}>
          {item}
        </button>
      ))}
    </div>
  );
}

function MultiChipGroup({ values, selected, onChange }: { values: string[]; selected: string[]; onChange: (value: string[]) => void }) {
  const active = selected.length > 0 ? selected : [values[0]];
  const toggle = (value: string) => {
    const next = active.includes(value) ? active.filter((item) => item !== value) : [...active, value];
    if (next.length > 0) onChange(values.filter((item) => next.includes(item)));
  };
  return <div className="chip-row multi-chip-row">{values.map((value) => <button type="button" key={value} className={active.includes(value) ? 'chip selected' : 'chip'} onClick={() => toggle(value)}>{value}</button>)}</div>;
}

function TaskCard({
  task,
  index,
  canDelete,
  onUpdate,
  onClone,
  onDelete,
  onAssetImported,
  tagGroups,
  outputRatios,
}: {
  task: GenerationTask;
  index: number;
  canDelete: boolean;
  onUpdate: (task: GenerationTask) => void;
  onClone: () => void;
  onDelete: () => void;
  onAssetImported: (asset: AssetRecord) => void;
  tagGroups: TagGroup[];
  outputRatios: string[];
}) {
  const activeGroup = tagGroups.find((group) => group.id === task.tagGroupId) ?? tagGroups[0];
  const activeSubcategory = activeGroup?.subcategories.find((subcategory) => subcategory.id === task.tagSubcategoryId) ?? activeGroup?.subcategories[0];
  const tagCategories = activeSubcategory?.dimensions ?? [];
  const set = <K extends keyof GenerationTask>(key: K, value: GenerationTask[K]) => onUpdate({ ...task, [key]: value });
  const pickReference = async (slot: keyof ReferenceSlots) => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    onAssetImported(asset);
    set('references', { ...task.references, [slot]: asset });
  };
  const updateDimension = (name: string, value: string) => {
    const nextTask = { ...task, dimensions: { ...task.dimensions, [name]: value } };
    onUpdate({ ...nextTask, prompt: composePrompt(nextTask, activeGroup, activeSubcategory) });
  };
  const randomDimension = (name: string) => {
    const values = tagCategories.find((category) => category.name === name)?.tags.map((tag) => tag.name) ?? [];
    const alternatives = values.filter((item) => item !== task.dimensions[name]);
    updateDimension(name, alternatives[Math.floor(Math.random() * alternatives.length)] ?? values[0]);
  };
  const changeGroup = (groupId: string) => {
    const group = tagGroups.find((item) => item.id === groupId);
    if (!group) return;
    const subcategory = group.subcategories[0];
    if (!subcategory) return;
    const dimensions = Object.fromEntries(subcategory.dimensions.filter((dimension) => dimension.tags[0]).map((dimension) => [dimension.name, dimension.tags[0].name]));
    const nextTask = { ...task, tagGroupId: group.id, tagSubcategoryId: subcategory.id, category: subcategory.name, dimensions };
    onUpdate({ ...nextTask, prompt: composePrompt(nextTask, group, subcategory) });
  };
  const changeSubcategory = (subcategoryId: string) => {
    const subcategory = activeGroup?.subcategories.find((item) => item.id === subcategoryId);
    if (!subcategory) return;
    const dimensions = Object.fromEntries(subcategory.dimensions.filter((dimension) => dimension.tags[0]).map((dimension) => [dimension.name, dimension.tags[0].name]));
    const nextTask = { ...task, tagSubcategoryId: subcategory.id, category: subcategory.name, dimensions };
    onUpdate({ ...nextTask, prompt: composePrompt(nextTask, activeGroup, subcategory) });
  };
  return (
    <article className="task-card">
      <div className="task-heading">
        <div>
          <input
            className="task-name"
            value={task.name}
            aria-label={`任务 ${index} 名称`}
            onChange={(event) => set('name', event.target.value)}
          />
          <span className="idle-badge">就绪</span>
        </div>
        <div className="task-actions">
          <button type="button" className="text-button" onClick={onClone}><Copy size={15} />复制</button>
          <button type="button" className="icon-button" onClick={onDelete} disabled={!canDelete} title="删除任务"><Trash2 size={16} /></button>
        </div>
      </div>
      <div className="task-grid">
        <section className="reference-panel" aria-label="参考图片和输出参数">
          <div className="upload-grid">
            <UploadSlot label="服装图" required asset={task.references.garment} onPick={() => pickReference('garment')} onRemove={() => set('references', { ...task.references, garment: null })} />
            <UploadSlot label="侧面服装图" asset={task.references.side} onPick={() => pickReference('side')} onRemove={() => set('references', { ...task.references, side: null })} />
            <UploadSlot label="面部图" asset={task.references.face} onPick={() => pickReference('face')} onRemove={() => set('references', { ...task.references, face: null })} />
          </div>
          <label className="field-label">大分类</label>
          <select className="tag-group-select" value={activeGroup?.id ?? ''} onChange={(event) => changeGroup(event.target.value)}>
            {tagGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <label className="field-label">小分类</label>
          <select className="tag-group-select" value={activeSubcategory?.id ?? ''} onChange={(event) => changeSubcategory(event.target.value)}>
            {activeGroup?.subcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
          </select>
          <label className="field-label">方向</label>
          <ChipGroup values={['正面', '侧面', '背面']} value={task.direction} onChange={(value) => { const nextTask = { ...task, direction: value }; onUpdate({ ...nextTask, prompt: composePrompt(nextTask, activeGroup, activeSubcategory) }); }} />
          <div className="compact-fields task-ratio-quantities">
            {outputRatios.map((ratio) => <label key={ratio}>{ratio} 数量<input type="number" min="0" value={taskRatioQuantity(task, ratio)} onChange={(event) => set('ratioQuantities', { ...task.ratioQuantities, [ratio]: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} /></label>)}
          </div>
        </section>
        <section className="dimension-panel" aria-label="提示词维度">
          <div className="section-caption">标签维度</div>
          {tagCategories.filter((category) => category.tags.length > 0).map((category) => (
            <div className="dimension-row" key={category.id}>
              <ChevronDown size={14} />
              <span>{category.name}</span>
              <select value={task.dimensions[category.name] ?? category.tags[0].name} onChange={(event) => updateDimension(category.name, event.target.value)} aria-label={category.name}>
                {category.tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}
              </select>
              <button type="button" title={`随机${category.name}`} onClick={() => randomDimension(category.name)}><Shuffle size={13} /></button>
            </div>
          ))}
        </section>
        <section className="prompt-panel" aria-label="提示词预览">
          <div className="section-caption">
            <span>提示词预览</span>
            <button type="button" onClick={() => set('prompt', composePrompt(task, activeGroup, activeSubcategory))}><RefreshCw size={14} />重新组合</button>
          </div>
          <textarea value={task.prompt} onChange={(event) => set('prompt', event.target.value)} />
          <div className="prompt-meta"><span>{task.prompt.length} 字</span><span>{Object.values(task.references).filter(Boolean).length}/3 参考图</span></div>
        </section>
      </div>
    </article>
  );
}

function TaskResults({ records }: { records: GenerationRecord[] }) {
  const [preview, setPreview] = useState<GenerationRecord | null>(null);
  const visible = records.slice(0, 12);
  if (visible.length === 0) return null;
  return <>
    <section className="task-results">
      <header><div><Images size={15} /><strong>生成结果</strong><span>{records.filter((record) => record.status === 'success').length} 张图片</span></div></header>
      <div className="task-result-grid">
        {visible.map((record) => record.status === 'pending' ? <article key={record.id} className="task-result-item generation-placeholder"><div className="result-image-wrap"><LoaderCircle size={28} className="spin" /><strong>生成中</strong><span>{record.ratio} · {record.resolution}</span></div></article> : record.status === 'success' ? <article key={record.id} className="task-result-item" onDoubleClick={() => window.imageStudio.revealFile(record.outputPath)}>
          <div className="result-image-wrap"><LocalImage path={record.outputPath} alt={record.taskName} /><button type="button" className="image-expand-button" title="放大预览" onClick={(event) => { event.stopPropagation(); setPreview(record); }}><Maximize2 size={15} /></button></div>
          <footer><span>{record.batchPrefix} · {record.ratio} · {record.resolution}</span><button type="button" onClick={() => window.imageStudio.revealFile(record.outputPath)}>定位文件</button></footer>
        </article> : <article key={record.id} className="task-result-error"><CircleAlert size={16} /><div><strong>生成失败</strong><span>{record.error}</span></div></article>)}
      </div>
    </section>
    {preview && <ImagePreviewModal record={preview} onClose={() => setPreview(null)} />}
  </>;
}

function TemplateQueuePage({
  snapshot,
  draft,
  progress,
  generating,
  onDraft,
  onGenerate,
  onAssets,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  progress: GenerationProgress | null;
  generating: boolean;
  onDraft: (draft: DraftState) => void;
  onGenerate: () => void;
  onAssets: (asset: AssetRecord) => void;
}) {
  const [presetId, setPresetId] = useState('');
  const baseTask = draft.tasks[0] ?? createTask(1, snapshot.tagGroups[0]);
  const activeGroup = snapshot.tagGroups.find((group) => group.id === baseTask.tagGroupId) ?? snapshot.tagGroups[0];
  const activeSubcategory = activeGroup?.subcategories.find((subcategory) => subcategory.id === baseTask.tagSubcategoryId) ?? activeGroup?.subcategories[0];
  const categories = activeSubcategory?.dimensions ?? [];
  const readyTasks = draft.tasks.filter((task) => Boolean(task.references.garment));
  const presetForTask = (task: GenerationTask) => snapshot.templates.find((template) => template.id === task.queuePresetId);
  const outputForTask = (task: GenerationTask) => presetForTask(task)?.queueOutput ?? draft.queueOutput;
  const frontForTask = (task: GenerationTask) => {
    const preset = presetForTask(task);
    return preset ? preset.sharedFront ?? null : draft.queueShared.front;
  };
  const total = readyTasks.reduce((sum, task) => {
    const output = outputForTask(task);
    return sum + queueDirectionTotal(output, 'front') + queueDirectionTotal(output, 'side');
  }, 0);
  const missingFaceCount = readyTasks.filter((task) => !frontForTask(task)).length;
  const pendingCount = snapshot.generations.filter((record) => record.source === 'template' && record.status === 'pending').length;
  const generationBusy = generating || pendingCount > 0;

  const updateTasks = (updater: (task: GenerationTask, index: number) => GenerationTask) => {
    onDraft({ ...draft, tasks: draft.tasks.map(updater) });
  };
  const createQueueTask = (index: number, garment: AssetRecord | null = null, side: AssetRecord | null = null, name?: string): GenerationTask => ({
    ...createTask(index, activeGroup, activeSubcategory),
    name: name || garment?.name.replace(/\.[^.]+$/, '') || `服装款式 ${index}`,
    tagGroupId: activeGroup?.id ?? baseTask.tagGroupId,
    tagSubcategoryId: activeSubcategory?.id ?? baseTask.tagSubcategoryId,
    category: activeSubcategory?.name ?? baseTask.category,
    dimensions: { ...baseTask.dimensions },
    prompt: baseTask.prompt,
    ratio: baseTask.ratio,
    resolution: baseTask.resolution,
    quantity: baseTask.quantity,
    queuePresetId: '',
    references: { garment, side, face: null },
  });
  const pickShared = async (slot: 'front' | 'side') => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    onAssets(asset);
    onDraft({ ...draft, queueShared: { ...draft.queueShared, [slot]: asset } });
  };
  const pickTaskReference = async (taskId: string, slot: 'garment' | 'side') => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    onAssets(asset);
    updateTasks((task) => task.id === taskId ? { ...task, references: { ...task.references, [slot]: asset } } : task);
  };
  const batchAdd = async () => {
    const assets = await window.imageStudio.pickImages();
    if (assets.length === 0) return;
    assets.forEach(onAssets);
    const current = draft.tasks.length === 1 && !draft.tasks[0].references.garment && !draft.tasks[0].references.side ? [] : draft.tasks;
    const grouped = new Map<string, { name: string; garment: AssetRecord | null; side: AssetRecord | null }>();
    for (const asset of assets) {
      const stem = asset.name.replace(/\.[^.]+$/, '');
      const isSide = /(?:[-_\s]?)(侧面|侧|side)$/i.test(stem);
      const cleanName = stem.replace(/(?:[-_\s]?)(正面|正|front|侧面|侧|side)$/i, '').trim() || stem;
      const key = cleanName.toLowerCase();
      const pair = grouped.get(key) ?? { name: cleanName, garment: null, side: null };
      if (isSide) pair.side = asset;
      else pair.garment = asset;
      grouped.set(key, pair);
    }
    const additions = Array.from(grouped.values()).map((pair, index) => createQueueTask(current.length + index + 1, pair.garment, pair.side, pair.name));
    onDraft({ ...draft, tasks: [...current, ...additions] });
  };
  const changeGroup = (group: TagGroup) => {
    const subcategory = group.subcategories[0];
    if (!subcategory) return;
    const dimensions: Record<string, string> = {};
    const seed = { ...baseTask, category: subcategory.name, tagGroupId: group.id, tagSubcategoryId: subcategory.id, dimensions };
    const prompt = composePrompt(seed, group, subcategory);
    updateTasks((task) => ({ ...task, category: subcategory.name, tagGroupId: group.id, tagSubcategoryId: subcategory.id, dimensions: { ...dimensions }, prompt }));
  };
  const changeSubcategory = (subcategory: TagSubcategory) => {
    const dimensions: Record<string, string> = {};
    const seed = { ...baseTask, category: subcategory.name, tagSubcategoryId: subcategory.id, dimensions };
    const prompt = composePrompt(seed, activeGroup, subcategory);
    updateTasks((task) => ({ ...task, category: subcategory.name, tagSubcategoryId: subcategory.id, dimensions: { ...dimensions }, prompt }));
  };
  const selectDimension = (category: TagCategory, tagName: string) => {
    const dimensions = { ...baseTask.dimensions };
    if (tagName) dimensions[category.name] = tagName;
    else delete dimensions[category.name];
    const next = { ...baseTask, dimensions };
    const prompt = composePrompt(next, activeGroup, activeSubcategory);
    updateTasks((task) => ({ ...task, dimensions: { ...dimensions }, prompt }));
  };
  const setPromptForAll = (prompt: string) => updateTasks((task) => ({ ...task, prompt }));
  const setOutputForAll = (key: 'resolution', value: string) => onDraft({ ...draft, model: modelForResolution(draft.model, value), tasks: draft.tasks.map((task) => ({ ...task, [key]: value, model: modelForResolution(task.model || draft.model, value) })) });
  const setQueueOutput = <K extends keyof DraftState['queueOutput']>(key: K, value: DraftState['queueOutput'][K]) => onDraft({ ...draft, queueOutput: { ...draft.queueOutput, [key]: value } });
  const loadPreset = () => {
    const template = snapshot.templates.find((item) => item.id === presetId);
    if (!template) return;
    const group = snapshot.tagGroups.find((item) => item.id === template.tagGroupId) ?? activeGroup;
    const subcategory = group?.subcategories.find((item) => item.id === template.tagSubcategoryId) ?? activeSubcategory;
    const dimensions = template.dimensions ?? baseTask.dimensions;
    const tasks = draft.tasks.map((task) => ({
      ...task,
      tagGroupId: group?.id ?? task.tagGroupId,
      tagSubcategoryId: subcategory?.id ?? task.tagSubcategoryId,
      category: subcategory?.name ?? task.category,
      dimensions: { ...dimensions },
      prompt: template.prompt,
      resolution: template.resolution ?? task.resolution,
    }));
    onDraft({
      ...draft,
      mode: 'template',
      model: modelForResolution(template.model ?? draft.model, template.resolution ?? baseTask.resolution),
      batchTag: template.batchTag ?? draft.batchTag,
      queueOutput: template.queueOutput ? { ...template.queueOutput } : draft.queueOutput,
      queueShared: {
        front: template.sharedFront ?? draft.queueShared.front,
        side: template.sharedSide ?? draft.queueShared.side,
      },
      queueRandomInitialized: true,
      tasks,
    });
  };
  const rebuildPrompt = () => setPromptForAll(composePrompt(baseTask, activeGroup, activeSubcategory));
  const clearQueue = () => onDraft({ ...draft, tasks: [createQueueTask(1)] });

  return (
    <div className="template-queue-shell">
      <main className="template-queue-main">
        <section className="queue-card queue-shared-card">
          <header><div><h2>共享模特参考图</h2><p>正面图会应用到所有服装；侧脸图可选，用于统一人物形象。</p></div></header>
          <div className="queue-shared-uploads">
            <UploadSlot label="共享正面图" required asset={draft.queueShared.front} onPick={() => pickShared('front')} onRemove={() => onDraft({ ...draft, queueShared: { ...draft.queueShared, front: null } })} />
            <UploadSlot label="共享侧脸图" asset={draft.queueShared.side} onPick={() => pickShared('side')} onRemove={() => onDraft({ ...draft, queueShared: { ...draft.queueShared, side: null } })} />
            <p>上传一张清晰正面模特图。生成时会自动与每款服装参考图组合。</p>
          </div>
        </section>

        <section className="queue-card queue-progress-card">
          <div><strong>{generating ? '提交中' : progress && progress.completed < progress.total ? '后台生成中' : progress?.completed ? '已完成' : '未开始'}</strong><span>{progress?.completed ?? 0}/{progress?.total ?? total} 已完成 · {progress?.failed ?? 0} 张失败</span></div>
          <div className="progress-track"><span style={{ width: `${((progress?.completed ?? 0) / Math.max(1, progress?.total ?? total)) * 100}%` }} /></div>
        </section>

        <section className="queue-card queue-tags-card">
          <header><div><h2>标签选择</h2><p>手动选择的标签会固定使用；未选择的维度会为每一张图片分别随机。</p></div></header>
          <div className="queue-tag-sections">
            {categories.filter((category) => category.tags.length > 0).map((category) => (
              <section key={category.id} className="queue-tag-section">
                <header><strong><ChevronDown size={13} />{category.name}</strong><button type="button" className={!baseTask.dimensions[category.name] ? 'selected random-active' : ''} onClick={() => selectDimension(category, '')}><Shuffle size={12} />随机</button></header>
                <div>{category.tags.map((tag) => <button type="button" key={tag.id} className={baseTask.dimensions[category.name] === tag.name ? 'selected' : ''} onClick={() => selectDimension(category, baseTask.dimensions[category.name] === tag.name ? '' : tag.name)} title={tag.prompt}>{tag.name}</button>)}</div>
              </section>
            ))}
          </div>
        </section>

        <section className="queue-card queue-prompt-card">
          <header><div><h2>主体提示词</h2><p>自动同步到队列内全部款式</p></div><button type="button" className="text-button" onClick={rebuildPrompt}><RefreshCw size={14} />重新生成</button></header>
          <textarea value={baseTask.prompt} onChange={(event) => setPromptForAll(event.target.value)} />
        </section>

        <section className="queue-card garment-queue-card">
          <header><div><h2>服装队列</h2><p>{readyTasks.length} 款 · 文件名可作为款式名称继续编辑</p></div><div><button type="button" className="secondary" onClick={batchAdd}><Images size={15} />批量添加服装图</button><button type="button" className="secondary" onClick={() => onDraft({ ...draft, tasks: [...draft.tasks, createQueueTask(draft.tasks.length + 1)] })}><Plus size={15} />新增空款</button><button type="button" className="text-button danger-text" onClick={clearQueue}><Trash2 size={14} />清空</button></div></header>
          <div className="garment-queue-list">
            {draft.tasks.map((task, index) => {
              const itemPreset = presetForTask(task);
              const itemOutput = outputForTask(task);
              const itemHasFace = Boolean(frontForTask(task));
              return <div className="garment-queue-block" key={task.id}>
                <article className="garment-queue-item">
                  <div className="garment-queue-index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="garment-queue-uploads">
                    <UploadSlot label="服装参考图" required asset={task.references.garment} onPick={() => pickTaskReference(task.id, 'garment')} onRemove={() => updateTasks((item) => item.id === task.id ? { ...item, references: { ...item.references, garment: null } } : item)} />
                    <UploadSlot label="侧面服装图" asset={task.references.side} onPick={() => pickTaskReference(task.id, 'side')} onRemove={() => updateTasks((item) => item.id === task.id ? { ...item, references: { ...item.references, side: null } } : item)} />
                  </div>
                  <label>款式名称<input value={task.name} onChange={(event) => updateTasks((item) => item.id === task.id ? { ...item, name: event.target.value } : item)} /></label>
                  <button type="button" className="icon-button" title="删除款式" onClick={() => onDraft({ ...draft, tasks: draft.tasks.filter((item) => item.id !== task.id) })}><Trash2 size={15} /></button>
                </article>
                <div className="garment-item-config">
                  <div className="garment-config-mode">
                    <span>生成设置</span>
                    <button type="button" className={!task.queuePresetId ? 'selected' : ''} onClick={() => updateTasks((item) => item.id === task.id ? { ...item, queuePresetId: '' } : item)}>跟随共享</button>
                    <button type="button" className={task.queuePresetId ? 'selected' : ''} disabled={snapshot.templates.length === 0} onClick={() => updateTasks((item) => item.id === task.id ? { ...item, queuePresetId: item.queuePresetId || snapshot.templates[0]?.id || '' } : item)}>独立预设</button>
                  </div>
                  {task.queuePresetId && <label className="garment-preset-select">选择预设<select value={task.queuePresetId} onChange={(event) => updateTasks((item) => item.id === task.id ? { ...item, queuePresetId: event.target.value } : item)}>{snapshot.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}
                  <div className="garment-config-summary">
                    <span className={itemHasFace ? 'ready' : 'missing'}>{itemHasFace ? '人脸已就绪' : '缺少正面人脸'}</span>
                    <span>{itemPreset ? itemPreset.name : '共享配置'}</span>
                    <span>计划 {queueDirectionTotal(itemOutput, 'front') + queueDirectionTotal(itemOutput, 'side')} 张</span>
                    <span>正 {queueDirectionTotal(itemOutput, 'front')} / 侧 {queueDirectionTotal(itemOutput, 'side')}</span>
                    <span>{itemPreset?.resolution ?? task.resolution}</span>
                  </div>
                </div>
                <TaskResults records={snapshot.generations.filter((record) => record.taskId === task.id)} />
              </div>;
            })}
          </div>
        </section>
      </main>

      <aside className="template-queue-settings">
        <section><h3>从预设加载</h3><div className="queue-preset-row"><select value={presetId} onChange={(event) => setPresetId(event.target.value)}><option value="">选择预设</option>{snapshot.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select><button type="button" className="secondary" disabled={!presetId} onClick={loadPreset}>加载</button></div><small>预设可在左侧“模板”页面新增和编辑。</small></section>
        <section><h3>大分类</h3><div className="queue-setting-chips wrap">{snapshot.tagGroups.map((group) => <button type="button" key={group.id} className={activeGroup?.id === group.id ? 'selected' : ''} onClick={() => changeGroup(group)}>{group.name}</button>)}</div></section>
        <section><h3>小分类</h3><div className="queue-setting-chips wrap">{activeGroup?.subcategories.map((subcategory) => <button type="button" key={subcategory.id} className={activeSubcategory?.id === subcategory.id ? 'selected' : ''} onClick={() => changeSubcategory(subcategory)}>{subcategory.name}</button>)}</div></section>
        <section><h3>出图质量</h3><ChipGroup values={['1K', '2K']} value={baseTask.resolution} onChange={(value) => setOutputForAll('resolution', value)} /></section>
        <section><h3>正面比例与数量</h3><MultiChipGroup values={SUPPORTED_ASPECT_RATIOS} selected={normalizedGenerationRatios(draft.queueOutput.frontRatios, draft.queueOutput.frontRatio)} onChange={(values) => onDraft({ ...draft, queueOutput: { ...draft.queueOutput, frontRatios: values, frontRatio: values[0] } })} /><div className="ratio-quantity-grid">{normalizedGenerationRatios(draft.queueOutput.frontRatios, draft.queueOutput.frontRatio).map((ratio) => <label key={ratio}><span>{ratio}</span><input type="number" min="0" value={queueRatioQuantity(draft.queueOutput, 'front', ratio)} onChange={(event) => onDraft({ ...draft, queueOutput: { ...draft.queueOutput, frontRatioQuantities: { ...draft.queueOutput.frontRatioQuantities, [ratio]: Math.max(0, Math.floor(Number(event.target.value) || 0)) } } })} /></label>)}</div></section>
        <section><h3>侧面比例与数量</h3><MultiChipGroup values={SUPPORTED_ASPECT_RATIOS} selected={normalizedGenerationRatios(draft.queueOutput.sideRatios, draft.queueOutput.sideRatio)} onChange={(values) => onDraft({ ...draft, queueOutput: { ...draft.queueOutput, sideRatios: values, sideRatio: values[0] } })} /><div className="ratio-quantity-grid">{normalizedGenerationRatios(draft.queueOutput.sideRatios, draft.queueOutput.sideRatio).map((ratio) => <label key={ratio}><span>{ratio}</span><input type="number" min="0" value={queueRatioQuantity(draft.queueOutput, 'side', ratio)} onChange={(event) => onDraft({ ...draft, queueOutput: { ...draft.queueOutput, sideRatioQuantities: { ...draft.queueOutput.sideRatioQuantities, [ratio]: Math.max(0, Math.floor(Number(event.target.value) || 0)) } } })} /></label>)}</div></section>
        <section><h3>生成模型</h3><div className="queue-model-options"><button type="button" className="selected">{draft.model}</button></div><input value={draft.model} onChange={(event) => onDraft({ ...draft, model: event.target.value })} /></section>
        <section><h3>批次标签</h3><input value={draft.batchTag} onChange={(event) => onDraft({ ...draft, batchTag: event.target.value })} /></section>
        <button type="button" className="primary queue-start-button" disabled={generationBusy || readyTasks.length === 0 || missingFaceCount > 0 || total === 0} onClick={onGenerate}>{generationBusy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{generating ? '提交中' : generationBusy ? `模板队列生成中（剩余 ${pendingCount} 张）` : `开始生成 ${total} 张`}</button>
        {missingFaceCount > 0 && <p className="queue-required-tip">有 {missingFaceCount} 款缺少共享或独立预设的正面人脸图</p>}
      </aside>
    </div>
  );
}

function StudioPage({
  snapshot,
  draft,
  progress,
  generating,
  onDraft,
  onGenerate,
  onAssets,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  progress: GenerationProgress | null;
  generating: boolean;
  onDraft: (draft: DraftState) => void;
  onGenerate: () => void;
  onAssets: (asset: AssetRecord) => void;
}) {
  if (draft.mode === 'template') {
    return <TemplateQueuePage snapshot={snapshot} draft={draft} progress={progress} generating={generating} onDraft={onDraft} onGenerate={onGenerate} onAssets={onAssets} />;
  }
  const visibleTasks = draft.mode === 'single' ? draft.tasks.slice(0, 1) : draft.tasks;
  const outputRatios = normalizedGenerationRatios(draft.outputRatios, visibleTasks[0]?.ratio ?? '3:4');
  const total = visibleTasks.reduce((sum, task) => sum + outputRatios.reduce((ratioSum, ratio) => ratioSum + taskRatioQuantity(task, ratio), 0), 0);
  const currentSource = draft.mode === 'single' ? 'single' : 'batch';
  const pendingCount = snapshot.generations.filter((record) => record.source === currentSource && record.status === 'pending').length;
  const generationBusy = generating || pendingCount > 0;
  const updateTask = (id: string, task: GenerationTask) => onDraft({ ...draft, tasks: draft.tasks.map((item) => item.id === id ? task : item) });
  const addTask = () => onDraft({ ...draft, tasks: [...draft.tasks, createTask(draft.tasks.length + 1, snapshot.tagGroups[0])] });
  const cloneTask = (task: GenerationTask) => onDraft({ ...draft, tasks: [...draft.tasks, { ...task, id: newId(), name: `${task.name} 副本` }] });
  const removeTask = (id: string) => onDraft({ ...draft, tasks: draft.tasks.filter((task) => task.id !== id) });
  const updateAllOutput = (key: 'resolution', value: string) => onDraft({ ...draft, model: modelForResolution(draft.model, value), tasks: draft.tasks.map((task) => ({ ...task, [key]: value, model: modelForResolution(task.model || draft.model, value) })) });
  const updateOutputRatios = (ratios: string[]) => onDraft({ ...draft, outputRatios: ratios, tasks: draft.tasks.map((task) => ({ ...task, ratio: ratios[0] ?? task.ratio })) });
  const modelPresets = Array.from(new Set([snapshot.settings.defaultModel, 'gpt-image-2-async'])).filter(Boolean);
  return (
    <div className="studio-shell">
      <main className="studio-main">
        <section className="history-strip">
          <div><Images size={16} /><span><strong>多条历史预览</strong><small>最近 {snapshot.batches.length} 个批次 · {snapshot.generations.filter((item) => item.status === 'success').length} 张</small></span></div>
          <button type="button" className="text-button" onClick={() => window.imageStudio.openOutputDirectory()}><FolderOpen size={15} />打开目录</button>
        </section>
        {progress && (
          <section className="progress-strip">
            <div className="progress-copy"><LoaderCircle size={17} className={generating ? 'spin' : ''} /><span>批次进度 {progress.completed}/{progress.total}</span><small>成功 {progress.succeeded} · 失败 {progress.failed}</small></div>
            <div className="progress-track"><span style={{ width: `${(progress.completed / Math.max(1, progress.total)) * 100}%` }} /></div>
          </section>
        )}
        <div className="task-list">
          {visibleTasks.map((task, index) => (
            <div className="task-block" key={task.id}>
              <TaskCard
                task={task}
                index={index + 1}
                canDelete={draft.tasks.length > 1}
                onUpdate={(next) => updateTask(task.id, next)}
                onClone={() => cloneTask(task)}
                onDelete={() => removeTask(task.id)}
                onAssetImported={onAssets}
                tagGroups={snapshot.tagGroups}
                outputRatios={outputRatios}
              />
              <TaskResults records={snapshot.generations.filter((record) => record.taskId === task.id)} />
            </div>
          ))}
        </div>
      </main>
      <aside className="batch-panel">
        <h2>批次设置</h2>
        <label>批次标签<input value={draft.batchTag} onChange={(event) => onDraft({ ...draft, batchTag: event.target.value })} /></label>
        <div className="field-label">生成模型</div>
        <div className="model-options">
          {modelPresets.map((model) => <button type="button" key={model} className={draft.model === model ? 'chip selected' : 'chip'} onClick={() => onDraft({ ...draft, model })}>{model}</button>)}
        </div>
        <label>自定义模型<input value={draft.model} onChange={(event) => onDraft({ ...draft, model: event.target.value })} /></label>
        <div className="field-label">生图比例</div>
        <MultiChipGroup values={SUPPORTED_ASPECT_RATIOS} selected={outputRatios} onChange={updateOutputRatios} />
        <small className="multi-ratio-tip">已选 {outputRatios.length} 个比例，每个任务会分别生成全部所选比例。</small>
        <div className="field-label output-resolution-label">输出分辨率</div>
        <ChipGroup values={['1K', '2K']} value={visibleTasks[0]?.resolution ?? '1K'} onChange={(value) => updateAllOutput('resolution', value)} />
        {draft.mode === 'batch' && <button type="button" className="secondary wide" onClick={addTask}><Plus size={16} />新增任务</button>}
        <button type="button" className="primary wide" disabled={generationBusy || total === 0} onClick={onGenerate}>
          {generationBusy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}
          {generating ? '提交中' : generationBusy ? `${draft.mode === 'single' ? '单图' : '多图'}生成中（剩余 ${pendingCount} 张）` : `开始全部生成（${total} 张）`}
        </button>
        <div className="batch-summary">
          <span>任务</span><strong>{visibleTasks.length}</strong>
          <span>预计图片</span><strong>{total}</strong>
          <span>存储</span><strong>本地</strong>
        </div>
      </aside>
    </div>
  );
}

function buildWorkbenchPrompt(group: TagGroup | undefined, subcategory: TagSubcategory | undefined, selections: Record<string, string>): string {
  return composePrompt({ dimensions: selections, direction: '正面', category: subcategory?.name ?? group?.name ?? '自由创作' }, group, subcategory);
}

function WorkbenchPage({
  snapshot,
  draft,
  onDraft,
  onRefresh,
  onOpenSettings,
  onNotice,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  onDraft: (draft: DraftState) => void;
  onRefresh: () => Promise<AppSnapshot>;
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
}) {
  const groups = snapshot.tagGroups;
  const [selectedGroupId, setSelectedGroupId] = useState(draft.workbenchGroupId || groups[0]?.id || '');
  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState(draft.workbenchSubcategoryId || activeGroup?.subcategories[0]?.id || '');
  const activeSubcategory = activeGroup?.subcategories.find((subcategory) => subcategory.id === selectedSubcategoryId) ?? activeGroup?.subcategories[0];
  const categories = activeSubcategory?.dimensions ?? [];
  const [selections, setSelections] = useState<Record<string, string>>(() => Object.keys(draft.workbenchSelections ?? {}).length > 0
    ? { ...draft.workbenchSelections }
    : Object.fromEntries(categories.filter((category) => category.tags[0]).map((category) => [category.name, category.tags[0].name])));
  const [prompt, setPrompt] = useState(() => draft.workbenchFreeMode ? (draft.workbenchPrompt ?? '') : (draft.workbenchPrompt || buildWorkbenchPrompt(activeGroup, activeSubcategory, selections)));
  const [references, setReferences] = useState<Array<{ asset: AssetRecord; x: number; y: number; linked: boolean }>>([]);
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1K');
  const [running, setRunning] = useState(false);
  const [localProgress, setLocalProgress] = useState<GenerationProgress | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [showResult, setShowResult] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [previewRecord, setPreviewRecord] = useState<GenerationRecord | null>(null);
  const [freeMode, setFreeMode] = useState(Boolean(draft.workbenchFreeMode));
  const referenceDrag = useRef<null | { id: string; startX: number; startY: number; x: number; y: number }>(null);

  const workbenchRecords = snapshot.generations.filter((record) => record.source === 'workbench').slice(0, 12);
  const iterationRecords = workbenchRecords.filter((record) => record.status === 'success');
  const pendingRecord = workbenchRecords.find((record) => record.status === 'pending');
  const selectedRecord = showResult ? iterationRecords.find((record) => record.id === selectedRecordId) ?? iterationRecords[0] : undefined;
  const updateWorkbenchDraft = (update: Partial<DraftState>) => onDraft({ ...draft, ...update });

  useEffect(() => {
    if (freeMode) return;
    const next = Object.fromEntries(categories.filter((category) => category.tags[0]).map((category) => {
      const existing = category.tags.some((tag) => tag.name === selections[category.name]) ? selections[category.name] : category.tags[0].name;
      return [category.name, existing];
    }));
    const nextPrompt = buildWorkbenchPrompt(activeGroup, activeSubcategory, next);
    setSelections(next);
    setPrompt(nextPrompt);
    updateWorkbenchDraft({ workbenchGroupId: activeGroup?.id ?? '', workbenchSubcategoryId: activeSubcategory?.id ?? '', workbenchSelections: next, workbenchPrompt: nextPrompt });
  }, [activeSubcategory?.id, freeMode]);

  useEffect(() => window.imageStudio.onGenerationProgress((progress) => {
    if (running) setLocalProgress(progress);
  }), [running]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = referenceDrag.current;
      if (!drag) return;
      setReferences((current) => current.map((item) => item.asset.id === drag.id ? {
        ...item,
        x: Math.max(0, Math.min(980, drag.x + event.clientX - drag.startX)),
        y: Math.max(0, Math.min(760, drag.y + event.clientY - drag.startY)),
      } : item));
    };
    const stop = () => { referenceDrag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  }, []);

  const selectTag = (category: TagCategory, tagName: string) => {
    if (freeMode) return;
    const next = { ...selections, [category.name]: tagName };
    const nextPrompt = buildWorkbenchPrompt(activeGroup, activeSubcategory, next);
    setSelections(next);
    setPrompt(nextPrompt);
    updateWorkbenchDraft({ workbenchSelections: next, workbenchPrompt: nextPrompt });
  };

  const pickReferences = async () => {
    const assets = await window.imageStudio.pickImages();
    if (assets.length === 0) return;
    setReferences((current) => {
      const existing = new Set(current.map((item) => item.asset.id));
      const additions = assets.filter((asset) => !existing.has(asset.id)).map((asset, index) => ({
        asset, x: 22 + ((current.length + index) % 4) * 148, y: 550 + Math.floor((current.length + index) / 4) * 142, linked: true,
      }));
      return [...current, ...additions].slice(0, 9);
    });
  };

  const generate = async (referenceOverride?: AssetRecord) => {
    if (!prompt.trim()) {
      onNotice('提示词不能为空');
      return;
    }
    if (!snapshot.settings.hasApiKey) {
      onNotice('请先配置卡密');
      onOpenSettings();
      return;
    }
    await window.imageStudio.saveDraft({ ...draft, workbenchFreeMode: freeMode, workbenchGroupId: activeGroup?.id ?? '', workbenchSubcategoryId: activeSubcategory?.id ?? '', workbenchSelections: selections, workbenchPrompt: prompt });
    const activeReferences = [...references.filter((item) => item.linked).map((item) => item.asset)];
    if (referenceOverride && !activeReferences.some((asset) => asset.id === referenceOverride.id)) activeReferences.push(referenceOverride);
    const slots = [activeReferences[0] ?? null, activeReferences[1] ?? null, activeReferences[2] ?? null];
    const task: GenerationTask = {
      id: newId(),
      name: `生图台迭代 ${iterationRecords.length + 1}`,
      tagGroupId: activeGroup?.id ?? '',
      tagSubcategoryId: activeSubcategory?.id ?? '',
      references: { garment: slots[0], side: slots[1], face: slots[2] },
      detailAssets: activeReferences.slice(3),
      dimensions: selections,
      direction: '正面',
      category: freeMode ? '自由生图' : activeSubcategory?.name ?? activeGroup?.name ?? '自由创作',
      ratio,
      resolution,
      quantity: 1,
      prompt: prompt.trim(),
    };
    setRunning(true);
    setLocalProgress({ batchId: '', completed: 0, total: 1, succeeded: 0, failed: 0 });
    try {
      await window.imageStudio.startGeneration({
        batchTag: `workbench-${Date.now()}`,
        model,
        source: 'workbench',
        tasks: [task],
      });
      await onRefresh();
      setShowResult(true);
      onNotice('任务已提交，正在后台异步生成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '生成失败');
    } finally {
      setRunning(false);
    }
  };

  const iterate = async () => {
    if (!selectedRecord) return;
    try {
      const asset = await window.imageStudio.useGenerationAsReference(selectedRecord.outputPath);
       setReferences((current) => [...current.filter((item) => item.asset.id !== asset.id), { asset, x: 22, y: 550, linked: true }].slice(-9));
       await generate(asset);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法读取迭代参考图');
      setRunning(false);
    }
  };

  return (
    <div className="workbench-shell">
      <aside className="recipe-panel">
        <div className="recipe-heading">
          <div><h2>创作配方</h2><p>{Object.keys(selections).length} 个维度已选择</p></div>
          <span>自动替换</span>
        </div>
        <div className="recipe-options-scroll">
          <button type="button" className={freeMode ? 'secondary wide selected recipe-free-mode' : 'secondary wide recipe-free-mode'} onClick={() => {
            const nextFreeMode = !freeMode;
            const nextPrompt = nextFreeMode ? '' : buildWorkbenchPrompt(activeGroup, activeSubcategory, {});
            setFreeMode(nextFreeMode);
            setSelections({});
            setPrompt(nextPrompt);
            updateWorkbenchDraft({ workbenchFreeMode: nextFreeMode, workbenchGroupId: activeGroup?.id ?? '', workbenchSubcategoryId: activeSubcategory?.id ?? '', workbenchSelections: {}, workbenchPrompt: nextPrompt });
          }}><WandSparkles size={15} />自由生图固定模式</button>
          <div className={freeMode ? 'recipe-groups disabled-selector' : 'recipe-groups'}>
            {groups.map((group) => <button type="button" key={group.id} className={!freeMode && activeGroup?.id === group.id ? 'selected' : ''} disabled={freeMode} onClick={() => { const subcategoryId = group.subcategories[0]?.id ?? ''; setSelectedGroupId(group.id); setSelectedSubcategoryId(subcategoryId); updateWorkbenchDraft({ workbenchGroupId: group.id, workbenchSubcategoryId: subcategoryId }); }}>{group.name}</button>)}
          </div>
          <div className={freeMode ? 'recipe-subcategories disabled-selector' : 'recipe-subcategories'}>
            {activeGroup?.subcategories.map((subcategory) => <button type="button" key={subcategory.id} className={!freeMode && activeSubcategory?.id === subcategory.id ? 'selected' : ''} disabled={freeMode} onClick={() => { setSelectedSubcategoryId(subcategory.id); updateWorkbenchDraft({ workbenchSubcategoryId: subcategory.id }); }}>{subcategory.name}</button>)}
          </div>
          <div className={freeMode ? 'recipe-scroll disabled-tags' : 'recipe-scroll'}>
            {categories.map((category) => (
              <section className="recipe-category" key={category.id}>
                <header><strong>{category.name}</strong><span>{selections[category.name] || '未选择'}</span></header>
                <div className="recipe-tags">
                  {category.tags.map((tag) => (
                    <button type="button" key={tag.id} className={selections[category.name] === tag.name ? 'selected' : ''} onClick={() => selectTag(category, tag.name)} title={tag.prompt}>
                      {tag.name}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <button type="button" className="primary recipe-generate" onClick={() => generate()} disabled={running}>
          {running ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}
          {running ? '提交中' : '生成 1 张'}
        </button>
      </aside>

      <main className="canvas-column">
        <div className="canvas-toolbar">
          <div>
            <button type="button" className="secondary" onClick={pickReferences}><ImagePlus size={16} />添加参考图</button>
            {references.length > 0 && <span className="reference-ready"><Check size={13} />已上传 {references.length} 张 · 已连接 {references.filter((item) => item.linked).length} 张</span>}
          </div>
          <div>
            <button type="button" className="icon-button" title="缩小画布" onClick={() => setZoom((value) => Math.max(0.75, value - 0.125))}>-</button>
            <span className="zoom-value">{Math.round(zoom * 100)}%</span>
            <button type="button" className="icon-button" title="放大画布" onClick={() => setZoom((value) => Math.min(1.25, value + 0.125))}>+</button>
            <button type="button" className="secondary" onClick={() => { setReferences([]); setSelectedRecordId(''); setShowResult(false); }}><RefreshCw size={15} />清空画布</button>
          </div>
        </div>
        <div className="iteration-canvas">
          <div className="canvas-stage" style={{ transform: `scale(${zoom})` }}>
            <section className="canvas-node prompt-node">
              <header><span>提示词</span><small>与左侧标签同步</small></header>
              <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); updateWorkbenchDraft({ workbenchPrompt: event.target.value }); }} />
              <div className="node-settings">
                <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
                <label>画幅<select value={ratio} onChange={(event) => setRatio(event.target.value)}><option>1:1</option><option>3:4</option><option>9:16</option></select></label>
                <label>清晰度<select value={resolution} onChange={(event) => { const value = event.target.value; setResolution(value); setModel((current) => modelForResolution(current, value)); }}><option>1K</option><option>2K</option></select></label>
              </div>
            </section>

            {references.map((item) => <div key={item.asset.id} className={item.linked ? 'reference-node linked' : 'reference-node'} style={{ left: item.x, top: item.y }} onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              event.preventDefault();
              referenceDrag.current = { id: item.asset.id, startX: event.clientX, startY: event.clientY, x: item.x, y: item.y };
            }}>
              <div className="reference-node-toolbar"><button type="button" className={item.linked ? 'selected' : ''} onClick={(event) => { event.stopPropagation(); setReferences((current) => current.map((entry) => entry.asset.id === item.asset.id ? { ...entry, linked: !entry.linked } : entry)); }}>{item.linked ? '已连接' : '未连接'}</button><button type="button" onClick={(event) => { event.stopPropagation(); setReferences((current) => current.filter((entry) => entry.asset.id !== item.asset.id)); }}><X size={13} /></button></div>
              <LocalImage asset={item.asset} alt={item.asset.name} /><span title={item.asset.name}>{item.asset.name}</span>
            </div>)}

            <div className="canvas-connector"><span /><ArrowRight size={18} /></div>

            <section className="canvas-node result-node">
              <header><span>生成结果</span><small>{iterationRecords.length} 次迭代</small></header>
              {pendingRecord ? <div className="result-empty generation-placeholder"><LoaderCircle size={30} className="spin" /><strong>生成中</strong><span>{pendingRecord.ratio} · {pendingRecord.resolution}</span></div> : selectedRecord ? <>
                <div className="result-preview"><LocalImage path={selectedRecord.outputPath} alt={selectedRecord.taskName} /><button type="button" className="image-expand-button" title="放大预览" onClick={() => setPreviewRecord(selectedRecord)}><Maximize2 size={16} /></button></div>
                <div className="result-actions">
                  <span>{selectedRecord.ratio} · {selectedRecord.model}</span>
                  <button type="button" className="primary" onClick={iterate} disabled={running}><RefreshCw size={15} />继续迭代</button>
                </div>
              </> : <div className="result-empty"><ImagePlus size={24} /><span>等待首张图片</span></div>}
            </section>

            {iterationRecords.length > 0 && <section className="iteration-history">
              <header><strong>迭代记录</strong><span>点击切换结果</span></header>
              <div>{iterationRecords.map((record, index) => (
                <button type="button" key={record.id} className={selectedRecord?.id === record.id ? 'selected' : ''} onClick={() => { setSelectedRecordId(record.id); setShowResult(true); }} title={`第 ${iterationRecords.length - index} 次迭代`}>
                  <LocalImage path={record.outputPath} alt={record.taskName} /><span>{iterationRecords.length - index}</span>
                </button>
              ))}</div>
            </section>}
          </div>
        </div>
      </main>
      {previewRecord && <ImagePreviewModal record={previewRecord} onClose={() => setPreviewRecord(null)} />}
    </div>
  );
}

async function assetDataUrl(asset: AssetRecord): Promise<string> {
  return asset.preview || window.imageStudio.readImage(asset.localPath);
}

function loadCanvasImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取图片内容'));
    image.src = source;
  });
}

async function removeConnectedBackground(source: string): Promise<string> {
  const image = await loadCanvasImage(source);
  const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前设备无法处理 Logo 底色');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  const borderRed: number[] = [];
  const borderGreen: number[] = [];
  const borderBlue: number[] = [];
  const sample = (index: number) => {
    const offset = index * 4;
    if (data[offset + 3] < 16) return;
    borderRed.push(data[offset]);
    borderGreen.push(data[offset + 1]);
    borderBlue.push(data[offset + 2]);
  };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
  for (let x = 0; x < width; x += step) {
    sample(x);
    sample((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += step) {
    sample(y * width);
    sample(y * width + width - 1);
  }
  const median = (values: number[]) => {
    if (values.length === 0) return 255;
    values.sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)];
  };
  const background = [median(borderRed), median(borderGreen), median(borderBlue)];
  const clearThreshold = 16;
  const solidThreshold = 96;
  const clampChannel = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const originalAlpha = data[offset + 3] / 255;
    if (originalAlpha <= 0.01) {
      data[offset + 3] = 0;
      continue;
    }
    const difference = Math.max(
      Math.abs(data[offset] - background[0]),
      Math.abs(data[offset + 1] - background[1]),
      Math.abs(data[offset + 2] - background[2]),
    );
    if (difference <= clearThreshold) {
      data[offset + 3] = 0;
      continue;
    }
    if (difference >= solidThreshold) continue;
    const normalized = (difference - clearThreshold) / (solidThreshold - clearThreshold);
    const coverage = normalized * normalized * (3 - 2 * normalized);
    const safeCoverage = Math.max(0.06, coverage);
    data[offset] = clampChannel((data[offset] - background[0] * (1 - safeCoverage)) / safeCoverage);
    data[offset + 1] = clampChannel((data[offset + 1] - background[1] * (1 - safeCoverage)) / safeCoverage);
    data[offset + 2] = clampChannel((data[offset + 2] - background[2] * (1 - safeCoverage)) / safeCoverage);
    data[offset + 3] = Math.round(255 * originalAlpha * coverage);
    if (data[offset + 3] < 8) data[offset + 3] = 0;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

async function createStampGuide(
  productSource: string,
  logoSource: string,
  placement: { x: number; y: number; size: number; rotation: number },
  opacity: number,
  ratio: string,
): Promise<string> {
  const [product, logo] = await Promise.all([loadCanvasImage(productSource), loadCanvasImage(logoSource)]);
  const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
  const width = 1200;
  const height = Math.max(1, Math.round(width * (ratioHeight || 1) / (ratioWidth || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备无法生成贴标定位图');
  const productScale = Math.min(width / product.naturalWidth, height / product.naturalHeight);
  const productWidth = product.naturalWidth * productScale;
  const productHeight = product.naturalHeight * productScale;
  context.drawImage(product, (width - productWidth) / 2, (height - productHeight) / 2, productWidth, productHeight);
  const logoWidth = width * placement.size / 100;
  const logoHeight = logoWidth * logo.naturalHeight / Math.max(1, logo.naturalWidth);
  context.save();
  context.translate(width * placement.x / 100, height * placement.y / 100);
  context.rotate(placement.rotation * Math.PI / 180);
  context.globalAlpha = opacity;
  context.drawImage(logo, -logoWidth / 2, -logoHeight / 2, logoWidth, logoHeight);
  context.restore();
  return canvas.toDataURL('image/png');
}

function StampPage({
  snapshot,
  draft,
  onDraft,
  onRefresh,
  onOpenSettings,
  onNotice,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  onDraft: (draft: DraftState) => void;
  onRefresh: () => Promise<AppSnapshot>;
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
}) {
  const [product, setProduct] = useState<AssetRecord | null>(null);
  const [logo, setLogo] = useState<AssetRecord | null>(null);
  const [logoSource, setLogoSource] = useState('');
  const [removeBackground, setRemoveBackground] = useState(true);
  const [processingLogo, setProcessingLogo] = useState(false);
  const [placement, setPlacement] = useState({ x: 50, y: 48, size: 25, rotation: 0 });
  const [craft, setCraft] = useState<'印刷' | '刺绣' | '烫印'>('印刷');
  const [opacity, setOpacity] = useState(0.9);
  const [strength, setStrength] = useState(0.75);
  const [shadow, setShadow] = useState(0.2);
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1K');
  const [quantity, setQuantity] = useState(1);
  const [batchTag, setBatchTag] = useState('logo_stamp');
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [running, setRunning] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<GenerationRecord | null>(null);
  const [previewRecord, setPreviewRecord] = useState<GenerationRecord | null>(null);
  const stampPrompt = draft.stampPrompt || DEFAULT_STAMP_PROMPT;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | { mode: 'move' | 'resize'; startX: number; startY: number; start: typeof placement; width: number }>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (event.clientX - drag.startX) / Math.max(1, drag.width) * 100;
      const dy = (event.clientY - drag.startY) / Math.max(1, drag.width) * 100;
      if (drag.mode === 'move') {
        setPlacement({ ...drag.start, x: Math.min(98, Math.max(2, drag.start.x + dx)), y: Math.min(98, Math.max(2, drag.start.y + dy)) });
      } else {
        setPlacement({ ...drag.start, size: Math.min(80, Math.max(5, drag.start.size + Math.max(dx, dy) * 2)) });
      }
    };
    const stop = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, []);

  const startTransform = (event: ReactPointerEvent, mode: 'move' | 'resize') => {
    if (!stageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, start: { ...placement }, width: stageRef.current.getBoundingClientRect().width };
  };
  const pickProduct = async () => {
    const asset = await window.imageStudio.pickImage();
    if (asset) setProduct(asset);
  };
  const pickLogo = async () => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    setLogo(asset);
    setProcessingLogo(true);
    try {
      const source = await assetDataUrl(asset);
      setLogoSource(removeBackground ? await removeConnectedBackground(source) : source);
    } catch (error) {
      setLogoSource(await assetDataUrl(asset));
      onNotice(error instanceof Error ? error.message : 'Logo 去底失败，已使用原图');
    } finally {
      setProcessingLogo(false);
    }
  };
  const toggleBackground = async (checked: boolean) => {
    setRemoveBackground(checked);
    if (!logo) return;
    setProcessingLogo(true);
    try {
      const source = await assetDataUrl(logo);
      setLogoSource(checked ? await removeConnectedBackground(source) : source);
    } finally {
      setProcessingLogo(false);
    }
  };
  const generate = async () => {
    if (!product || !logo || !logoSource) {
      onNotice('请先上传产品图和 Logo');
      return;
    }
    if (!stampPrompt.trim()) {
      onNotice('贴标提示词不能为空');
      return;
    }
    if (!snapshot.settings.hasApiKey) {
      onNotice('请先配置卡密');
      onOpenSettings();
      return;
    }
    setSelectedRecord(null);
    setRunning(true);
    try {
      const preparedLogo = logoSource;
      const logoAsset = await window.imageStudio.saveDataImage(preparedLogo, `${batchTag}-${removeBackground ? 'logo-transparent' : 'logo-original'}`);
      const task: GenerationTask = {
        id: newId(),
        name: `${batchTag || '贴标'} ${craft}`,
        tagGroupId: '',
        tagSubcategoryId: '',
        references: { garment: product, side: null, face: null },
        dimensions: {},
        direction: '正面',
        category: '产品贴标',
        ratio,
        resolution,
        quantity,
        prompt: stampPrompt.trim(),
        stampPostProcess: {
          logoAssetId: logoAsset.id,
          ...placement,
          opacity,
          strength,
          shadow,
          craft,
        },
      };
      await window.imageStudio.startGeneration({ batchTag: batchTag || 'logo_stamp', model, source: 'stamp', tasks: [task] });
      await onRefresh();
      onNotice('贴标任务已提交，正在后台异步生成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '贴标生成失败');
    } finally {
      setRunning(false);
    }
  };
  const records = snapshot.generations.filter((record) => record.source === 'stamp');
  const displayedRecord = selectedRecord ?? records[0] ?? null;

  return (
    <div className="stamp-page">
      <section className="tool-intro-card"><div><h2>精准产品贴标</h2><p>使用原 Logo 四角定位，生成前自动去除连通底色并保真纠正。</p></div><label>批次前缀<input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} /></label><button type="button" className="primary" disabled={running || processingLogo || !product || !logo} onClick={generate}>{running ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{running ? '提交中' : `开始生成 ${quantity} 张`}</button></section>
      <div className="stamp-workspace">
        <div className="stamp-primary-column">
          <div className="stamp-editor-row">
            <aside className="stamp-left-panel">
              <section><h3>素材</h3><UploadSlot label="产品图" required asset={product} onPick={pickProduct} onRemove={() => setProduct(null)} /><UploadSlot label="Logo / 印字图" required asset={logo} onPick={pickLogo} onRemove={() => { setLogo(null); setLogoSource(''); }} /></section>
              <section><h3>背景处理</h3><label className="check-row"><input type="checkbox" checked={removeBackground} onChange={(event) => toggleBackground(event.target.checked)} /><span><strong>自动去除 Logo 底色</strong><small>只清除从图片边缘连通的近似底色</small></span></label>{processingLogo && <p className="processing-tip"><LoaderCircle size={14} className="spin" />正在处理透明底图</p>}</section>
              {records.length > 0 && <section><h3>最近结果</h3><button type="button" className="stamp-result-thumb" onClick={() => setSelectedRecord(records.find((item) => item.status === 'success') ?? null)}><LocalImage path={records.find((item) => item.status === 'success')?.outputPath} alt="最近贴标结果" /></button></section>}
            </aside>

            <main className="stamp-canvas-panel">
              <div className="stamp-canvas-toolbar"><span>拖动 Logo 定位，拖右下角圆点缩放</span><button type="button" className="secondary" onClick={() => setPlacement({ x: 50, y: 48, size: 25, rotation: 0 })}><RefreshCw size={14} />恢复默认</button></div>
              <div className="stamp-stage" ref={stageRef} style={{ aspectRatio: ratio.replace(':', ' / ') }}>
                {product ? <LocalImage asset={product} alt="产品定位画布" /> : <div className="stamp-stage-empty"><ImagePlus size={28} /><span>上传产品图后开始定位</span></div>}
                {product && logoSource && <div className="stamp-logo-layer" style={{ left: `${placement.x}%`, top: `${placement.y}%`, width: `${placement.size}%`, transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`, opacity }} onPointerDown={(event) => startTransform(event, 'move')}>
                  <img src={logoSource} alt="Logo 定位层" draggable={false} />
                  <i className="stamp-resize-handle" onPointerDown={(event) => startTransform(event, 'resize')} />
                </div>}
              </div>
            </main>
          </div>
          {displayedRecord && <section className="standalone-result stamp-inline-result"><header><h3>生成结果</h3><span>{displayedRecord.batchPrefix}</span></header>{displayedRecord.status === 'pending' ? <div className="standalone-result-empty generation-placeholder"><LoaderCircle size={30} className="spin" /><strong>生成中</strong></div> : displayedRecord.status === 'success' ? <div><LocalImage path={displayedRecord.outputPath} alt={displayedRecord.taskName} /><button type="button" className="secondary" onClick={() => window.imageStudio.revealFile(displayedRecord.outputPath)}><FolderOpen size={15} />定位文件</button></div> : <div className="standalone-result-empty"><CircleAlert size={24} /><span>{displayedRecord.error}</span></div>}</section>}
        </div>

        <aside className="stamp-right-panel">
          <section><h3>工艺</h3><ChipGroup values={['印刷', '刺绣', '烫印']} value={craft} onChange={(value) => setCraft(value as typeof craft)} /><label>不透明度 <b>{opacity.toFixed(2)}</b><input type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label><label>工艺强度 <b>{strength.toFixed(2)}</b><input type="range" min="0" max="1" step="0.05" value={strength} onChange={(event) => setStrength(Number(event.target.value))} /></label><label>阴影 <b>{shadow.toFixed(2)}</b><input type="range" min="0" max="1" step="0.05" value={shadow} onChange={(event) => setShadow(Number(event.target.value))} /></label><label>旋转角度 <b>{placement.rotation}°</b><input type="range" min="-180" max="180" step="1" value={placement.rotation} onChange={(event) => setPlacement({ ...placement, rotation: Number(event.target.value) })} /></label></section>
          <section><h3>输出参数</h3><label>生图比例<select value={ratio} onChange={(event) => setRatio(event.target.value)}><option>1:1</option><option>3:4</option><option>9:16</option></select></label><label>清晰度<select value={resolution} onChange={(event) => { const value = event.target.value; setResolution(value); setModel((current) => modelForResolution(current, value)); }}><option>1K</option><option>2K</option></select></label><label>生成数量<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))} /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label></section>
          <section className="stamp-prompt-section"><header><h3>API 材质参考提示词</h3><button type="button" className="text-button" onClick={() => onDraft({ ...draft, stampPrompt: DEFAULT_STAMP_PROMPT })}><RefreshCw size={13} />恢复默认</button></header><textarea value={stampPrompt} onChange={(event) => onDraft({ ...draft, stampPrompt: event.target.value })} /><small>API 只处理产品材质与光影；客户 Logo 会在图片返回后按画布坐标由本地精准回贴。</small></section>
        </aside>
      </div>
    </div>
  );
}

const DETAIL_GENERATE_SECTIONS = [
  ['01', '首屏卖点总览', '用一张高冲击力主视觉讲清产品定位、核心卖点和使用场景。'],
  ['02', '卖点总览', '以信息图方式展示 3-5 个最重要卖点，文字简洁清晰，产品保持主体。'],
  ['03', '场景价值', '展示产品在真实生活或使用场景中的效果，突出用户收益和情绪价值。'],
  ['04', '材质细节', '微距展示材质、结构、工艺和关键细节，配合克制的说明排版。'],
  ['05', '规格参数', '用清晰的电商信息排版展示尺寸、规格、适用对象和使用说明。'],
  ['06', '品质保障', '展示包装、服务、品质承诺或购买理由，形成完整详情页收尾。'],
] as const;

function DetailGeneratePage({ snapshot, onRefresh, onOpenSettings, onNotice, onAssets }: { snapshot: AppSnapshot; onRefresh: () => Promise<AppSnapshot>; onOpenSettings: () => void; onNotice: (message: string) => void; onAssets: (asset: AssetRecord) => void }) {
  const [products, setProducts] = useState<AssetRecord[]>([]);
  const [description, setDescription] = useState('');
  const [platform, setPlatform] = useState('淘宝/天猫');
  const [region, setRegion] = useState('中国大陆');
  const [language, setLanguage] = useState('中文');
  const [style, setStyle] = useState('高级简洁');
  const [ratio, setRatio] = useState('3:4');
  const [audience, setAudience] = useState('');
  const [positioning, setPositioning] = useState('');
  const [extra, setExtra] = useState('');
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [resolution, setResolution] = useState('1K');
  const [batchTag, setBatchTag] = useState('detail_generate');
  const [running, setRunning] = useState(false);
  const [editingSection, setEditingSection] = useState('');
  const [sectionPrompts, setSectionPrompts] = useState<Record<string, string>>({});
  const sharedPromptKey = JSON.stringify([description, platform, region, language, style, audience, positioning, extra]);
  const previousSharedPromptKey = useRef(sharedPromptKey);
  useEffect(() => {
    if (previousSharedPromptKey.current === sharedPromptKey) return;
    previousSharedPromptKey.current = sharedPromptKey;
    setSectionPrompts({});
  }, [sharedPromptKey]);
  const records = snapshot.generations.filter((record) => record.source === 'detail-generate');
  const pending = records.filter((record) => record.status === 'pending').length;
  const completedSections = DETAIL_GENERATE_SECTIONS.filter(([number]) => records.find((record) => record.taskName.startsWith(`${number} `))?.status === 'success').length;
  const pickProducts = async () => { const assets = await window.imageStudio.pickImages(); if (assets.length === 0) return; assets.forEach(onAssets); setProducts((current) => [...current, ...assets].filter((asset, index, all) => all.findIndex((item) => item.id === asset.id) === index).slice(0, 5)); };
  const buildBasePrompt = () => `请为电商商品生成高质量详情页图片。平台：${platform}；地区：${region}；语言：${language}；视觉风格：${style}；目标人群：${audience || '普通电商消费者'}；价格定位：${positioning || '中高端'}。\n\n产品特点与信息：${description.trim()}\n\n${extra.trim() ? `补充要求：${extra.trim()}\n\n` : ''}必须严格保持参考产品图的款式、颜色、材质、结构、比例和关键细节一致，不虚构不存在的产品功能，不改变品牌和产品身份。画面适合${platform}电商详情页，文字排版清晰可读，避免乱码、无关 Logo、水印和 AI 瑕疵。`;
  const buildSectionPrompt = (number: string, instruction: string) => sectionPrompts[number] || `${buildBasePrompt()}\n\n本张详情模块：${instruction}`;
  const generate = async () => {
    if (products.length === 0) return onNotice('请先上传至少一张产品图');
    if (!description.trim()) return onNotice('请先描述产品特点');
    if (!snapshot.settings.hasApiKey) { onNotice('请先配置卡密'); onOpenSettings(); return; }
    const refs = [products[0] ?? null, products[1] ?? null, products[2] ?? null];
    const tasks: GenerationTask[] = DETAIL_GENERATE_SECTIONS.map(([number, title, instruction]) => ({ id: newId(), name: `${number} ${title}`, tagGroupId: '', tagSubcategoryId: '', references: { garment: refs[0], side: refs[1], face: refs[2] }, detailAssets: products.slice(3), dimensions: {}, direction: title, category: '电商详情页生成', ratio, resolution, quantity: 1, model: modelForResolution(model, resolution), prompt: buildSectionPrompt(number, instruction) }));
    setRunning(true);
    try { await window.imageStudio.startGeneration({ batchTag, model, source: 'detail-generate', tasks }); await onRefresh(); onNotice('详情页生成任务已提交，共 6 张，正在后台生成'); } catch (error) { onNotice(error instanceof Error ? error.message : '详情页生成失败'); } finally { setRunning(false); }
  };
  const regenerateSection = async (number: string, title: string, instruction: string) => {
    if (products.length === 0) return onNotice('请先上传至少一张产品图');
    if (!description.trim()) return onNotice('请先描述产品特点');
    if (!snapshot.settings.hasApiKey) { onNotice('请先配置卡密'); onOpenSettings(); return; }
    const prompt = buildSectionPrompt(number, instruction).trim();
    if (!prompt) return onNotice('该详情模块提示词不能为空');
    const task: GenerationTask = { id: newId(), name: `${number} ${title}`, tagGroupId: '', tagSubcategoryId: '', references: { garment: products[0] ?? null, side: products[1] ?? null, face: products[2] ?? null }, detailAssets: products.slice(3), dimensions: {}, direction: title, category: '电商详情页生成', ratio, resolution, quantity: 1, model: modelForResolution(model, resolution), prompt };
    try { await window.imageStudio.startGeneration({ batchTag: `${batchTag}-${number}`, model, source: 'detail-generate', tasks: [task] }); await onRefresh(); onNotice(`${number} ${title} 已重新提交`); } catch (error) { onNotice(error instanceof Error ? error.message : '重新生成失败'); }
  };
  return <div className="detail-generate-page"><section className="detail-generate-toolbar"><div><h2>详情页生成</h2><p>上传产品素材并描述特点，自动生成一套完整的电商详情页模块图。</p></div><label>批次前缀<input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} /></label><button type="button" className="primary" disabled={running || pending > 0} onClick={generate}>{running || pending > 0 ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{pending > 0 ? `生成中 ${pending}/6` : '生成 6 张详情图'}</button></section><div className="detail-generate-layout"><main className="detail-generate-form"><section className="detail-generate-card"><header><h3>商品图 / 产品素材</h3><span>{products.length}/5</span></header><div className="product-asset-picker">{products.map((asset) => <div key={asset.id}><LocalImage asset={asset} alt={asset.name} /><button type="button" onClick={() => setProducts((current) => current.filter((item) => item.id !== asset.id))}><X size={13} /></button></div>)}<button type="button" className="product-add-button" onClick={pickProducts}><Plus size={22} /><span>添加产品图</span></button></div><small>可上传产品白底图、细节图、模特图或场景参考图，最多 5 张。</small></section><section className="detail-generate-card"><header><h3>产品信息与生成设置</h3></header><div className="detail-generate-fields"><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="输入商品信息、卖点、参数，例如：多场景可移动音箱，20W 功率，Hi-Res 双金标..." /><div className="detail-select-grid"><select value={platform} onChange={(event) => setPlatform(event.target.value)}><option>淘宝/天猫</option><option>京东</option><option>拼多多</option><option>独立站</option></select><select value={region} onChange={(event) => setRegion(event.target.value)}><option>中国大陆</option><option>中国港澳台</option><option>北美</option><option>欧洲</option></select><select value={language} onChange={(event) => setLanguage(event.target.value)}><option>中文</option><option>英文</option><option>中英双语</option></select><select value={style} onChange={(event) => setStyle(event.target.value)}><option>高级简洁</option><option>温暖生活方式</option><option>科技专业</option><option>轻奢质感</option></select></div><div className="detail-ratio-options"><span>图片比例</span>{['1:1', '3:4', '9:16'].map((value) => <button type="button" key={value} className={ratio === value ? 'selected' : ''} onClick={() => setRatio(value)}>{value}</button>)}</div><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="目标人群，例如：宝妈、上班族、送礼人群" /><input value={positioning} onChange={(event) => setPositioning(event.target.value)} placeholder="价格定位，例如：中高端、性价比、礼盒款" /><input value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="补充要求，例如：突出材质、参考图同款风格、强调售后服务" /><label className="detail-sync-check"><input type="checkbox" defaultChecked />一键同步参考图模式</label></div></section></main><aside className="detail-generate-results"><header><div><h3>详情页结果</h3><span>{completedSections}/6 已完成</span></div><button type="button" className="secondary" onClick={() => window.imageStudio.openOutputDirectory()}><FolderOpen size={14} />打开目录</button></header><div className="detail-result-grid">{DETAIL_GENERATE_SECTIONS.map(([number, title, instruction]) => { const taskRecords = records.filter((record) => record.taskName.startsWith(`${number} `)); const latestRecord = taskRecords[0]; const promptValue = sectionPrompts[number] ?? `${buildBasePrompt()}\n\n本张详情模块：${instruction}`; return <section key={number} className="detail-result-card"><header><strong>{number} {title}</strong><div className="detail-result-actions"><button type="button" onClick={() => setEditingSection((current) => current === number ? '' : number)}>{editingSection === number ? '收起' : '编辑提示词'}</button><button type="button" disabled={latestRecord?.status === 'pending'} onClick={() => regenerateSection(number, title, instruction)}><RefreshCw size={12} />重新生成</button><span>{latestRecord?.status === 'success' ? '完成' : latestRecord?.status === 'pending' ? '生成中' : '等待'}</span></div></header>{editingSection === number && <textarea className="detail-section-prompt" value={promptValue} onChange={(event) => setSectionPrompts((current) => ({ ...current, [number]: event.target.value }))} />}<TaskResults records={taskRecords.slice(0, 1)} /></section>; })}</div></aside></div></div>;
}

const DEFAULT_3D_PROMPT = '100%还原服装细节和颜色，居中构图，正面视角。纯白色背景，专业摄影棚灯光，柔和阴影，干净的产品摄影风格，高端电商服饰展示。立体衣身结构清晰自然，面料纹理、厚薄、缝线、包边和装饰细节准确，高清纹理渲染，写实效果。不要模特、衣架、文字、Logo、水印和多余道具。';

function Garment3DPage({
  snapshot,
  onRefresh,
  onOpenSettings,
  onNotice,
}: {
  snapshot: AppSnapshot;
  onRefresh: () => Promise<AppSnapshot>;
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
}) {
  const [garment, setGarment] = useState<AssetRecord | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_3D_PROMPT);
  const [resolution, setResolution] = useState('1K');
  const [ratio, setRatio] = useState('1:1');
  const [quantity, setQuantity] = useState(1);
  const [model, setModel] = useState(snapshot.settings.defaultModel);
  const [batchTag, setBatchTag] = useState('garment_3d');
  const [running, setRunning] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<GenerationRecord | null>(null);
  const [previewRecord, setPreviewRecord] = useState<GenerationRecord | null>(null);
  const pick = async () => {
    const asset = await window.imageStudio.pickImage();
    if (asset) setGarment(asset);
  };
  const generate = async () => {
    if (!garment) {
      onNotice('请先上传服装参考图');
      return;
    }
    if (!prompt.trim()) {
      onNotice('提示词不能为空');
      return;
    }
    if (!snapshot.settings.hasApiKey) {
      onNotice('请先配置卡密');
      onOpenSettings();
      return;
    }
    const task: GenerationTask = {
      id: newId(),
      name: `${batchTag || '3D白底'} 正面`,
      tagGroupId: '',
      tagSubcategoryId: '',
      references: { garment, side: null, face: null },
      dimensions: {},
      direction: '正面',
      category: '3D服装白底图',
      ratio,
      resolution,
      quantity,
      prompt: prompt.trim(),
    };
    setSelectedRecord(null);
    setRunning(true);
    try {
      await window.imageStudio.startGeneration({ batchTag: batchTag || 'garment_3d', model, source: 'garment3d', tasks: [task] });
      await onRefresh();
      onNotice('3D白底任务已提交，正在后台异步生成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '3D白底图生成失败');
    } finally {
      setRunning(false);
    }
  };
  const displayedRecord = selectedRecord ?? snapshot.generations.find((record) => record.source === 'garment3d') ?? null;

  return (
    <div className="garment3d-page">
      <section className="tool-intro-card"><div><h2>3D服装白底图</h2><p>将服装参考图生成正面、居中的立体商品展示图。</p></div><label>批次前缀<input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} /></label><button type="button" className="primary" disabled={running || !garment} onClick={generate}>{running ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{running ? '提交中' : `生成 ${quantity} 张`}</button></section>
      <div className="garment3d-workspace">
        <section className="garment3d-reference"><header><h3>服装参考图</h3><p>上传正面服装图，模型只使用这张图还原颜色、版型、纹理和细节。</p></header><button type="button" className={garment ? 'garment3d-upload filled' : 'garment3d-upload'} onClick={pick}>{garment ? <LocalImage asset={garment} alt="3D服装参考图" /> : <><Plus size={28} /><span>上传服装图</span></>}</button>{garment && <button type="button" className="text-button danger-text" onClick={() => setGarment(null)}><Trash2 size={14} />移除图片</button>}</section>
        <section className="garment3d-settings"><header><h3>输出设置</h3></header><div className="garment3d-summary"><span>构图</span><strong>正面 · 居中 · 纯白背景</strong></div><div className="garment3d-summary"><span>分辨率</span><strong>{resolution} · {ratio}</strong></div><div className="garment3d-controls"><label>生图比例<select value={ratio} onChange={(event) => setRatio(event.target.value)}><option>1:1</option><option>3:4</option><option>9:16</option></select></label><label>清晰度<select value={resolution} onChange={(event) => { const value = event.target.value; setResolution(value); setModel((current) => modelForResolution(current, value)); }}><option>1K</option><option>2K</option></select></label><label>生成数量<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))} /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label></div><label className="garment3d-prompt"><strong>提示词</strong><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label></section>
      </div>
      <section className="standalone-result garment3d-result"><header><h3>生成结果</h3>{displayedRecord && <span>{displayedRecord.batchPrefix}</span>}</header>{displayedRecord?.status === 'pending' ? <div className="standalone-result-empty generation-placeholder"><LoaderCircle size={30} className="spin" /><strong>生成中</strong></div> : displayedRecord?.status === 'success' ? <div><LocalImage path={displayedRecord.outputPath} alt={displayedRecord.taskName} /><button type="button" className="image-expand-button" title="放大预览" onClick={() => setPreviewRecord(displayedRecord)}><Maximize2 size={16} /></button></div> : <div className="standalone-result-empty"><ImagePlus size={24} /><span>上传服装图并确认提示词后开始生成</span></div>}</section>
      {previewRecord && <ImagePreviewModal record={previewRecord} onClose={() => setPreviewRecord(null)} />}
    </div>
  );
}

function createDetailTask(index: number, sharedPrompt: string, reference: AssetRecord | null = null): GenerationTask {
  return {
    id: newId(),
    name: reference?.name.replace(/\.[^.]+$/, '') || `详情图任务 ${index}`,
    tagGroupId: '',
    tagSubcategoryId: '',
    references: { garment: reference, side: null, face: null },
    dimensions: {},
    direction: '详情页重排',
    category: '电商详情页',
    ratio: '9:16',
    resolution: '1K',
    quantity: 1,
    prompt: sharedPrompt,
    useSharedPrompt: true,
  };
}

function DetailPage({
  snapshot,
  draft,
  onDraft,
  onRefresh,
  onOpenSettings,
  onNotice,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  onDraft: (draft: DraftState) => void;
  onRefresh: () => Promise<AppSnapshot>;
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
}) {
  const sharedPrompt = draft.detailSharedPrompt || DETAIL_SHARED_PROMPT;
  const tasks = draft.detailTasks ?? [];
  const batchTag = draft.detailBatchTag || 'relayout';
  const [running, setRunning] = useState(false);

  const saveTasks = (nextTasks: GenerationTask[]) => onDraft({ ...draft, detailTasks: nextTasks, detailSharedPrompt: sharedPrompt, detailBatchTag: batchTag });
  const updateTask = (id: string, update: (task: GenerationTask) => GenerationTask) => saveTasks(tasks.map((task) => task.id === id ? update(task) : task));
  const updateSharedPrompt = (value: string) => {
    onDraft({
      ...draft,
      detailSharedPrompt: value,
      detailTasks: tasks.map((task) => task.useSharedPrompt === false ? task : { ...task, prompt: value }),
      detailBatchTag: batchTag,
    });
  };
  const addEmpty = () => saveTasks([...tasks, createDetailTask(tasks.length + 1, sharedPrompt)]);
  const batchAdd = async () => {
    const assets = await window.imageStudio.pickImages();
    if (assets.length === 0) return;
    const additions = assets.map((asset, index) => createDetailTask(tasks.length + index + 1, sharedPrompt, asset));
    saveTasks([...tasks, ...additions]);
  };
  const pickReference = async (taskId: string) => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    updateTask(taskId, (task) => ({ ...task, name: task.name.startsWith('详情图任务 ') ? asset.name.replace(/\.[^.]+$/, '') : task.name, references: { ...task.references, garment: asset } }));
  };
  const addDetailAssets = async (taskId: string) => {
    const assets = await window.imageStudio.pickImages();
    if (assets.length === 0) return;
    updateTask(taskId, (task) => ({ ...task, detailAssets: [...(task.detailAssets ?? []), ...assets].slice(0, 6) }));
  };
  const generate = async () => {
    const ready = tasks.filter((task) => task.references.garment);
    if (ready.length === 0) {
      onNotice('请至少上传一张详情图');
      return;
    }
    if (!snapshot.settings.hasApiKey) {
      onNotice('请先配置卡密');
      onOpenSettings();
      return;
    }
    const requestTasks = ready.map((task) => ({
      ...task,
      prompt: (task.useSharedPrompt === false ? task.prompt : sharedPrompt).trim(),
      model: modelForResolution(task.model || draft.model, task.resolution),
    }));
    if (requestTasks.some((task) => !task.prompt)) {
      onNotice('任务提示词不能为空');
      return;
    }
    setRunning(true);
    try {
      await window.imageStudio.startGeneration({ batchTag, model: draft.model, source: 'detail', tasks: requestTasks });
      await onRefresh();
      onNotice('详情页任务已提交，正在后台异步生成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '详情页生成失败');
    } finally {
      setRunning(false);
    }
  };
  const total = tasks.filter((task) => task.references.garment).reduce((sum, task) => sum + task.quantity, 0);

  return (
    <div className="detail-page">
      <section className="detail-toolbar">
        <div><h2>详情图区域替换</h2><p>批量上传旧详情页，在保持内容不变的前提下生成明显不同的新排版。</p></div>
        <label>批次前缀<input value={batchTag} onChange={(event) => onDraft({ ...draft, detailBatchTag: event.target.value, detailSharedPrompt: sharedPrompt, detailTasks: tasks })} /></label>
        <button type="button" className="secondary" onClick={batchAdd}><Images size={15} />批量添加详情图</button>
        <button type="button" className="secondary" onClick={addEmpty}><Plus size={15} />新增任务</button>
        <button type="button" className="primary" disabled={running || total === 0} onClick={generate}>{running ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{running ? '提交中' : `开始生成 ${total} 张`}</button>
      </section>

      <div className="detail-workspace">
        <aside className="detail-shared-panel">
          <header><h3>共享排版提示词</h3><span>默认提示词</span></header>
          <textarea value={sharedPrompt} onChange={(event) => updateSharedPrompt(event.target.value)} />
          <button type="button" className="text-button" onClick={() => updateSharedPrompt(DETAIL_SHARED_PROMPT)}><RefreshCw size={14} />恢复默认提示词</button>
          <p>默认应用到所有“跟随共享”的任务；修改后会自动同步。</p>
        </aside>

        <main className="detail-task-column">
          {tasks.length === 0 ? <EmptyState icon={ImagePlus} title="还没有详情页任务" action="批量添加详情图，或新增一个空任务" /> : tasks.map((task, index) => {
            const followsShared = task.useSharedPrompt !== false;
            return <section className="detail-task-card" key={task.id}>
              <header>
                <input value={task.name} aria-label={`详情页任务 ${index + 1} 名称`} onChange={(event) => updateTask(task.id, (item) => ({ ...item, name: event.target.value }))} />
                <span className="idle-badge">等待</span>
                <div><button type="button" className="text-button" onClick={() => saveTasks([...tasks, { ...task, id: newId(), name: `${task.name} 副本` }])}><Copy size={14} />复制</button><button type="button" className="icon-button" title="删除任务" onClick={() => saveTasks(tasks.filter((item) => item.id !== task.id))}><Trash2 size={15} /></button></div>
              </header>
              <div className="detail-task-grid">
                <section className="detail-reference-column">
                  <UploadSlot label="详情图" required asset={task.references.garment} onPick={() => pickReference(task.id)} onRemove={() => updateTask(task.id, (item) => ({ ...item, references: { ...item.references, garment: null } }))} />
                  <label>清晰度<select value={task.resolution} onChange={(event) => updateTask(task.id, (item) => ({ ...item, resolution: event.target.value, model: modelForResolution(item.model || draft.model, event.target.value) }))}><option>1K</option><option>2K</option></select></label>
                  <label>生成数量<input type="number" min="1" value={task.quantity} onChange={(event) => updateTask(task.id, (item) => ({ ...item, quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) }))} /></label>
                  <label>生图比例<select value={task.ratio} onChange={(event) => updateTask(task.id, (item) => ({ ...item, ratio: event.target.value }))}><option>1:1</option><option>3:4</option><option>9:16</option></select></label>
                  <div className="detail-assets"><button type="button" className="secondary" onClick={() => addDetailAssets(task.id)}><Plus size={14} />添加细节图</button><small>{task.detailAssets?.length ?? 0}/6</small><div>{task.detailAssets?.map((asset) => <span key={asset.id}><LocalImage asset={asset} alt="细节参考图" /><button type="button" onClick={() => updateTask(task.id, (item) => ({ ...item, detailAssets: item.detailAssets?.filter((entry) => entry.id !== asset.id) }))}><X size={11} /></button></span>)}</div></div>
                </section>
                <section className="detail-prompt-column">
                  <header><h3>任务提示词</h3><div><button type="button" className={followsShared ? 'selected' : ''} onClick={() => updateTask(task.id, (item) => ({ ...item, useSharedPrompt: true, prompt: sharedPrompt }))}>跟随共享</button><button type="button" className={!followsShared ? 'selected' : ''} onClick={() => updateTask(task.id, (item) => ({ ...item, useSharedPrompt: false, prompt: item.prompt || sharedPrompt }))}>独立编辑</button></div></header>
                  <textarea value={followsShared ? sharedPrompt : task.prompt} readOnly={followsShared} onChange={(event) => updateTask(task.id, (item) => ({ ...item, prompt: event.target.value }))} />
                  <small>{followsShared ? '当前使用共享提示词，切换“独立编辑”后可单独修改。' : '当前任务使用独立提示词，不受共享提示词修改影响。'}</small>
                </section>
              </div>
              <TaskResults records={snapshot.generations.filter((record) => record.taskId === task.id && record.source === 'detail')} />
            </section>;
          })}
        </main>
      </div>
    </div>
  );
}

function TemplatesPage({
  snapshot,
  draft,
  onSave,
  onApply,
  onAssets,
}: {
  snapshot: AppSnapshot;
  draft: DraftState;
  onSave: (items: PromptTemplate[]) => void;
  onApply: (template: PromptTemplate) => void;
  onAssets: (asset: AssetRecord) => void;
}) {
  const task = draft.tasks[0] ?? createTask(1, snapshot.tagGroups[0]);
  const initialGroup = snapshot.tagGroups.find((group) => group.id === task.tagGroupId) ?? snapshot.tagGroups[0];
  const initialSubcategory = initialGroup?.subcategories.find((item) => item.id === task.tagSubcategoryId) ?? initialGroup?.subcategories[0];
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState(initialGroup?.id ?? '');
  const group = snapshot.tagGroups.find((item) => item.id === groupId) ?? snapshot.tagGroups[0];
  const [subcategoryId, setSubcategoryId] = useState(initialSubcategory?.id ?? '');
  const subcategory = group?.subcategories.find((item) => item.id === subcategoryId) ?? group?.subcategories[0];
  const [dimensions, setDimensions] = useState<Record<string, string>>({ ...task.dimensions });
  const [prompt, setPrompt] = useState(task.prompt);
  const [model, setModel] = useState(draft.model);
  const [resolution, setResolution] = useState(task.resolution || '1K');
  const [batchTag, setBatchTag] = useState(draft.batchTag);
  const [queueOutput, setQueueOutput] = useState({ ...draft.queueOutput });
  const [sharedFront, setSharedFront] = useState<AssetRecord | null>(draft.queueShared.front);
  const [sharedSide, setSharedSide] = useState<AssetRecord | null>(draft.queueShared.side);

  const pickShared = async (slot: 'front' | 'side') => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    onAssets(asset);
    if (slot === 'front') setSharedFront(asset);
    else setSharedSide(asset);
  };
  const changeGroup = (nextGroupId: string) => {
    const nextGroup = snapshot.tagGroups.find((item) => item.id === nextGroupId);
    const nextSubcategory = nextGroup?.subcategories[0];
    if (!nextGroup || !nextSubcategory) return;
    const nextDimensions: Record<string, string> = {};
    setGroupId(nextGroup.id);
    setSubcategoryId(nextSubcategory.id);
    setDimensions(nextDimensions);
    setPrompt(composePrompt({ dimensions: nextDimensions, direction: '正面', category: nextSubcategory.name }, nextGroup, nextSubcategory));
  };
  const changeSubcategory = (nextSubcategoryId: string) => {
    const nextSubcategory = group?.subcategories.find((item) => item.id === nextSubcategoryId);
    if (!nextSubcategory) return;
    const nextDimensions: Record<string, string> = {};
    setSubcategoryId(nextSubcategory.id);
    setDimensions(nextDimensions);
    setPrompt(composePrompt({ dimensions: nextDimensions, direction: '正面', category: nextSubcategory.name }, group, nextSubcategory));
  };
  const updateDimension = (dimensionName: string, value: string) => {
    const next = { ...dimensions };
    if (value) next[dimensionName] = value;
    else delete next[dimensionName];
    setDimensions(next);
    setPrompt(composePrompt({ dimensions: next, direction: '正面', category: subcategory?.name ?? group?.name ?? '自由创作' }, group, subcategory));
  };
  const create = () => {
    if (!name.trim() || !prompt.trim()) return;
    const preset: PromptTemplate = {
      id: newId(),
      name: name.trim(),
      prompt: prompt.trim(),
      createdAt: new Date().toISOString(),
      tagGroupId: group?.id,
      tagSubcategoryId: subcategory?.id,
      dimensions: { ...dimensions },
      model: model.trim() || snapshot.settings.defaultModel,
      resolution,
      batchTag: batchTag.trim() || 'template',
      queueOutput: { ...queueOutput },
      sharedFront,
      sharedSide,
    };
    onSave([preset, ...snapshot.templates]);
    setName('');
    setCreating(false);
  };

  return (
    <div className="content-page preset-page">
      <section className="preset-heading">
        <div><h2>模板预设</h2><p>保存共享参数与脸部参考图，供模板队列一键复用。</p></div>
        <button type="button" className="primary" onClick={() => setCreating((value) => !value)}><Plus size={16} />{creating ? '收起编辑器' : '新建预设'}</button>
      </section>
      {creating && <section className="preset-editor">
        <div className="preset-editor-top">
          <label>预设名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：芭蕾正侧面商拍" /></label>
          <label>大分类<select value={group?.id ?? ''} onChange={(event) => changeGroup(event.target.value)}>{snapshot.tagGroups.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>小分类<select value={subcategory?.id ?? ''} onChange={(event) => changeSubcategory(event.target.value)}>{group?.subcategories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>批次标签<input value={batchTag} onChange={(event) => setBatchTag(event.target.value)} /></label>
        </div>
        <div className="preset-editor-body">
          <section className="preset-faces">
            <h3>共享脸部参考图</h3>
            <div><UploadSlot label="共享正面图" required asset={sharedFront} onPick={() => pickShared('front')} onRemove={() => setSharedFront(null)} /><UploadSlot label="共享侧脸图" asset={sharedSide} onPick={() => pickShared('side')} onRemove={() => setSharedSide(null)} /></div>
          </section>
          <section className="preset-parameters">
            <h3>共享输出参数</h3>
            <div className="preset-parameter-grid">
              <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
              <label>清晰度<select value={resolution} onChange={(event) => { const value = event.target.value; setResolution(value); setModel((current) => modelForResolution(current, value)); }}><option>1K</option><option>2K</option></select></label>
              <div className="preset-ratio-field"><span>正面比例</span><MultiChipGroup values={SUPPORTED_ASPECT_RATIOS} selected={normalizedGenerationRatios(queueOutput.frontRatios, queueOutput.frontRatio)} onChange={(values) => setQueueOutput({ ...queueOutput, frontRatios: values, frontRatio: values[0] })} /></div>
              <div className="ratio-quantity-grid">{normalizedGenerationRatios(queueOutput.frontRatios, queueOutput.frontRatio).map((ratio) => <label key={ratio}>{ratio} 数量<input type="number" min="0" value={queueRatioQuantity(queueOutput, 'front', ratio)} onChange={(event) => setQueueOutput({ ...queueOutput, frontRatioQuantities: { ...queueOutput.frontRatioQuantities, [ratio]: Math.max(0, Math.floor(Number(event.target.value) || 0)) } })} /></label>)}</div>
              <div className="preset-ratio-field"><span>侧面比例</span><MultiChipGroup values={SUPPORTED_ASPECT_RATIOS} selected={normalizedGenerationRatios(queueOutput.sideRatios, queueOutput.sideRatio)} onChange={(values) => setQueueOutput({ ...queueOutput, sideRatios: values, sideRatio: values[0] })} /></div>
              <div className="ratio-quantity-grid">{normalizedGenerationRatios(queueOutput.sideRatios, queueOutput.sideRatio).map((ratio) => <label key={ratio}>{ratio} 数量<input type="number" min="0" value={queueRatioQuantity(queueOutput, 'side', ratio)} onChange={(event) => setQueueOutput({ ...queueOutput, sideRatioQuantities: { ...queueOutput.sideRatioQuantities, [ratio]: Math.max(0, Math.floor(Number(event.target.value) || 0)) } })} /></label>)}</div>
            </div>
          </section>
        </div>
        <section className="preset-dimensions"><h3>标签参数（未指定时每张图随机）</h3><div>{subcategory?.dimensions.filter((item) => item.tags.length > 0).map((item) => <label key={item.id}>{item.name}<select value={dimensions[item.name] ?? ''} onChange={(event) => updateDimension(item.name, event.target.value)}><option value="">随机（每张图）</option>{item.tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}</select></label>)}</div></section>
        <label className="preset-prompt">共享主体提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <footer><button type="button" className="secondary" onClick={() => setCreating(false)}>取消</button><button type="button" className="primary" onClick={create} disabled={!name.trim() || !prompt.trim() || !sharedFront}><Save size={16} />保存预设</button></footer>
      </section>}
      {snapshot.templates.length === 0 ? <EmptyState icon={Layers3} title="还没有预设" action="点击“新建预设”，保存模板队列需要的共享参数与脸部参考图" /> : <div className="preset-grid">
        {snapshot.templates.map((template) => (
          <article className="preset-card" key={template.id}>
            <header><div className="template-icon"><WandSparkles size={18} /></div><div><h3>{template.name}</h3><span>{formatDate(template.createdAt)}</span></div></header>
            <div className="preset-card-faces"><div>{template.sharedFront ? <LocalImage asset={template.sharedFront} alt="共享正面图" /> : <ImagePlus size={20} />}</div><div>{template.sharedSide ? <LocalImage asset={template.sharedSide} alt="共享侧脸图" /> : <span>侧脸可选</span>}</div></div>
            <p>{template.prompt}</p>
            <div className="preset-tags"><span>{template.resolution ?? '1K'}</span><span>正 {template.queueOutput ? normalizedGenerationRatios(template.queueOutput.frontRatios, template.queueOutput.frontRatio).map((ratio) => `${ratio}×${queueRatioQuantity(template.queueOutput!, 'front', ratio)}`).join('、') : '1:1×10'}</span><span>侧 {template.queueOutput ? normalizedGenerationRatios(template.queueOutput.sideRatios, template.queueOutput.sideRatio).map((ratio) => `${ratio}×${queueRatioQuantity(template.queueOutput!, 'side', ratio)}`).join('、') : '3:4×0'}</span><span>{template.model ?? snapshot.settings.defaultModel}</span></div>
            <footer><button type="button" className="primary" onClick={() => onApply(template)}>应用到模板队列</button><button type="button" className="icon-button" title="删除预设" onClick={() => onSave(snapshot.templates.filter((item) => item.id !== template.id))}><Trash2 size={16} /></button></footer>
          </article>
        ))}
      </div>}
    </div>
  );
}

function TagsPage({ groups, onSave }: { groups: TagGroup[]; onSave: (groups: TagGroup[]) => Promise<void> }) {
  const [draftGroups, setDraftGroups] = useState(groups);
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? '');
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState(groups[0]?.subcategories[0]?.id ?? '');
  const [selectedDimensionId, setSelectedDimensionId] = useState(groups[0]?.subcategories[0]?.dimensions[0]?.id ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPromptTemplate, setShowPromptTemplate] = useState(false);

  useEffect(() => {
    setDraftGroups(groups);
    const group = groups.find((item) => item.id === selectedGroupId) ?? groups[0];
    const subcategory = group?.subcategories.find((item) => item.id === selectedSubcategoryId) ?? group?.subcategories[0];
    setSelectedGroupId(group?.id ?? '');
    setSelectedSubcategoryId(subcategory?.id ?? '');
    setSelectedDimensionId((current) => subcategory?.dimensions.some((dimension) => dimension.id === current) ? current : subcategory?.dimensions[0]?.id ?? '');
    setDirty(false);
  }, [groups]);

  const selectedGroup = draftGroups.find((group) => group.id === selectedGroupId);
  const selectedSubcategory = selectedGroup?.subcategories.find((subcategory) => subcategory.id === selectedSubcategoryId) ?? selectedGroup?.subcategories[0];
  const selectedDimension = selectedSubcategory?.dimensions.find((dimension) => dimension.id === selectedDimensionId) ?? selectedSubcategory?.dimensions[0];
  const commit = (next: TagGroup[]) => { setDraftGroups(next); setDirty(true); };
  const updateGroup = (nextGroup: TagGroup) => commit(draftGroups.map((group) => group.id === nextGroup.id ? nextGroup : group));
  const updateSubcategory = (nextSubcategory: TagSubcategory) => {
    if (!selectedGroup) return;
    updateGroup({ ...selectedGroup, subcategories: selectedGroup.subcategories.map((subcategory) => subcategory.id === nextSubcategory.id ? nextSubcategory : subcategory) });
  };
  const selectSubcategory = (subcategory: TagSubcategory) => {
    setSelectedSubcategoryId(subcategory.id);
    setSelectedDimensionId(subcategory.dimensions[0]?.id ?? '');
  };
  const selectGroup = (group: TagGroup) => {
    setSelectedGroupId(group.id);
    const subcategory = group.subcategories[0];
    setSelectedSubcategoryId(subcategory?.id ?? '');
    setSelectedDimensionId(subcategory?.dimensions[0]?.id ?? '');
  };
  const addGroup = () => {
    const id = newId();
    const subcategoryId = newId();
    const group: TagGroup = {
      id,
      name: `新大分类 ${draftGroups.length + 1}`,
      promptTemplate: '{{标签组合}}',
      subcategories: [{
        id: subcategoryId,
        name: '默认小分类',
        dimensions: LABEL_DIMENSIONS.map((name, index) => ({ id: `${subcategoryId}-${index + 1}`, name, tags: [] })),
      }],
    };
    commit([...draftGroups, group]);
    selectGroup(group);
  };
  const removeGroup = (id: string) => {
    const next = draftGroups.filter((group) => group.id !== id);
    commit(next);
    if (next[0]) selectGroup(next[0]);
    else { setSelectedGroupId(''); setSelectedSubcategoryId(''); setSelectedDimensionId(''); }
  };
  const addSubcategory = () => {
    if (!selectedGroup) return;
    const id = newId();
    const subcategory: TagSubcategory = {
      id,
      name: `新小分类 ${selectedGroup.subcategories.length + 1}`,
      dimensions: LABEL_DIMENSIONS.map((name, index) => ({ id: `${id}-${index + 1}`, name, tags: [] })),
    };
    updateGroup({ ...selectedGroup, subcategories: [...selectedGroup.subcategories, subcategory] });
    selectSubcategory(subcategory);
  };
  const removeSubcategory = (id: string) => {
    if (!selectedGroup) return;
    const next = selectedGroup.subcategories.filter((subcategory) => subcategory.id !== id);
    updateGroup({ ...selectedGroup, subcategories: next });
    if (next[0]) selectSubcategory(next[0]);
    else { setSelectedSubcategoryId(''); setSelectedDimensionId(''); }
  };
  const updateDimension = (nextDimension: TagCategory) => {
    if (!selectedSubcategory) return;
    updateSubcategory({ ...selectedSubcategory, dimensions: selectedSubcategory.dimensions.map((dimension) => dimension.id === nextDimension.id ? nextDimension : dimension) });
  };
  const renameDimension = (name: string) => {
    if (!selectedGroup || !selectedSubcategory || !selectedDimension) return;
    const nextDimension = { ...selectedDimension, name };
    const nextSubcategory = { ...selectedSubcategory, dimensions: selectedSubcategory.dimensions.map((dimension) => dimension.id === selectedDimension.id ? nextDimension : dimension) };
    const nextTemplate = selectedGroup.promptTemplate.split(`{{${selectedDimension.name}}}`).join(`{{${name}}}`);
    updateGroup({ ...selectedGroup, promptTemplate: nextTemplate, subcategories: selectedGroup.subcategories.map((subcategory) => subcategory.id === selectedSubcategory.id ? nextSubcategory : subcategory) });
  };
  const addDimension = () => {
    if (!selectedSubcategory) return;
    const dimension: TagCategory = { id: newId(), name: '新标签维度', tags: [] };
    updateSubcategory({ ...selectedSubcategory, dimensions: [...selectedSubcategory.dimensions, dimension] });
    setSelectedDimensionId(dimension.id);
  };
  const removeDimension = (id: string) => {
    if (!selectedSubcategory) return;
    const next = selectedSubcategory.dimensions.filter((dimension) => dimension.id !== id);
    updateSubcategory({ ...selectedSubcategory, dimensions: next });
    setSelectedDimensionId(next[0]?.id ?? '');
  };
  const addTag = () => {
    if (!selectedDimension) return;
    updateDimension({ ...selectedDimension, tags: [...selectedDimension.tags, { id: newId(), name: '新标签', prompt: '' }] });
  };
  const save = async () => {
    setSaving(true);
    try {
      const cleaned = draftGroups.map((group) => ({
        ...group,
        name: group.name.trim() || '未命名大分类',
        promptTemplate: group.promptTemplate.trim(),
        subcategories: group.subcategories.map((subcategory) => ({
          ...subcategory,
          name: subcategory.name.trim() || '未命名小分类',
          dimensions: subcategory.dimensions.map((dimension) => ({
            ...dimension,
            name: dimension.name.trim() || '未命名标签维度',
            tags: dimension.tags.map((tag) => ({ ...tag, name: tag.name.trim(), prompt: tag.prompt.trim() })).filter((tag) => tag.name && tag.prompt),
          })),
        })),
      }));
      await onSave(cleaned);
      setDraftGroups(cleaned);
      setDirty(false);
    } finally { setSaving(false); }
  };

  return <div className="tags-page hierarchical-tags four-level-tags">
    <aside className="tag-categories">
      <div className="tag-categories-heading"><span>大分类</span><div><button type="button" className="icon-button" onClick={addGroup} title="新增大分类"><Plus size={15} /></button><button type="button" className="icon-button danger-button" onClick={() => selectedGroup && removeGroup(selectedGroup.id)} disabled={!selectedGroup} title="删除当前大分类"><Trash2 size={14} /></button></div></div>
      <div className="category-list">{draftGroups.map((group) => <button type="button" key={group.id} className={selectedGroup?.id === group.id ? 'category-item active' : 'category-item'} onClick={() => selectGroup(group)}><span>{group.name}</span><small>{group.subcategories.length}</small></button>)}</div>
    </aside>
    <aside className="tag-subcategories">
      <div className="tag-categories-heading"><span>小分类</span><div><button type="button" className="icon-button" onClick={addSubcategory} disabled={!selectedGroup} title="新增小分类"><Plus size={15} /></button><button type="button" className="icon-button danger-button" onClick={() => selectedSubcategory && removeSubcategory(selectedSubcategory.id)} disabled={!selectedSubcategory} title="删除当前小分类"><Trash2 size={14} /></button></div></div>
      <div className="category-list">{selectedGroup?.subcategories.map((subcategory) => <button type="button" key={subcategory.id} className={selectedSubcategory?.id === subcategory.id ? 'category-item active' : 'category-item'} onClick={() => selectSubcategory(subcategory)}><span>{subcategory.name}</span><small>{subcategory.dimensions.reduce((total, dimension) => total + dimension.tags.length, 0)}</small></button>)}</div>
    </aside>
    <aside className="tag-dimensions">
      <div className="tag-categories-heading"><span>标签维度</span><div><button type="button" className="icon-button" onClick={addDimension} disabled={!selectedSubcategory} title="新增标签维度"><Plus size={15} /></button><button type="button" className="icon-button danger-button" onClick={() => selectedDimension && removeDimension(selectedDimension.id)} disabled={!selectedDimension} title="删除当前标签维度"><Trash2 size={14} /></button></div></div>
      <div className="category-list">{selectedSubcategory?.dimensions.map((dimension) => <button type="button" key={dimension.id} className={selectedDimension?.id === dimension.id ? 'category-item active' : 'category-item'} onClick={() => setSelectedDimensionId(dimension.id)}><span>{dimension.name}</span><small>{dimension.tags.length}</small></button>)}</div>
    </aside>
    <main className="tag-editor">
      {selectedGroup && selectedSubcategory && selectedDimension ? <>
        <header className="tag-editor-header">
          <div className="tag-name-fields"><label>大分类<input value={selectedGroup.name} onChange={(event) => updateGroup({ ...selectedGroup, name: event.target.value })} /></label><label>小分类<input value={selectedSubcategory.name} onChange={(event) => updateSubcategory({ ...selectedSubcategory, name: event.target.value })} /></label><label>标签维度<input value={selectedDimension.name} onChange={(event) => renameDimension(event.target.value)} /></label><span>{selectedDimension.tags.length} 个标签</span></div>
          <div><button type="button" className="secondary" onClick={addTag}><Plus size={15} />新增标签</button><button type="button" className={showPromptTemplate ? 'secondary active-template-button' : 'secondary'} onClick={() => setShowPromptTemplate((visible) => !visible)}><WandSparkles size={15} />分类提示词模板</button><button type="button" className="primary" onClick={save} disabled={!dirty || saving}><Save size={15} />{saving ? '保存中' : '保存全部'}</button></div>
        </header>
        {showPromptTemplate && <section className="category-prompt-template-editor">
          <header><div><strong>{selectedGroup.name} · 分类提示词模板</strong><span>可使用 {'{{小分类}}'}、{'{{方向}}'}、{'{{标签组合}}'} 或 {'{{标签维度名称}}'} 作为替换位置</span></div><button type="button" className="icon-button" title="关闭" onClick={() => setShowPromptTemplate(false)}><X size={15} /></button></header>
          <textarea value={selectedGroup.promptTemplate} onChange={(event) => updateGroup({ ...selectedGroup, promptTemplate: event.target.value })} placeholder="输入该大分类共用的完整提示词模板" />
        </section>}
        <div className="tag-table-heading"><span>标签名</span><span>Prompt 文本</span><span /></div>
        <div className="tag-rows">
          {selectedDimension.tags.map((tag) => <div className="tag-row" key={tag.id}><input value={tag.name} aria-label="标签名" onChange={(event) => updateDimension({ ...selectedDimension, tags: selectedDimension.tags.map((item) => item.id === tag.id ? { ...item, name: event.target.value } : item) })} /><textarea value={tag.prompt} aria-label="Prompt 文本" onChange={(event) => updateDimension({ ...selectedDimension, tags: selectedDimension.tags.map((item) => item.id === tag.id ? { ...item, prompt: event.target.value } : item) })} /><button type="button" className="icon-button" title="删除标签" onClick={() => updateDimension({ ...selectedDimension, tags: selectedDimension.tags.filter((item) => item.id !== tag.id) })}><Trash2 size={15} /></button></div>)}
          {selectedDimension.tags.length === 0 && <EmptyState icon={Tag} title="该维度暂无标签" action="新增标签后即可在两个生成页面中选择" />}
        </div>
      </> : <EmptyState icon={Tag} title="暂无可编辑标签" action="请依次创建大分类、小分类和标签维度" />}
    </main>
  </div>;
}

function AssetsPage({ generations }: { generations: GenerationRecord[] }) {
  const [source, setSource] = useState<'all' | GenerationRecord['source']>('all');
  const [model, setModel] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<GenerationRecord | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const success = useMemo(() => generations.filter((record) => record.status === 'success'), [generations]);
  const models = useMemo(() => Array.from(new Set(success.map((record) => record.model))).sort(), [success]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
    return success.filter((record) => {
      const createdAt = new Date(record.createdAt).getTime();
      const searchable = [record.taskName, record.outputPath, record.model, record.batchPrefix, record.batchId].join(' ').toLowerCase();
      return (source === 'all' || record.source === source)
        && (model === 'all' || record.model === model)
        && createdAt >= from
        && createdAt <= to
        && (!normalized || searchable.includes(normalized));
    });
  }, [success, source, model, fromDate, toDate, query]);
  const sourceOptions: Array<{ value: 'all' | GenerationRecord['source']; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'single', label: '单图' },
    { value: 'batch', label: '多批次' },
    { value: 'template', label: '模板队列' },
    { value: 'workbench', label: '工作台' },
    { value: 'stamp', label: '贴标' },
    { value: 'garment3d', label: '3D白底' },
    { value: 'detail-generate', label: '详情页生成' },
    { value: 'detail', label: '详情页' },
  ];
  const previewIndex = preview ? filtered.findIndex((record) => record.id === preview.id) : -1;
  const showPrevious = () => {
    if (filtered.length === 0) return;
    setPreview(filtered[(previewIndex - 1 + filtered.length) % filtered.length]);
  };
  const showNext = () => {
    if (filtered.length === 0) return;
    setPreview(filtered[(previewIndex + 1) % filtered.length]);
  };
  useEffect(() => {
    if (preview && !filtered.some((record) => record.id === preview.id)) setPreview(null);
  }, [filtered, preview]);
  useEffect(() => {
    const available = new Set(success.map((record) => record.id));
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [success]);
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const deleteSelected = async () => {
    const selected = success.filter((record) => selectedIds.has(record.id));
    if (selected.length === 0) return;
    if (!window.confirm(`确定彻底删除选中的 ${selected.length} 张图片吗？\n图片文件和资产库记录都会删除，此操作无法撤销。`)) return;
    await window.imageStudio.deleteImages(selected.map((record) => record.outputPath));
    setSelectedIds(new Set());
    setSelectionMode(false);
  };
  const downloadSelected = async () => {
    const selected = success.filter((record) => selectedIds.has(record.id));
    if (selected.length === 0) return;
    setBulkDownloading(true);
    try {
      const result = await window.imageStudio.downloadImages(selected.map((record) => record.outputPath));
      if (result.count > 0) window.alert(`已下载 ${result.count} 张图片到：\n${result.directory}`);
    } finally {
      setBulkDownloading(false);
    }
  };

  return (
    <div className="content-page">
      <section className="asset-filter-panel">
        <div className="asset-source-tabs">{sourceOptions.map((option) => <button type="button" key={option.value} className={source === option.value ? 'selected' : ''} onClick={() => setSource(option.value)}>{option.label}<span>{option.value === 'all' ? success.length : success.filter((record) => record.source === option.value).length}</span></button>)}</div>
        <div className="asset-filter-row">
          <label className="asset-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索路径、模型、任务或批次前缀" /></label>
          <select aria-label="按模型筛选" value={model} onChange={(event) => setModel(event.target.value)}><option value="all">全部模型</option>{models.map((item) => <option value={item} key={item}>{item}</option>)}</select>
          <label className="asset-date-filter"><span>从</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label className="asset-date-filter"><span>至</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        </div>
      </section>
      <div className="section-toolbar"><span>{selectionMode ? `已选择 ${selectedIds.size} 张` : `显示 ${filtered.length} / ${success.length} 张生成图片`}</span><div className="asset-multi-actions">{selectionMode && <><button type="button" className="secondary" onClick={() => setSelectedIds((current) => { const next = new Set(current); filtered.forEach((record) => next.add(record.id)); return next; })}><Check size={14} />全选当前</button><button type="button" className="secondary" onClick={() => setSelectedIds(new Set())}>清空选择</button><button type="button" className="secondary" disabled={selectedIds.size === 0 || bulkDownloading} onClick={downloadSelected}>{bulkDownloading ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{bulkDownloading ? '下载中' : '下载选中'}</button><button type="button" className="danger-button" disabled={selectedIds.size === 0} onClick={deleteSelected}><Trash2 size={14} />删除选中</button></>}<button type="button" className={selectionMode ? 'primary' : 'secondary'} onClick={() => { setSelectionMode((value) => !value); setSelectedIds(new Set()); }}><Images size={15} />{selectionMode ? '完成多选' : '多选'}</button><button type="button" className="secondary" onClick={() => window.imageStudio.openOutputDirectory()}><FolderOpen size={15} />输出目录</button></div></div>
      {success.length === 0 ? <EmptyState icon={Archive} title="资产库还是空的" action="所有生图功能生成成功的图片都会自动出现在这里" /> : filtered.length === 0 ? <EmptyState icon={Search} title="没有匹配的图片" action="请调整来源、模型、日期或搜索条件" /> : (
        <div className="generated-asset-grid">
          {filtered.map((record) => <article className={selectedIds.has(record.id) ? 'generated-asset-card selected' : 'generated-asset-card'} key={record.id} onClick={() => selectionMode && toggleSelected(record.id)} onDoubleClick={() => !selectionMode && window.imageStudio.revealFile(record.outputPath)}>
            <div className="generated-asset-image"><LocalImage path={record.outputPath} alt={record.taskName} />{selectionMode && <button type="button" className={selectedIds.has(record.id) ? 'asset-select-check selected' : 'asset-select-check'} onClick={(event) => { event.stopPropagation(); toggleSelected(record.id); }}>{selectedIds.has(record.id) ? <Check size={16} /> : null}</button>}<span className={`batch-prefix-badge ${record.source}`}>{record.batchPrefix}</span>{!selectionMode && <button type="button" className="image-expand-button" title="放大预览" onClick={(event) => { event.stopPropagation(); setPreview(record); }}><Maximize2 size={16} /></button>}</div>
            <div className="generated-asset-info"><h3 title={record.taskName}>{record.taskName}</h3><p>{record.model} · {record.ratio} · {record.resolution}</p><small>{formatDate(record.createdAt)}</small></div>
          </article>)}
        </div>
      )}
      {preview && <ImagePreviewModal record={preview} onClose={() => setPreview(null)} onPrevious={showPrevious} onNext={showNext} />}
    </div>
  );
}

function localDateTimeValue(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function BatchesPage({ snapshot, onRefresh, onNotice }: { snapshot: AppSnapshot; onRefresh: () => Promise<AppSnapshot>; onNotice: (message: string) => void }) {
  const [cutoff, setCutoff] = useState(() => localDateTimeValue(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [deleting, setDeleting] = useState(false);
  const batchIds = useMemo(() => new Set(snapshot.batches.map((batch) => batch.id)), [snapshot.batches]);
  const errors = snapshot.generations.filter((item) => item.status === 'error' && batchIds.has(item.batchId));
  const setDaysAgo = (days: number) => setCutoff(localDateTimeValue(new Date(Date.now() - days * 24 * 60 * 60 * 1000)));
  const deleteOne = async (batchId: string, tag: string) => {
    if (!window.confirm(`确定删除批次记录“${tag}”吗？\n不会删除资产库图片和本地图片文件。`)) return;
    setDeleting(true);
    try {
      const removed = await window.imageStudio.deleteBatchRecord(batchId);
      await onRefresh();
      onNotice(removed ? '批次记录已删除' : '进行中的批次不能删除');
    } finally {
      setDeleting(false);
    }
  };
  const deleteBefore = async () => {
    const date = new Date(cutoff);
    if (!Number.isFinite(date.getTime())) {
      onNotice('请选择有效的删除截止时间');
      return;
    }
    if (!window.confirm(`确定删除 ${date.toLocaleString('zh-CN')} 之前的已完成批次记录吗？\n不会删除资产库图片和本地图片文件。`)) return;
    setDeleting(true);
    try {
      const removed = await window.imageStudio.deleteBatchRecordsBefore(date.toISOString());
      await onRefresh();
      onNotice(removed > 0 ? `已删除 ${removed} 条批次记录` : '该时间之前没有可删除的已完成记录');
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="content-page batches-page">
      <section className="batch-delete-toolbar">
        <div><h2>批次记录清理</h2><p>选择截止日期和具体时间，删除该时间之前的已完成记录。默认是 1 天以前。</p></div>
        <div className="batch-cutoff-shortcuts"><button type="button" onClick={() => setDaysAgo(1)}>1天前</button><button type="button" onClick={() => setDaysAgo(7)}>7天前</button><button type="button" onClick={() => setDaysAgo(30)}>30天前</button></div>
        <label>删除此时间之前<input type="datetime-local" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label>
        <button type="button" className="danger-button batch-delete-before" disabled={deleting || !cutoff} onClick={deleteBefore}><Trash2 size={15} />{deleting ? '处理中' : '删除以前记录'}</button>
        <small>只删除历史记录，不删除资产库图片和本地文件。</small>
      </section>
      {snapshot.batches.length === 0 ? <EmptyState icon={Boxes} title="暂无批次记录" action="批量生成后会显示每次执行结果" /> : (
        <div className="table-wrap"><table><thead><tr><th>批次</th><th>状态</th><th>进度</th><th>成功</th><th>失败</th><th>开始时间</th><th>操作</th></tr></thead><tbody>
          {snapshot.batches.map((batch) => <tr key={batch.id}><td><strong>{batch.tag}</strong><small>{batch.id.slice(0, 8)}</small></td><td><span className={`table-status ${batch.status}`}>{batch.status === 'completed' ? '已完成' : '进行中'}</span></td><td>{batch.completed}/{batch.total}</td><td className="success-text">{batch.succeeded}</td><td className={batch.failed ? 'error-text' : ''}>{batch.failed}</td><td>{formatDate(batch.createdAt)}</td><td><button type="button" className="icon-button batch-row-delete" title={batch.status === 'running' ? '进行中的批次不能删除' : '删除批次记录'} disabled={deleting || batch.status === 'running'} onClick={() => deleteOne(batch.id, batch.tag)}><Trash2 size={15} /></button></td></tr>)}
        </tbody></table></div>
      )}
      {errors.length > 0 && <section className="error-log"><h2>最近失败</h2>{errors.slice(0, 5).map((item) => <div key={item.id}><CircleAlert size={15} /><span><strong>{item.taskName}</strong>{item.error}</span><time>{formatDate(item.createdAt)}</time></div>)}</section>}
    </div>
  );
}

function PromptToolsPage({
  settings,
  onOpenSettings,
  onNotice,
  onAsset,
}: {
  settings: PublicSettings;
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
  onAsset: (asset: AssetRecord) => void;
}) {
  const [mode, setMode] = useState<'reverse' | 'expand'>('reverse');
  const [image, setImage] = useState<AssetRecord | null>(null);
  const [reverseResult, setReverseResult] = useState('');
  const [expandInput, setExpandInput] = useState('');
  const [expandResult, setExpandResult] = useState('');
  const [running, setRunning] = useState(false);

  const requireTextService = () => {
    if (settings.hasTextApiKey) return true;
    onNotice('请先配置文字服务卡密');
    onOpenSettings();
    return false;
  };
  const pickImage = async () => {
    const asset = await window.imageStudio.pickImage();
    if (!asset) return;
    setImage(asset);
    setReverseResult('');
    onAsset(asset);
  };
  const reverse = async () => {
    if (!image) {
      onNotice('请先上传需要分析的图片');
      return;
    }
    if (!requireTextService()) return;
    setRunning(true);
    try {
      setReverseResult(await window.imageStudio.runPromptTool({ mode: 'reverse', imagePath: image.localPath }));
      onNotice('图片提示词反推完成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '图片提示词反推失败');
    } finally {
      setRunning(false);
    }
  };
  const expand = async () => {
    if (!expandInput.trim()) {
      onNotice('请输入需要扩写的提示词');
      return;
    }
    if (!requireTextService()) return;
    setRunning(true);
    try {
      setExpandResult(await window.imageStudio.runPromptTool({ mode: 'expand', prompt: expandInput }));
      onNotice('提示词扩写完成');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '提示词扩写失败');
    } finally {
      setRunning(false);
    }
  };
  const copyPrompt = async (value: string) => {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      onNotice('提示词已复制');
    } catch {
      onNotice('复制失败，请手动选择文本复制');
    }
  };
  const sendToExpand = () => {
    setExpandInput(reverseResult);
    setMode('expand');
  };

  return (
    <div className="prompt-tools-page">
      <div className="prompt-tools-toolbar">
        <div className="prompt-mode-tabs" role="tablist" aria-label="AI 提示词模式">
          <button type="button" role="tab" aria-selected={mode === 'reverse'} className={mode === 'reverse' ? 'selected' : ''} onClick={() => setMode('reverse')}><ImagePlus size={16} />图片反推</button>
          <button type="button" role="tab" aria-selected={mode === 'expand'} className={mode === 'expand' ? 'selected' : ''} onClick={() => setMode('expand')}><WandSparkles size={16} />提示词扩写</button>
        </div>
        <button type="button" className={settings.hasTextApiKey ? 'prompt-service-state ready' : 'prompt-service-state'} onClick={onOpenSettings}><span />{settings.textModel}</button>
      </div>

      {mode === 'reverse' ? (
        <div className="prompt-tools-workspace">
          <section className="prompt-tool-panel image-analysis-panel">
            <header><div><h2>参考图片</h2><span>{image?.name || '尚未选择图片'}</span></div>{image && <button type="button" className="icon-button" title="移除图片" onClick={() => { setImage(null); setReverseResult(''); }}><X size={16} /></button>}</header>
            <button type="button" className={image ? 'prompt-image-picker has-image' : 'prompt-image-picker'} onClick={pickImage}>
              {image ? <LocalImage asset={image} alt={image.name} /> : <><span><ImagePlus size={28} /></span><strong>选择图片</strong><small>PNG、JPG、JPEG 或 WebP</small></>}
            </button>
            <div className="prompt-panel-actions">
              <button type="button" className="secondary" onClick={pickImage}><RefreshCw size={15} />{image ? '替换图片' : '选择图片'}</button>
              <button type="button" className="primary" disabled={!image || running} onClick={reverse}>{running ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}{running ? '分析中' : '一键反推'}</button>
            </div>
          </section>

          <section className="prompt-tool-panel prompt-result-panel">
            <header><div><h2>中文提示词</h2><span>{reverseResult ? `${reverseResult.length} 字符` : '等待生成'}</span></div><button type="button" className="icon-button" title="复制提示词" disabled={!reverseResult} onClick={() => copyPrompt(reverseResult)}><Copy size={16} /></button></header>
            <textarea value={reverseResult} onChange={(event) => setReverseResult(event.target.value)} placeholder="反推后的通用中文提示词会显示在这里" />
            <div className="prompt-panel-actions result-actions">
              <button type="button" className="secondary" disabled={!reverseResult} onClick={() => copyPrompt(reverseResult)}><Copy size={15} />复制</button>
              <button type="button" className="primary" disabled={!reverseResult} onClick={sendToExpand}>继续扩写<ArrowRight size={15} /></button>
            </div>
          </section>
        </div>
      ) : (
        <div className="prompt-tools-workspace">
          <section className="prompt-tool-panel prompt-input-panel">
            <header><div><h2>原始提示词</h2><span>{expandInput.length} 字符</span></div>{expandInput && <button type="button" className="icon-button" title="清空提示词" onClick={() => { setExpandInput(''); setExpandResult(''); }}><X size={16} /></button>}</header>
            <textarea autoFocus value={expandInput} onChange={(event) => setExpandInput(event.target.value)} placeholder="输入主体、场景或画面想法" />
            <div className="prompt-panel-actions single-action">
              <button type="button" className="primary" disabled={!expandInput.trim() || running} onClick={expand}>{running ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}{running ? '扩写中' : '一键扩写'}</button>
            </div>
          </section>

          <section className="prompt-tool-panel prompt-result-panel">
            <header><div><h2>润色结果</h2><span>{expandResult ? `${expandResult.length} 字符` : '等待生成'}</span></div><button type="button" className="icon-button" title="复制提示词" disabled={!expandResult} onClick={() => copyPrompt(expandResult)}><Copy size={16} /></button></header>
            <textarea value={expandResult} onChange={(event) => setExpandResult(event.target.value)} placeholder="扩写润色后的提示词会显示在这里" />
            <div className="prompt-panel-actions result-actions">
              <button type="button" className="secondary" disabled={!expandResult} onClick={() => copyPrompt(expandResult)}><Copy size={15} />复制</button>
              <button type="button" className="primary" disabled={!expandInput.trim() || running} onClick={expand}><RefreshCw size={15} />重新扩写</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SettingsPage({
  settings,
  workspaceDirectory,
  outputDirectory,
  configFile,
  onSaved,
}: {
  settings: PublicSettings;
  workspaceDirectory: string;
  outputDirectory: string;
  configFile: string;
  onSaved: (settings: PublicSettings) => void;
}) {
  const [form, setForm] = useState({ ...settings, apiKey: '', textApiKey: '' });
  const [saving, setSaving] = useState(false);
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [accessPassword, setAccessPassword] = useState('');
  const [accessError, setAccessError] = useState('');
  const unlockSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accessPassword === SETTINGS_ACCESS_PASSWORD) {
      setSettingsUnlocked(true);
      setAccessError('');
      return;
    }
    setAccessError('密码错误，请重新输入');
    setAccessPassword('');
  };
  const save = async () => {
    setSaving(true);
    try {
      const result = await window.imageStudio.saveSettings({
        defaultModel: form.defaultModel,
        invocationMode: form.invocationMode,
        apiKey: form.apiKey,
        textModel: form.textModel,
        textApiKey: form.textApiKey,
      });
      onSaved(result);
      setForm((current) => ({ ...current, ...result, apiKey: '', textApiKey: '' }));
    } finally {
      setSaving(false);
    }
  };
  if (!settingsUnlocked) {
    return <div className="settings-lock-page"><form className="settings-lock-card" onSubmit={unlockSettings}>
      <div className="settings-lock-icon"><LockKeyhole size={24} /></div>
      <h2>设置已锁定</h2>
      <p>输入设置密码后查看和修改服务卡密及工作目录。</p>
      <label>设置密码<input type="password" autoFocus autoComplete="current-password" value={accessPassword} onChange={(event) => { setAccessPassword(event.target.value); setAccessError(''); }} placeholder="请输入密码" /></label>
      {accessError && <div className="settings-lock-error">{accessError}</div>}
      <button type="submit" className="primary" disabled={!accessPassword}>进入设置</button>
    </form></div>;
  }
  return (
    <div className="settings-page">
      <section className="settings-section">
        <div className="settings-heading"><div className="settings-icon"><Settings size={18} /></div><div><h2>生图服务</h2><p>卡密只保存在当前电脑</p></div></div>
        <div className="settings-form">
          <label>卡密<input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={form.hasApiKey ? '已安全保存，留空则不修改' : '输入卡密'} /></label>
          <label>调用模式<select value={form.invocationMode} onChange={(event) => setForm({ ...form, invocationMode: event.target.value as PublicSettings['invocationMode'] })}><option value="async">异步模式（默认）</option><option value="sync">同步模式</option></select></label>
          <label>默认模型<input value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} /></label>
          <button type="button" className="primary save-settings" onClick={save} disabled={saving}><Save size={16} />{saving ? '保存中' : '保存设置'}</button>
        </div>
      </section>
      <section className="settings-section text-service-settings">
        <div className="settings-heading"><div className="settings-icon"><WandSparkles size={18} /></div><div><h2>AI 文字服务</h2><p>OpenAI 兼容接口，用于图片反推与提示词扩写</p></div></div>
        <div className="settings-form">
          <label>文字模型<input value={form.textModel} onChange={(event) => setForm({ ...form, textModel: event.target.value })} placeholder="gpt-5.6-sol" /></label>
          <label>文字服务卡密<input type="password" autoComplete="off" value={form.textApiKey} onChange={(event) => setForm({ ...form, textApiKey: event.target.value })} placeholder={form.hasTextApiKey ? '已安全保存，留空则不修改' : '输入卡密（API Key）'} /></label>
          <button type="button" className="primary save-settings" onClick={save} disabled={saving}><Save size={16} />{saving ? '保存中' : '保存服务设置'}</button>
        </div>
      </section>
      <section className="settings-section workspace-settings">
        <div className="settings-heading"><div className="settings-icon"><FolderOpen size={18} /></div><div><h2>工作目录</h2><p>图片、配置和本地数据的保存位置</p></div></div>
        <div className="settings-form path-form">
          <label>应用数据目录<input value={workspaceDirectory} readOnly /></label>
          <label>图片输出目录<input value={outputDirectory} readOnly /></label>
          <label>配置文件<input value={configFile} readOnly /></label>
          <button type="button" className="secondary open-workspace" onClick={() => window.imageStudio.openWorkspaceDirectory()}><FolderOpen size={16} />打开工作目录</button>
        </div>
      </section>
      <section className="local-note"><Check size={18} /><div><h3>本地优先</h3><p>草稿、参考图、生成结果与历史记录保存在本机；应用不包含账号系统或统计上报。</p></div></section>
    </div>
  );
}

function EmptyState({ icon: Icon, title, action }: { icon: typeof Image; title: string; action: string }) {
  return <div className="empty-state"><div><Icon size={24} /></div><h2>{title}</h2><p>{action}</p></div>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => emptySnapshot());
  const [page, setPage] = useState<PageId>('studio');
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [notice, setNotice] = useState('');
  const draft = snapshot.draft;

  const refresh = useCallback(async () => {
    const latest = await window.imageStudio.getSnapshot();
    const initializeQueueRandom = latest.draft.mode === 'template' && !latest.draft.queueRandomInitialized;
    if (latest.draft.tasks.length === 0 && latest.draft.mode !== 'template') latest.draft.tasks = [createTask(1, latest.tagGroups[0])];
    else latest.draft.tasks = latest.draft.tasks.map((task) => {
      const group = latest.tagGroups.find((item) => item.id === task.tagGroupId) ?? latest.tagGroups[0];
      if (!group) return task;
      const subcategory = group.subcategories.find((item) => item.id === task.tagSubcategoryId) ?? group.subcategories[0];
      if (!subcategory) return task;
      if (latest.draft.mode === 'template') {
        const dimensions = initializeQueueRandom ? {} : task.dimensions;
        const normalized = { ...task, tagGroupId: group.id, tagSubcategoryId: subcategory.id, category: subcategory.name, dimensions };
        return initializeQueueRandom || !task.prompt.trim() ? { ...normalized, prompt: composePrompt(normalized, group, subcategory) } : normalized;
      }
      const hasCurrentDimensions = subcategory.dimensions.some((dimension) => Boolean(task.dimensions[dimension.name]));
      const usesLegacyPrompt = !task.prompt.trim() || task.prompt.includes('写实商业人像摄影，成年亚洲模特');
      if (hasCurrentDimensions && task.tagSubcategoryId === subcategory.id && !usesLegacyPrompt) return task;
      if (hasCurrentDimensions && task.tagSubcategoryId === subcategory.id) return { ...task, prompt: composePrompt(task, group, subcategory) };
      const dimensions = Object.fromEntries(subcategory.dimensions.filter((dimension) => dimension.tags[0]).map((dimension) => [dimension.name, dimension.tags[0].name]));
      const migrated = { ...task, tagGroupId: group.id, tagSubcategoryId: subcategory.id, category: subcategory.name, dimensions };
      return { ...migrated, prompt: composePrompt(migrated, group, subcategory) };
    });
    if (latest.draft.mode === 'template') latest.draft.queueRandomInitialized = true;
    setSnapshot(latest);
    setLoaded(true);
    return latest;
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      setNotice(error instanceof Error ? error.message : '桌面服务初始化失败');
      setLoaded(true);
    });
    return window.imageStudio.onGenerationProgress((nextProgress) => {
      setProgress(nextProgress);
      if (!nextProgress.record) return;
      setSnapshot((current) => ({
        ...current,
        generations: [nextProgress.record!, ...current.generations.filter((record) => record.id !== nextProgress.record!.id)],
        batches: current.batches.map((batch) => batch.id === nextProgress.batchId ? {
          ...batch,
          completed: nextProgress.completed,
          succeeded: nextProgress.succeeded,
          failed: nextProgress.failed,
          status: nextProgress.completed >= nextProgress.total ? 'completed' : 'running',
          completedAt: nextProgress.completed >= nextProgress.total ? new Date().toISOString() : batch.completedAt,
        } : batch),
      }));
    });
  }, [refresh]);

  useEffect(() => window.imageStudio.onDataChanged(() => { void refresh(); }), [refresh]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => window.imageStudio.saveDraft(draft).catch(() => undefined), 450);
    return () => window.clearTimeout(timer);
  }, [draft, loaded]);

  useEffect(() => {
    if (!loaded || !snapshot.generations.some((record) => record.status === 'pending')) return;
    const timer = window.setInterval(() => { void refresh(); }, 8_000);
    return () => window.clearInterval(timer);
  }, [loaded, refresh, snapshot.generations]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updateDraft = (next: DraftState) => setSnapshot((current) => ({ ...current, draft: next }));
  const visibleTasks = useMemo(() => {
    if (draft.mode === 'single') return draft.tasks.slice(0, 1);
    if (draft.mode === 'template') return draft.tasks.filter((task) => Boolean(task.references.garment));
    return draft.tasks;
  }, [draft]);
  const generate = async () => {
    if (!snapshot.settings.hasApiKey) {
      setPage('settings');
      setNotice('请先配置卡密');
      return;
    }
    if (visibleTasks.length === 0) {
      setNotice('请至少添加一款服装参考图');
      return;
    }
    if (draft.mode === 'template' && visibleTasks.some((task) => {
      const preset = snapshot.templates.find((item) => item.id === task.queuePresetId);
      return !(preset ? preset.sharedFront : draft.queueShared.front);
    })) {
      setNotice('队列中有款式缺少共享或独立预设的正面人脸图');
      return;
    }
    const requestTasks = draft.mode === 'template'
      ? visibleTasks.flatMap((task) => {
          const preset = snapshot.templates.find((item) => item.id === task.queuePresetId);
          const group = snapshot.tagGroups.find((item) => item.id === (preset?.tagGroupId ?? task.tagGroupId)) ?? snapshot.tagGroups[0];
          const subcategory = group?.subcategories.find((item) => item.id === (preset?.tagSubcategoryId ?? task.tagSubcategoryId)) ?? group?.subcategories[0];
          const output = preset?.queueOutput ?? draft.queueOutput;
          const sharedFront = preset ? preset.sharedFront ?? null : draft.queueShared.front;
          const sharedSide = preset ? preset.sharedSide ?? null : draft.queueShared.side;
          if (!sharedFront) return [];
          const references = { ...task.references, sharedFront, sharedSide };
          const fixedDimensions = preset?.dimensions ?? task.dimensions;
          const directions = [
            { name: '正面', direction: 'front' as const, ratios: normalizedGenerationRatios(output.frontRatios, output.frontRatio) },
            { name: '侧面', direction: 'side' as const, ratios: normalizedGenerationRatios(output.sideRatios, output.sideRatio) },
          ];
          return directions.flatMap((direction) => direction.ratios.flatMap((ratio) => Array.from({ length: queueRatioQuantity(output, direction.direction, ratio) }, (_, index) => {
            const dimensions = resolveRandomDimensions(subcategory, fixedDimensions);
            const generatedTask: GenerationTask = {
              ...task,
              name: `${task.name} ${direction.name} ${ratio} ${String(index + 1).padStart(2, '0')}`,
              tagGroupId: group?.id ?? task.tagGroupId,
              tagSubcategoryId: subcategory?.id ?? task.tagSubcategoryId,
              category: subcategory?.name ?? task.category,
              direction: direction.name,
              ratio,
              resolution: preset?.resolution ?? task.resolution,
              model: modelForResolution(preset?.model ?? task.model ?? draft.model, preset?.resolution ?? task.resolution),
              quantity: 1,
              dimensions,
              references,
              prompt: '',
            };
            const defaultBasePrompt = composePrompt({ ...task, dimensions: fixedDimensions }, group, subcategory);
            const savedBasePrompt = (preset?.prompt ?? task.prompt).trim();
            if (savedBasePrompt && savedBasePrompt !== defaultBasePrompt) {
              const randomBlock = (subcategory?.dimensions ?? []).filter((dimension) => !fixedDimensions[dimension.name]).map((dimension) => {
                const selectedName = dimensions[dimension.name];
                const selectedTag = dimension.tags.find((tag) => tag.name === selectedName);
                return `${dimension.name}：${selectedTag?.prompt || selectedName}`;
              }).join('\n');
              return { ...generatedTask, prompt: `${savedBasePrompt}\n\n展示方向：${direction.name}${randomBlock ? `\n本张随机标签：\n${randomBlock}` : ''}` };
            }
            return { ...generatedTask, prompt: composePrompt(generatedTask, group, subcategory) };
          })));
        })
      : visibleTasks.flatMap((task) => {
          const ratios = normalizedGenerationRatios(draft.outputRatios, task.ratio || '3:4');
          return ratios.map((ratio) => ({
            ...task,
            name: ratios.length > 1 ? `${task.name} ${ratio}` : task.name,
            ratio,
            quantity: taskRatioQuantity(task, ratio),
            model: modelForResolution(task.model || draft.model, task.resolution),
          })).filter((task) => task.quantity > 0);
        });
    if (requestTasks.length === 0) {
      const missingFace = draft.mode === 'template' && visibleTasks.some((task) => {
        const preset = snapshot.templates.find((item) => item.id === task.queuePresetId);
        return !(preset ? preset.sharedFront : draft.queueShared.front);
      });
      setNotice(missingFace ? '队列中有款式缺少共享或独立预设的正面人脸图' : '正面数量和侧面数量不能同时为 0');
      return;
    }
    setGenerating(true);
    setProgress({ batchId: '', completed: 0, total: requestTasks.reduce((sum, task) => sum + task.quantity, 0), succeeded: 0, failed: 0 });
    try {
      await window.imageStudio.startGeneration({ batchTag: draft.batchTag, model: draft.model, source: draft.mode === 'single' ? 'single' : draft.mode === 'template' ? 'template' : 'batch', tasks: requestTasks });
      await refresh();
      setNotice('任务已提交，当前批次完成后才可继续生成');
    } catch (error) {
      setProgress(null);
      setNotice(error instanceof Error ? error.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  };
  const saveTemplates = async (templates: PromptTemplate[]) => {
    setSnapshot((current) => ({ ...current, templates }));
    await window.imageStudio.saveTemplates(templates);
  };
  const saveTags = async (tagGroups: TagGroup[]) => {
    setSnapshot((current) => ({ ...current, tagGroups }));
    await window.imageStudio.saveTags(tagGroups);
    setNotice('标签已保存');
  };
  const applyTemplate = (template: PromptTemplate) => {
    const first = draft.tasks[0] ?? createTask(1, snapshot.tagGroups[0]);
    const group = snapshot.tagGroups.find((item) => item.id === template.tagGroupId) ?? snapshot.tagGroups.find((item) => item.id === first.tagGroupId) ?? snapshot.tagGroups[0];
    const subcategory = group?.subcategories.find((item) => item.id === template.tagSubcategoryId) ?? group?.subcategories[0];
    const dimensions = template.dimensions ?? first.dimensions;
    const tasks = (draft.tasks.length > 0 ? draft.tasks : [first]).map((task) => ({
      ...task,
      tagGroupId: group?.id ?? task.tagGroupId,
      tagSubcategoryId: subcategory?.id ?? task.tagSubcategoryId,
      category: subcategory?.name ?? task.category,
      dimensions: { ...dimensions },
      prompt: template.prompt,
      resolution: template.resolution ?? task.resolution,
    }));
    updateDraft({
      ...draft,
      mode: 'template',
      model: modelForResolution(template.model ?? draft.model, template.resolution ?? first.resolution),
      batchTag: template.batchTag ?? draft.batchTag,
      queueOutput: template.queueOutput ? { ...template.queueOutput } : draft.queueOutput,
      queueShared: { front: template.sharedFront ?? null, side: template.sharedSide ?? null },
      queueRandomInitialized: true,
      tasks,
    });
    setPage('studio');
  };
  const changeStudioMode = (mode: DraftState['mode']) => {
    const sourceTasks = draft.tasks.length > 0 ? draft.tasks : [createTask(1, snapshot.tagGroups[0])];
    if (mode === 'template' && !draft.queueRandomInitialized) {
      const tasks = sourceTasks.map((task) => {
        const group = snapshot.tagGroups.find((item) => item.id === task.tagGroupId) ?? snapshot.tagGroups[0];
        const subcategory = group?.subcategories.find((item) => item.id === task.tagSubcategoryId) ?? group?.subcategories[0];
        const randomizedSeed = { ...task, dimensions: {} };
        return { ...randomizedSeed, prompt: composePrompt(randomizedSeed, group, subcategory) };
      });
      updateDraft({ ...draft, mode, tasks, queueRandomInitialized: true });
      return;
    }
    updateDraft({ ...draft, mode, tasks: sourceTasks });
  };

  return (
    <div className="app-shell">
      <Sidebar page={page} onChange={setPage} />
      <div className="app-main">
        <Topbar page={page} settings={snapshot.settings} onSettings={() => setPage('settings')} mode={draft.mode} onMode={changeStudioMode} />
        <div className="page-body">
          {page === 'studio' && <StudioPage snapshot={snapshot} draft={draft} progress={progress} generating={generating} onDraft={updateDraft} onGenerate={generate} onAssets={(asset) => setSnapshot((current) => ({ ...current, assets: [asset, ...current.assets] }))} />}
          {page === 'workbench' && <WorkbenchPage snapshot={snapshot} draft={draft} onDraft={updateDraft} onRefresh={refresh} onOpenSettings={() => setPage('settings')} onNotice={setNotice} />}
          {page === 'templates' && <TemplatesPage snapshot={snapshot} draft={draft} onSave={saveTemplates} onApply={applyTemplate} onAssets={(asset) => setSnapshot((current) => ({ ...current, assets: [asset, ...current.assets] }))} />}
          {page === 'assets' && <AssetsPage generations={snapshot.generations} />}
          {page === 'prompt-tools' && <PromptToolsPage settings={snapshot.settings} onOpenSettings={() => setPage('settings')} onNotice={setNotice} onAsset={(asset) => setSnapshot((current) => ({ ...current, assets: [asset, ...current.assets] }))} />}
          {page === 'stamp' && <StampPage snapshot={snapshot} draft={draft} onDraft={updateDraft} onRefresh={refresh} onOpenSettings={() => setPage('settings')} onNotice={setNotice} />}
          {page === 'garment3d' && <Garment3DPage snapshot={snapshot} onRefresh={refresh} onOpenSettings={() => setPage('settings')} onNotice={setNotice} />}
          {page === 'detail-generate' && <DetailGeneratePage snapshot={snapshot} onRefresh={refresh} onOpenSettings={() => setPage('settings')} onNotice={setNotice} onAssets={(asset) => setSnapshot((current) => ({ ...current, assets: [asset, ...current.assets] }))} />}
          {page === 'detail' && <DetailPage snapshot={snapshot} draft={draft} onDraft={updateDraft} onRefresh={refresh} onOpenSettings={() => setPage('settings')} onNotice={setNotice} />}
          {page === 'tags' && <TagsPage groups={snapshot.tagGroups} onSave={saveTags} />}
          {page === 'batches' && <BatchesPage snapshot={snapshot} onRefresh={refresh} onNotice={setNotice} />}
          {page === 'settings' && <SettingsPage settings={snapshot.settings} workspaceDirectory={snapshot.workspaceDirectory} outputDirectory={snapshot.outputDirectory} configFile={snapshot.configFile} onSaved={(settings) => { setSnapshot((current) => ({ ...current, settings, draft: { ...current.draft, model: modelForInvocation(current.draft.model, settings.invocationMode), tasks: current.draft.tasks.map((task) => ({ ...task, model: modelForInvocation(task.model || current.draft.model, settings.invocationMode) })) } })); setNotice('设置已保存'); }} />}
        </div>
      </div>
      {notice && <div className="toast"><Check size={16} />{notice}</div>}
    </div>
  );
}
