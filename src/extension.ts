import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { Secrets } from './secrets';

export function activate(context: vscode.ExtensionContext) {
  // 初始化密钥管理
  Secrets.init(context.secrets);

  const webviewProvider = new WebviewProvider(context);

  // 注册 Webview 视图
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'kbAssistant.chatView',
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('kbAssistant.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.kb-assistant');
    }),
    vscode.commands.registerCommand('kbAssistant.configure', async () => {
      await webviewProvider.openSettings();
    }),
    vscode.commands.registerCommand('kbAssistant.clearChat', () => {
      webviewProvider.clearChat();
    })
  );
}

export function deactivate() {}
