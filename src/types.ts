export type InvocationMode = 'async' | 'sync';
export type GenerationSource = 'single' | 'batch' | 'template' | 'workbench' | 'stamp' | 'garment3d' | 'detail';
export type PageId = 'studio' | 'workbench' | 'templates' | 'assets' | 'stamp' | 'garment3d' | 'detail' | 'tags' | 'batches' | 'settings';

export interface PublicSettings {
  defaultModel: string;
  invocationMode: InvocationMode;
  concurrencyLimit: number;
  hasApiKey: boolean;
}

export interface AssetRecord {
  id: string;
  name: string;
  localPath: string;
  mimeType: string;
  kind: 'reference';
  createdAt: string;
  preview?: string;
}

export interface ReferenceSlots {
  garment: AssetRecord | null;
  side: AssetRecord | null;
  face: AssetRecord | null;
  sharedFront?: AssetRecord | null;
  sharedSide?: AssetRecord | null;
}

export interface StampPostProcess {
  logoAssetId: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
  opacity: number;
  strength: number;
  shadow: number;
  craft: '印刷' | '刺绣' | '烫印';
}

export interface GenerationTask {
  id: string;
  name: string;
  tagGroupId: string;
  tagSubcategoryId: string;
  references: ReferenceSlots;
  dimensions: Record<string, string>;
  direction: string;
  category: string;
  ratio: string;
  resolution: string;
  quantity: number;
  prompt: string;
  model?: string;
  queuePresetId?: string;
  useSharedPrompt?: boolean;
  stampPostProcess?: StampPostProcess;
}

export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  tagGroupId?: string;
  tagSubcategoryId?: string;
  dimensions?: Record<string, string>;
  model?: string;
  resolution?: string;
  batchTag?: string;
  queueOutput?: DraftState['queueOutput'];
  sharedFront?: AssetRecord | null;
  sharedSide?: AssetRecord | null;
}

export interface PromptTag {
  id: string;
  name: string;
  prompt: string;
}

export interface TagCategory {
  id: string;
  name: string;
  tags: PromptTag[];
}

export interface TagGroup {
  id: string;
  name: string;
  promptTemplate: string;
  subcategories: TagSubcategory[];
}

export interface TagSubcategory {
  id: string;
  name: string;
  dimensions: TagCategory[];
}

export interface GenerationRecord {
  id: string;
  batchId: string;
  taskId: string;
  taskName: string;
  source: GenerationSource;
  batchPrefix: string;
  status: 'success' | 'error';
  prompt: string;
  model: string;
  ratio: string;
  resolution: string;
  outputPath: string;
  error: string;
  durationMs: number;
  attempts: number;
  createdAt: string;
}

export interface BatchRecord {
  id: string;
  tag: string;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  status: 'running' | 'completed';
  createdAt: string;
  completedAt: string;
}

export interface DraftState {
  mode: 'single' | 'batch' | 'template';
  batchTag: string;
  model: string;
  tasks: GenerationTask[];
  queueShared: {
    front: AssetRecord | null;
    side: AssetRecord | null;
  };
  queueOutput: {
    frontQuantity: number;
    sideQuantity: number;
    frontRatio: string;
    sideRatio: string;
    frontRatios?: string[];
    sideRatios?: string[];
  };
  queueRandomInitialized?: boolean;
  detailSharedPrompt?: string;
  detailTasks?: GenerationTask[];
  detailBatchTag?: string;
  outputRatios?: string[];
  stampPrompt?: string;
}

export interface AppSnapshot {
  settings: PublicSettings;
  assets: AssetRecord[];
  generations: GenerationRecord[];
  batches: BatchRecord[];
  templates: PromptTemplate[];
  tagGroups: TagGroup[];
  draft: DraftState;
  workspaceDirectory: string;
  outputDirectory: string;
  configFile: string;
}

export interface GenerationProgress {
  batchId: string;
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  record?: GenerationRecord;
}
