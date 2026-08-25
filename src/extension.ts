import * as vscode from 'vscode';
import * as fs from 'fs';
import { WebviewProvider } from './webviewProvider';
import { Secrets } from './secrets';
import { GoBridge } from './goBridge';
import { initUpdateChecker, checkForUpdates } from './updater';

export const EXTENSION_ID = 'trae-cn.asktrae';

let webviewProviderRef: WebviewProvider | undefined;

function shutdownExtension(reason: string) {
  if (GoBridge.isDisposed()) return;
  console.log(`[asktrae] shutting down: ${reason}`);
  GoBridge.dispose();
  webviewProviderRef?.notifyUninstalled();
}

export function activate(context: vscode.ExtensionContext) {
  // 初始化密钥管理
  Secrets.init(context.secrets);

  // 首次激活上报（fire-and-forget，失败不影响主流程）
  if (!context.globalState.get('installReported')) {
    context.globalState.update('installReported', true);
    const pluginVer = (context.extension.packageJSON as any)?.version || 'unknown';
    GoBridge.query(context, {
      id: `track-install-${Date.now()}`,
      type: 'track',
      event: 'install',
      machine_id: vscode.env.machineId,
      platform: `${process.platform}-${process.arch}`,
      plugin_ver: pluginVer,
    }).catch(() => {});
  }

  webviewProviderRef = new WebviewProvider(context);

  // 注册 Webview 视图
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'traeAsk.chatView',
      webviewProviderRef,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 初始化自动更新检查（24h 节流，延迟触发，失败静默）
  initUpdateChecker(context);

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('traeAsk.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.trae-ask');
    }),
    vscode.commands.registerCommand('traeAsk.clearChat', () => {
      webviewProviderRef?.clearChat();
    }),
    vscode.commands.registerCommand('traeAsk.checkUpdate', () => {
      checkForUpdates(context, false).catch((err: any) => {
        vscode.window.showErrorMessage(`检查更新失败: ${err?.message || err}`);
      });
    })
  );

  // 监听扩展变更：当用户在扩展面板卸载/禁用本插件但未 reload 时，
  // 通过多重检测确认插件已被移除，立即清理 Go 子进程
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      // 检测方式 1：getExtension 返回 null/undefined
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      if (!ext) {
        shutdownExtension('extension removed from registry');
        return;
      }
      // 检测方式 2：扩展目录已被删除（VS Code 卸载时会立即删除磁盘文件）
      try {
        if (!fs.existsSync(context.extensionPath)) {
          shutdownExtension('extension directory deleted');
          return;
        }
      } catch {
        // fs 访问异常也视为已卸载
        shutdownExtension('fs access error on extension path');
      }
    })
  );
}

export function deactivate() {
  shutdownExtension('deactivate() called');
}
