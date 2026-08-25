import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

// 后台自动检查的间隔与延迟（毫秒）
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_DELAY_MS = 15 * 1000;

interface UpdateManifest {
  version: string;
  url: string;
  notes?: string;
}

// 内置兜底地址：用户未配置/配置为空/被空值覆盖时使用，保证已分发版本始终可更新
// （VS Code 配置中显式空字符串会覆盖 package.json 默认值，必须代码级兜底）
const FALLBACK_MANIFEST_URL = 'https://ask-trae.tos-cn-beijing.volces.com/plugin/latest.json';

function getManifestUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('traeAsk')
    .get<string>('updateManifestUrl') || '';
  return configured.trim() || FALLBACK_MANIFEST_URL;
}

// 比较语义化版本号（仅支持 x.y.z 数字格式），remote > local 时返回 true
function isNewerVersion(remote: string, local: string): boolean {
  const r = remote.split('.').map((s) => parseInt(s, 10) || 0);
  const l = local.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const diff = (r[i] || 0) - (l[i] || 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 下载 VSIX 到本地（支持 30x 重定向，兼容 TOS/CDN 跳转）
function downloadFile(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 120000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        downloadFile(next, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 检查更新：拉取 latest.json 并与当前版本比较
// silent=true 为后台静默检查（无更新时不打扰用户），false 为用户手动触发
export async function checkForUpdates(
  context: vscode.ExtensionContext,
  silent: boolean
): Promise<void> {
  const manifestUrl = getManifestUrl();
  if (!manifestUrl) {
    throw new Error('未配置更新清单地址（traeAsk.updateManifestUrl）');
  }
  const current = String((context.extension.packageJSON as any)?.version || '0.0.0');
  // 加时间戳参数避免 CDN 缓存旧清单
  const manifest: UpdateManifest = JSON.parse(await fetchText(`${manifestUrl}?t=${Date.now()}`));
  if (!manifest?.version || !manifest?.url) {
    throw new Error('更新清单格式错误');
  }

  if (!isNewerVersion(manifest.version, current)) {
    if (!silent) {
      vscode.window.showInformationMessage(`AskTrae 已是最新版本（v${current}）`);
    }
    return;
  }
  // 用户已选择跳过该版本
  if (context.globalState.get<string>('skippedUpdateVersion') === manifest.version) {
    if (!silent) {
      vscode.window.showInformationMessage(`已跳过 v${manifest.version}（当前 v${current}）`);
    }
    return;
  }

  const message = manifest.notes
    ? `发现新版本 v${manifest.version}：${manifest.notes}`
    : `发现新版本 v${manifest.version}`;
  const choice = await vscode.window.showInformationMessage(
    message,
    '立即更新',
    '跳过此版本'
  );
  if (choice === '跳过此版本') {
    context.globalState.update('skippedUpdateVersion', manifest.version);
    return;
  }
  if (choice !== '立即更新') {
    return;
  }
  await installUpdate(context, manifest);
}

// 下载 VSIX 并调用 VS Code 内置命令覆盖安装（与卸载用的 uninstallExtension 同族）
async function installUpdate(
  context: vscode.ExtensionContext,
  manifest: UpdateManifest
): Promise<void> {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const vsixPath = path.join(dir, `asktrae-${manifest.version}.vsix`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `AskTrae 正在下载 v${manifest.version}...` },
    () => downloadFile(manifest.url, vsixPath)
  );

  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(vsixPath)
    );
  } catch (err: any) {
    // 自动安装失败时降级为引导手动安装
    const open = '打开下载链接';
    const fallback = await vscode.window.showErrorMessage(
      `自动更新失败（${err?.message || err}），请手动下载安装`,
      open
    );
    if (fallback === open) {
      vscode.env.openExternal(vscode.Uri.parse(manifest.url));
    }
    return;
  } finally {
    try { fs.unlinkSync(vsixPath); } catch { /* 清理失败可忽略 */ }
  }

  const reload = '重新加载';
  const done = await vscode.window.showInformationMessage(
    `AskTrae 已更新到 v${manifest.version}，重新加载窗口后生效`,
    reload
  );
  if (done === reload) {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

// 激活时调用：按 24h 节流调度后台检查
export function initUpdateChecker(context: vscode.ExtensionContext): void {
  const last = context.globalState.get<number>('lastUpdateCheckTs') || 0;
  if (Date.now() - last < CHECK_INTERVAL_MS) {
    return;
  }
  context.globalState.update('lastUpdateCheckTs', Date.now());
  // 延迟触发，不与启动流程抢资源
  setTimeout(() => {
    checkForUpdates(context, true).catch((err: any) => {
      console.log(`[asktrae] update check failed: ${err?.message || err}`);
    });
  }, CHECK_DELAY_MS);
}
