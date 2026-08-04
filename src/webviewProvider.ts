import * as vscode from 'vscode';
import * as path from 'path';
import { GoBridge, KBResponse } from './goBridge';
import { Secrets } from './secrets';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: {
    doc_name: string;
    score: number;
  };
  error?: boolean;
}

export class WebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist'),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) =>
      this.handleMessage(msg)
    );
  }

  private async handleMessage(msg: any) {
    if (!this.view) {
      return;
    }
    switch (msg.type) {
      case 'query': {
        const query: string = msg.query;
        const history = this.messages
          .filter((m) => !m.error)
          .slice(-vscode.workspace.getConfiguration('kbAssistant').get('maxHistory', 10) * 2)
          .map((m) => ({ role: m.role, content: m.content }));

        // 先回显用户消息
        this.messages.push({ role: 'user', content: query });
        this.view.webview.postMessage({ type: 'update', messages: this.messages });
        this.view.webview.postMessage({ type: 'loading' });

        const id = `req-${Date.now()}`;
        const resp: KBResponse = await GoBridge.query(this.context, {
          id,
          type: 'query',
          query,
          history,
        });

        if (resp.type === 'error') {
          this.messages.push({ role: 'assistant', content: resp.error || '查询失败', error: true });
        } else if (resp.data) {
          const d = resp.data;
          const content = d.md_content || d.content || '未检索到相关内容';
          this.messages.push({
            role: 'assistant',
            content,
            source: { doc_name: d.doc_name, score: d.score },
          });
        }
        this.view.webview.postMessage({ type: 'update', messages: this.messages });
        break;
      }
      case 'clearChat':
        this.clearChat();
        break;
      case 'openSettings':
        await this.openSettings();
        break;
    }
  }

  clearChat() {
    this.messages = [];
    this.view?.webview.postMessage({ type: 'update', messages: this.messages });
  }

  async openSettings() {
    // 预留：后续接入 Trae 登录流程
    vscode.window.showInformationMessage(
      '配置功能预留：待 Trae 企业版鉴权方案确认后启用'
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'webview-ui',
      'dist'
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>知识库助手</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
