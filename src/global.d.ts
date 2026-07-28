import type {
  AppSnapshot,
  AssetRecord,
  DraftState,
  GenerationProgress,
  GenerationRecord,
  PromptTemplate,
  PublicSettings,
  ResourceCategory,
  SettingsInput,
  TagGroup,
} from './types';

declare module '*.css';

declare global {
  interface Window {
    imageStudio: {
      getSnapshot: () => Promise<AppSnapshot>;
      saveSettings: (settings: SettingsInput) => Promise<PublicSettings>;
      saveDraft: (draft: DraftState) => Promise<void>;
      saveTemplates: (templates: PromptTemplate[]) => Promise<void>;
      saveTags: (groups: TagGroup[]) => Promise<void>;
      saveResourceCategories: (categories: ResourceCategory[]) => Promise<ResourceCategory[]>;
      updateResource: (assetId: string, update: { name?: string; resourceCategoryId?: string; resourceProcessingPrompt?: string }) => Promise<AssetRecord>;
      addGenerationToResource: (recordId: string, categoryId: string) => Promise<AssetRecord>;
      pickResourceImages: (categoryId: string) => Promise<AssetRecord[]>;
      deleteBatchRecord: (batchId: string) => Promise<boolean>;
      deleteBatchRecordsBefore: (cutoff: string) => Promise<number>;
      pickImage: () => Promise<AssetRecord | null>;
      pickImages: () => Promise<AssetRecord[]>;
      pasteImage: () => Promise<AssetRecord | null>;
      saveDataImage: (dataUrl: string, name: string) => Promise<AssetRecord>;
      readImage: (localPath: string) => Promise<string>;
      useGenerationAsReference: (localPath: string) => Promise<AssetRecord>;
      startGeneration: (request: {
        batchTag: string;
        model: string;
        source: 'single' | 'batch' | 'template' | 'product-main' | 'product-main-square' | 'workbench' | 'stamp' | 'garment3d' | 'resource' | 'detail' | 'detail-generate' | 'sku';
        tasks: DraftState['tasks'];
      }) => Promise<{ batchId: string }>;
      retryGeneration: (recordId: string) => Promise<{ batchId: string }>;
      setGenerationReview: (recordId: string, reviewStatus: 'qualified' | 'rejected' | null) => Promise<GenerationRecord>;
      generateProductMainPrompts: (assetId: string, ratioLabel: string) => Promise<string>;
      clearProductMainRecords: () => Promise<number>;
      openWorkspaceDirectory: () => Promise<string>;
      openOutputDirectory: () => Promise<string>;
      chooseOutputDirectory: () => Promise<string>;
      revealFile: (localPath: string) => Promise<void>;
      copyImage: (localPath: string) => Promise<void>;
      downloadImage: (localPath: string, suggestedName: string) => Promise<boolean>;
      showImageContextMenu: (localPath: string, suggestedName: string) => Promise<void>;
      reportMissingImage: (localPath: string) => Promise<boolean>;
      deleteImages: (localPaths: string[]) => Promise<number>;
      downloadImages: (localPaths: string[]) => Promise<{ count: number; directory: string }>;
      onGenerationProgress: (listener: (progress: GenerationProgress) => void) => () => void;
      onDataChanged: (listener: () => void) => () => void;
    };
  }
}

export {};
