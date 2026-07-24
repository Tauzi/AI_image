import type {
  AppSnapshot,
  AssetRecord,
  DraftState,
  GenerationProgress,
  PromptTemplate,
  PublicSettings,
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
      deleteBatchRecord: (batchId: string) => Promise<boolean>;
      deleteBatchRecordsBefore: (cutoff: string) => Promise<number>;
      pickImage: () => Promise<AssetRecord | null>;
      pickImages: () => Promise<AssetRecord[]>;
      saveDataImage: (dataUrl: string, name: string) => Promise<AssetRecord>;
      readImage: (localPath: string) => Promise<string>;
      useGenerationAsReference: (localPath: string) => Promise<AssetRecord>;
      startGeneration: (request: {
        batchTag: string;
        model: string;
        source: 'single' | 'batch' | 'template' | 'workbench' | 'stamp' | 'garment3d' | 'detail' | 'detail-generate';
        tasks: DraftState['tasks'];
      }) => Promise<{ batchId: string }>;
      openWorkspaceDirectory: () => Promise<string>;
      openOutputDirectory: () => Promise<string>;
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
