import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateImage, resumeImageTask } from './image-api';
import { LocalStore } from './store';
import type {
  DraftState,
  GenerationRecord,
  PromptTemplate,
  PublicSettings,
  StampPostProcess,
  StartGenerationRequest,
  TagGroup,
} from './types';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f6f7fb',
    show: false,
    title: '苜芬绘图AI',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { void resumePendingGenerations(); }, 500);
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时，请检查服务状态或稍后重试';
    return error.message;
  }
  return '未知生成错误';
}

function createBatchPrefix(source: StartGenerationRequest['source']): string {
  const type = source === 'single'
    ? 'SINGLE'
    : source === 'template'
      ? 'TEMPLATE'
      : source === 'workbench'
        ? 'WORKBENCH'
        : source === 'stamp'
          ? 'STAMP'
          : source === 'garment3d'
            ? 'GARMENT3D'
            : source === 'detail'
              ? 'DETAIL'
            : 'MULTI';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${type}-${timestamp}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function blendPixel(target: Buffer, offset: number, blue: number, green: number, red: number, alpha: number): void {
  const sourceAlpha = clamp01(alpha);
  if (sourceAlpha <= 0) return;
  const targetAlpha = target[offset + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  target[offset] = Math.round((blue * sourceAlpha + target[offset] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[offset + 1] = Math.round((green * sourceAlpha + target[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[offset + 2] = Math.round((red * sourceAlpha + target[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  target[offset + 3] = Math.round(outputAlpha * 255);
}

function applyStampPostProcess(baseBytes: Buffer, logoPath: string, config: StampPostProcess): Buffer {
  const baseImage = nativeImage.createFromBuffer(baseBytes);
  const baseSize = baseImage.getSize();
  if (baseImage.isEmpty() || baseSize.width < 1 || baseSize.height < 1) throw new Error('贴标后处理无法读取生成图片');
  const originalLogo = nativeImage.createFromPath(logoPath);
  const logoSize = originalLogo.getSize();
  if (originalLogo.isEmpty() || logoSize.width < 1 || logoSize.height < 1) throw new Error('贴标后处理无法读取 Logo 图片');

  const targetWidth = Math.max(1, Math.min(baseSize.width, Math.round(baseSize.width * Math.max(1, config.size) / 100)));
  const resizedLogo = originalLogo.resize({ width: targetWidth, quality: 'best' });
  const resizedSize = resizedLogo.getSize();
  const logoBitmap = resizedLogo.toBitmap();
  const output = Buffer.from(baseImage.toBitmap());
  if (output.length < baseSize.width * baseSize.height * 4 || logoBitmap.length < resizedSize.width * resizedSize.height * 4) {
    throw new Error('贴标后处理图片像素数据不完整');
  }

  const angle = (Number(config.rotation) || 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const centerX = baseSize.width * Math.min(100, Math.max(0, config.x)) / 100;
  const centerY = baseSize.height * Math.min(100, Math.max(0, config.y)) / 100;
  const halfBoundsWidth = Math.abs(cosine) * resizedSize.width / 2 + Math.abs(sine) * resizedSize.height / 2;
  const halfBoundsHeight = Math.abs(sine) * resizedSize.width / 2 + Math.abs(cosine) * resizedSize.height / 2;

  const drawLayer = (layerCenterX: number, layerCenterY: number, alphaMultiplier: number, shadowLayer: boolean) => {
    const minX = Math.max(0, Math.floor(layerCenterX - halfBoundsWidth - 1));
    const maxX = Math.min(baseSize.width - 1, Math.ceil(layerCenterX + halfBoundsWidth + 1));
    const minY = Math.max(0, Math.floor(layerCenterY - halfBoundsHeight - 1));
    const maxY = Math.min(baseSize.height - 1, Math.ceil(layerCenterY + halfBoundsHeight + 1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - layerCenterX;
        const dy = y + 0.5 - layerCenterY;
        const sourceX = Math.floor(cosine * dx + sine * dy + resizedSize.width / 2);
        const sourceY = Math.floor(-sine * dx + cosine * dy + resizedSize.height / 2);
        if (sourceX < 0 || sourceX >= resizedSize.width || sourceY < 0 || sourceY >= resizedSize.height) continue;
        const sourceOffset = (sourceY * resizedSize.width + sourceX) * 4;
        const sourceAlpha = logoBitmap[sourceOffset + 3] / 255 * alphaMultiplier;
        if (sourceAlpha <= 0.002) continue;
        const targetOffset = (y * baseSize.width + x) * 4;
        if (shadowLayer) blendPixel(output, targetOffset, 0, 0, 0, sourceAlpha);
        else blendPixel(output, targetOffset, logoBitmap[sourceOffset], logoBitmap[sourceOffset + 1], logoBitmap[sourceOffset + 2], sourceAlpha);
      }
    }
  };

  const shadowAmount = clamp01(config.shadow);
  if (shadowAmount > 0) {
    const offset = Math.max(1, Math.round(Math.min(baseSize.width, baseSize.height) * (0.002 + shadowAmount * 0.004)));
    drawLayer(centerX + offset, centerY + offset, shadowAmount * 0.35, true);
  }
  const materialStrength = 0.65 + clamp01(config.strength) * 0.35;
  drawLayer(centerX, centerY, clamp01(config.opacity) * materialStrength, false);
  return nativeImage.createFromBitmap(output, { width: baseSize.width, height: baseSize.height, scaleFactor: 1 }).toPNG();
}

async function runBatch(request: StartGenerationRequest): Promise<{ batchId: string }> {
  const batchPrefix = createBatchPrefix(request.source);
  const jobs = request.tasks.flatMap((task) =>
    Array.from({ length: Math.max(1, Math.floor(task.quantity)) }, (_, index) => ({ task, index })),
  ).map((job, sequence) => {
    const safeName = job.task.name.replace(/[<>:\"/\\|?*]/g, '-').slice(0, 40) || 'image';
    return { ...job, sequence, recordId: randomUUID(), outputBaseName: `${batchPrefix}_${safeName}_${String(sequence + 1).padStart(3, '0')}_${job.index + 1}` };
  });
  if (jobs.length === 0) throw new Error('请至少新增一个生成任务');
  if (jobs.some(({ task }) => !task.prompt.trim())) throw new Error('任务提示词不能为空');
  const batch = store.createBatch(`${batchPrefix}-${request.batchTag}`, jobs.length);
  const { settings, apiKey } = store.getSettingsForGeneration();
  let cursor = 0;
  const createdAt = new Date().toISOString();
  jobs.forEach((job) => store.addGeneration({
    id: job.recordId, batchId: batch.id, taskId: job.task.id, taskName: job.task.name,
    source: request.source, batchPrefix, status: 'pending', prompt: job.task.prompt,
    model: job.task.model || request.model || settings.defaultModel, ratio: job.task.ratio,
    resolution: job.task.resolution, outputPath: '', error: '', durationMs: 0, attempts: 0, createdAt,
    outputBaseName: job.outputBaseName, stampPostProcess: job.task.stampPostProcess,
  }));

  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const current = jobs[cursor];
      cursor += 1;
      const started = Date.now();
      let record: GenerationRecord;
      try {
        const referenceIds = Array.from(new Set([...Object.values(current.task.references), ...(current.task.detailAssets ?? [])]
          .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
          .map((asset) => asset.id)));
        const references = referenceIds.map((id) => store.getAsset(id)).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
        const generated = await generateImage({
          settings,
          apiKey,
          prompt: current.task.prompt,
          model: current.task.model || request.model || settings.defaultModel,
          ratio: current.task.ratio,
          resolution: current.task.resolution,
          references,
          onTaskAccepted: (remoteKind, remoteTaskId) => store.updateGeneration(current.recordId, { remoteKind, remoteTaskId }),
        });
        let outputBytes = generated.bytes;
        let outputExtension = generated.extension;
        if (current.task.stampPostProcess) {
          const logoAsset = store.getAsset(current.task.stampPostProcess.logoAssetId);
          if (!logoAsset) throw new Error('贴标 Logo 素材不存在，请重新上传');
          outputBytes = applyStampPostProcess(generated.bytes, logoAsset.localPath, current.task.stampPostProcess);
          outputExtension = '.png';
        }
        const outputPath = path.join(
          store.outputDirectory,
          `${current.outputBaseName}${outputExtension}`,
        );
        fs.writeFileSync(outputPath, outputBytes);
        record = {
          id: current.recordId,
          batchId: batch.id,
          taskId: current.task.id,
          taskName: current.task.name,
          source: request.source,
          batchPrefix,
          status: 'success',
          prompt: current.task.prompt,
          model: current.task.model || request.model || settings.defaultModel,
          ratio: current.task.ratio,
          resolution: current.task.resolution,
          outputPath,
          error: '',
          durationMs: Date.now() - started,
          attempts: generated.attempts,
          createdAt: new Date().toISOString(),
        };
      } catch (error) {
        record = {
          id: current.recordId,
          batchId: batch.id,
          taskId: current.task.id,
          taskName: current.task.name,
          source: request.source,
          batchPrefix,
          status: 'error',
          prompt: current.task.prompt,
          model: current.task.model || request.model || settings.defaultModel,
          ratio: current.task.ratio,
          resolution: current.task.resolution,
          outputPath: '',
          error: errorMessage(error),
          durationMs: Date.now() - started,
          attempts: (error as { attempts?: number })?.attempts ?? 0,
          createdAt: new Date().toISOString(),
        };
      }
      store.completeGeneration(record);
      const currentBatch = store.getBatch(batch.id);
      if (currentBatch) {
        mainWindow?.webContents.send('generation:progress', {
          batchId: batch.id,
          completed: currentBatch.completed,
          total: currentBatch.total,
          succeeded: currentBatch.succeeded,
          failed: currentBatch.failed,
          record,
        });
      }
    }
  };

  setImmediate(() => {
    void Promise.all(Array.from({ length: jobs.length }, () => worker())).catch(() => undefined);
  });
  return { batchId: batch.id };
}

async function resumePendingGenerations(): Promise<void> {
  const pending = store.pendingGenerations();
  if (pending.length === 0) return;
  const { apiKey } = store.getSettingsForGeneration();
  await Promise.all(pending.map(async (record) => {
    const started = Date.now();
    try {
      if (!record.remoteTaskId || !record.remoteKind) throw new Error('旧任务未保存远程 taskId，无法自动恢复，请重新提交');
      const generated = await resumeImageTask(record.remoteKind, record.remoteTaskId, apiKey);
      let outputBytes = generated.bytes;
      let outputExtension = generated.extension;
      if (record.stampPostProcess) {
        const logoAsset = store.getAsset(record.stampPostProcess.logoAssetId);
        if (!logoAsset) throw new Error('贴标 Logo 素材不存在，无法恢复后处理');
        outputBytes = applyStampPostProcess(generated.bytes, logoAsset.localPath, record.stampPostProcess);
        outputExtension = '.png';
      }
      const outputPath = path.join(store.outputDirectory, `${record.outputBaseName || record.id}${outputExtension}`);
      fs.writeFileSync(outputPath, outputBytes);
      store.completeGeneration({ ...record, status: 'success', outputPath, error: '', durationMs: Date.now() - started, attempts: generated.attempts });
    } catch (error) {
      store.completeGeneration({ ...record, status: 'error', error: errorMessage(error), durationMs: Date.now() - started });
    }
    const batch = store.getBatch(record.batchId);
    if (batch) mainWindow?.webContents.send('generation:progress', { batchId: batch.id, completed: batch.completed, total: batch.total, succeeded: batch.succeeded, failed: batch.failed });
  }));
}

app.whenReady().then(() => {
  app.setName('苜芬绘图AI');
  app.setAppUserModelId('com.mufen.imageai');
  Menu.setApplicationMenu(null);
  store = new LocalStore();
  ipcMain.handle('app:get-snapshot', () => store.snapshot());
  ipcMain.handle('settings:save', (_event, settings: Omit<PublicSettings, 'hasApiKey'> & { apiKey?: string }) =>
    store.updateSettings(settings),
  );
  ipcMain.handle('draft:save', (_event, draft: DraftState) => store.saveDraft(draft));
  ipcMain.handle('templates:save', (_event, templates: PromptTemplate[]) => store.saveTemplates(templates));
  ipcMain.handle('tags:save', (_event, groups: TagGroup[]) => store.saveTags(groups));
  ipcMain.handle('batch:delete-record', (_event, batchId: string) => store.deleteBatchRecord(batchId));
  ipcMain.handle('batch:delete-before', (_event, cutoff: string) => store.deleteBatchRecordsBefore(cutoff));
  ipcMain.handle('asset:pick-image', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择参考图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return null;
    const asset = store.importAsset(selection.filePaths[0]);
    return { ...asset, preview: store.readImageAsDataUrl(asset.localPath) };
  });
  ipcMain.handle('asset:pick-images', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '批量选择参考图',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled) return [];
    return selection.filePaths.map((filePath) => {
      const asset = store.importAsset(filePath);
      return { ...asset, preview: store.readImageAsDataUrl(asset.localPath) };
    });
  });
  ipcMain.handle('asset:read-image', (_event, localPath: string) => store.readImageAsDataUrl(localPath));
  ipcMain.handle('asset:save-data-image', (_event, dataUrl: string, name: string) => {
    const asset = store.saveDataImage(dataUrl, name);
    return { ...asset, preview: store.readImageAsDataUrl(asset.localPath) };
  });
  ipcMain.handle('asset:use-generation', (_event, localPath: string) => {
    const asset = store.importGeneratedImage(localPath);
    return { ...asset, preview: store.readImageAsDataUrl(asset.localPath) };
  });
  ipcMain.handle('generation:start', (_event, request: StartGenerationRequest) => runBatch(request));
  ipcMain.handle('workspace:open-directory', () => shell.openPath(store.snapshot().workspaceDirectory));
  ipcMain.handle('output:open-directory', () => shell.openPath(store.outputDirectory));
  ipcMain.handle('output:reveal-file', (_event, localPath: string) => shell.showItemInFolder(localPath));
  ipcMain.handle('image:copy', (_event, localPath: string) => {
    const image = nativeImage.createFromPath(localPath);
    if (image.isEmpty()) throw new Error('无法读取图片');
    clipboard.writeImage(image);
  });
  ipcMain.handle('image:download', async (_event, localPath: string, suggestedName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: suggestedName || path.basename(localPath) });
    if (result.canceled || !result.filePath) return false;
    fs.copyFileSync(localPath, result.filePath);
    return true;
  });
  ipcMain.handle('image:context-menu', (event, localPath: string, suggestedName: string) => {
    Menu.buildFromTemplate([
      { label: '复制图片', click: () => clipboard.writeImage(nativeImage.createFromPath(localPath)) },
      { label: '下载图片…', click: async () => {
        const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: suggestedName || path.basename(localPath) });
        if (!result.canceled && result.filePath) fs.copyFileSync(localPath, result.filePath);
      } },
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined });
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
