import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { Secrets } from './secrets';
import { GoBridge } from './goBridge';

export const EXTENSION_ID = 'trae-cn.trae-ask';

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

  const webviewProvider = new WebviewProvider(context);

  // 注册 Webview 视图
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'traeAsk.chatView',
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('traeAsk.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.trae-ask');
    }),
    vscode.commands.registerCommand('traeAsk.clearChat', () => {
      webviewProvider.clearChat();
    }),
    // 手动卸载命令：用户可通过命令面板或 webview 按钮触发
    vscode.commands.registerCommand('traeAsk.uninstall', async () => {
      const choice = await vscode.window.showWarningMessage(
        '确定要卸载 Trae Ask 插件吗？卸载后需要重新加载窗口以完成。',
        { modal: true },
        '卸载'
      );
      if (choice !== '卸载') return;
      // 先清理 Go 子进程
      GoBridge.dispose();
      // 通知 webview 展示卸载中状态
      webviewProvider.notifyUninstalled();
      // 调用 VS Code 卸载 API
      try {
        await vscode.commands.executeCommand(
          'workbench.extensions.uninstallExtension',
          EXTENSION_ID
        );
        const reload = await vscode.window.showInformationMessage(
          'Trae Ask 已卸载，请重新加载窗口以完成。',
          '重新加载'
        );
        if (reload === '重新加载') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`卸载失败: ${err?.message || String(err)}`);
      }
    })
  );

  // 监听扩展变更：当用户在扩展面板卸载/禁用本插件但未 reload 时，
  // 主动检测并清理 Go 子进程，防止知识库仍可使用
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      if (!ext) {
        // 插件已被卸载，立即清理
        GoBridge.dispose();
        webviewProvider.notifyUninstalled();
      }
    })
  );
}

export function deactivate() {
  // 卸载/禁用插件时清理 Go 子进程，防止进程残留导致侧边栏仍可使用
  GoBridge.dispose();
}
