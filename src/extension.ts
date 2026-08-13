import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { Secrets } from './secrets';
import { GoBridge } from './goBridge';

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
    vscode.commands.registerCommand('traeAsk.configure', async () => {
      await webviewProvider.openSettings();
    }),
    vscode.commands.registerCommand('traeAsk.clearChat', () => {
      webviewProvider.clearChat();
    })
  );
}

export function deactivate() {}
