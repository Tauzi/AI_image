import { contextBridge, ipcRenderer } from 'electron';
import type {
  DraftState,
  GenerationProgress,
  PromptTemplate,
  PublicSettings,
  StartGenerationRequest,
  TagGroup,
} from './types';

contextBridge.exposeInMainWorld('imageStudio', {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  saveSettings: (settings: Omit<PublicSettings, 'hasApiKey'> & { apiKey?: string }) =>
    ipcRenderer.invoke('settings:save', settings),
  saveDraft: (draft: DraftState) => ipcRenderer.invoke('draft:save', draft),
  saveTemplates: (templates: PromptTemplate[]) => ipcRenderer.invoke('templates:save', templates),
  saveTags: (groups: TagGroup[]) => ipcRenderer.invoke('tags:save', groups),
  deleteBatchRecord: (batchId: string) => ipcRenderer.invoke('batch:delete-record', batchId),
  deleteBatchRecordsBefore: (cutoff: string) => ipcRenderer.invoke('batch:delete-before', cutoff),
  pickImage: () => ipcRenderer.invoke('asset:pick-image'),
  pickImages: () => ipcRenderer.invoke('asset:pick-images'),
  saveDataImage: (dataUrl: string, name: string) => ipcRenderer.invoke('asset:save-data-image', dataUrl, name),
  readImage: (localPath: string) => ipcRenderer.invoke('asset:read-image', localPath),
  useGenerationAsReference: (localPath: string) => ipcRenderer.invoke('asset:use-generation', localPath),
  startGeneration: (request: StartGenerationRequest) => ipcRenderer.invoke('generation:start', request),
  openWorkspaceDirectory: () => ipcRenderer.invoke('workspace:open-directory'),
  openOutputDirectory: () => ipcRenderer.invoke('output:open-directory'),
  revealFile: (localPath: string) => ipcRenderer.invoke('output:reveal-file', localPath),
  copyImage: (localPath: string) => ipcRenderer.invoke('image:copy', localPath),
  downloadImage: (localPath: string, suggestedName: string) => ipcRenderer.invoke('image:download', localPath, suggestedName),
  showImageContextMenu: (localPath: string, suggestedName: string) => ipcRenderer.invoke('image:context-menu', localPath, suggestedName),
  reportMissingImage: (localPath: string) => ipcRenderer.invoke('image:report-missing', localPath),
  deleteImages: (localPaths: string[]) => ipcRenderer.invoke('image:delete-many', localPaths),
  downloadImages: (localPaths: string[]) => ipcRenderer.invoke('image:download-many', localPaths),
  onGenerationProgress: (listener: (progress: GenerationProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: GenerationProgress) => listener(progress);
    ipcRenderer.on('generation:progress', handler);
    return () => ipcRenderer.removeListener('generation:progress', handler);
  },
  onDataChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('app:data-changed', handler);
    return () => ipcRenderer.removeListener('app:data-changed', handler);
  },
});
