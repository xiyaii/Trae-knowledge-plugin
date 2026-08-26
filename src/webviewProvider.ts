import * as vscode from 'vscode';
import { GoBridge, KBResponse } from './goBridge';
import { Auth } from './auth';
import * as os from 'os';
import { randomBytes } from 'crypto';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: {
    doc_name: string;
    score: number;
  };
  error?: boolean;
  msgId?: string;                    // assistant 消息关联的 query 请求 ID
  feedback?: 'like' | 'dislike';     // 用户当前反馈状态
  feedbackReason?: string;           // 点踩原因（多选以分号拼接）
}

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'traeAsk.chatView';
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

    // 初始推送鉴权状态
    this.pushAuthState();
  }

  /** 推送当前鉴权状态到 Webview */
  private pushAuthState() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'authState',
      authenticated: Auth.isAuthenticated(),
      result: Auth.getResult(),
    });
  }

  private async handleMessage(msg: any) {
    if (!this.view) return;
    switch (msg.type) {
      case 'login': {
        const result = await Auth.verify();
        this.pushAuthState();
        if (!result.ok) {
          vscode.window.showErrorMessage(result.reason || '鉴权失败');
        } else {
          vscode.window.showInformationMessage('Trae 企业版鉴权通过');
          // 登录成功上报（fire-and-forget）
          GoBridge.query(this.context, {
            id: `track-login-${Date.now()}`,
            type: 'track',
            event: 'login_success',
            user_id: Auth.getUsertag() || undefined,
            machine_id: vscode.env.machineId,
            platform: `${process.platform}-${process.arch}`,
            plugin_ver: (this.context.extension.packageJSON as any)?.version || 'unknown',
          }).catch(() => {});
        }
        break;
      }
      case 'query': {
        // 插件已停用：拒绝处理并通知 webview
        if (GoBridge.isDisposed()) {
          this.view.webview.postMessage({ type: 'uninstalled' });
          return;
        }
        // 鉴权拦截
        if (!Auth.isAuthenticated()) {
          const result = await Auth.verify();
          this.pushAuthState();
          if (!result.ok) {
            this.messages.push({
              role: 'assistant',
              content: result.reason || '鉴权失败，请先登录 Trae 企业版账号',
              error: true,
            });
            this.view.webview.postMessage({ type: 'update', messages: this.messages });
            return;
          }
        }

        const query: string = msg.query;
        const maxHistory = vscode.workspace
          .getConfiguration('traeAsk')
          .get<number>('maxHistory', 10);
        const history = this.messages
          .filter((m) => !m.error)
          .slice(-maxHistory * 2)
          .map((m) => ({ role: m.role, content: m.content }));

        this.messages.push({ role: 'user', content: query });
        this.view.webview.postMessage({ type: 'update', messages: this.messages });
        this.view.webview.postMessage({ type: 'loading' });

        try {
          const id = `req-${Date.now()}`;
          const resp: KBResponse = await GoBridge.query(this.context, {
            id,
            type: 'query',
            query,
            history,
            user_id: Auth.getUsertag() || undefined,
            machine_id: vscode.env.machineId,
            platform: `${process.platform}-${process.arch}`,
            plugin_ver: (this.context.extension.packageJSON as any)?.version || 'unknown',
          });

          if (resp.type === 'error') {
            this.messages.push({
              role: 'assistant',
              content: resp.error || '查询失败',
              error: true,
            });
          } else if (resp.data) {
            const d = resp.data;
            const content = d.md_content || d.content || '未检索到相关内容';
            this.messages.push({
              role: 'assistant',
              content,
              source: d.doc_name ? { doc_name: d.doc_name, score: d.score } : undefined,
              msgId: id,
            });
          }
        } catch (err: any) {
          this.messages.push({
            role: 'assistant',
            content: `查询异常: ${err?.message || String(err)}`,
            error: true,
          });
        }
        this.view.webview.postMessage({ type: 'update', messages: this.messages });
        break;
      }
      case 'feedback': {
        // ack 回滚机制：乐观更新 UI，Go 端 ack 失败则回滚
        const targetIdx = this.messages.findIndex((m) => m.msgId === msg.msgId);
        if (targetIdx === -1) return;
        const target = this.messages[targetIdx];

        // 找到 assistant 消息前一条 user 消息，作为用户原始提问
        let userQuery = '';
        for (let i = targetIdx - 1; i >= 0; i--) {
          if (this.messages[i].role === 'user') {
            userQuery = this.messages[i].content?.slice(0, 500) || '';
            break;
          }
        }

        // 保存原状态用于回滚
        const prevFeedback = target.feedback;
        const prevReason = target.feedbackReason;

        // 乐观更新 UI
        target.feedback = msg.feedback;
        target.feedbackReason = msg.reason;
        this.view.webview.postMessage({ type: 'update', messages: this.messages });

        try {
          const resp: KBResponse = await GoBridge.query(this.context, {
            id: `track-feedback-${Date.now()}`,
            type: 'track',
            event: 'feedback',
            msg_id: msg.msgId,
            query: userQuery,
            doc_name: target.source?.doc_name,
            answer: target.content?.slice(0, 8000),
            feedback: msg.feedback,
            feedback_reason: msg.reason,
            user_id: Auth.getUsertag() || undefined,
            machine_id: vscode.env.machineId,
            platform: `${process.platform}-${process.arch}`,
            plugin_ver: (this.context.extension.packageJSON as any)?.version || 'unknown',
          });

          if (resp.type === 'error') {
            // 回滚 UI
            target.feedback = prevFeedback;
            target.feedbackReason = prevReason;
            this.view.webview.postMessage({ type: 'update', messages: this.messages });
            this.view.webview.postMessage({ type: 'feedbackError', msgId: msg.msgId });
          }
        } catch {
          // 回滚 UI
          target.feedback = prevFeedback;
          target.feedbackReason = prevReason;
          this.view.webview.postMessage({ type: 'update', messages: this.messages });
          this.view.webview.postMessage({ type: 'feedbackError', msgId: msg.msgId });
        }
        break;
      }
      case 'clearChat':
        this.clearChat();
        break;
    }
  }

  /** 通知 webview 插件已被卸载，展示禁用状态 */
  notifyUninstalled() {
    this.view?.webview.postMessage({ type: 'uninstalled' });
  }

  clearChat() {
    this.messages = [];
    this.view?.webview.postMessage({ type: 'update', messages: this.messages });
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource} data:;">
  <title>AskTrae</title>
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
  // CSP nonce 必须不可预测，使用 crypto CSPRNG（Math.random 非密码学安全）
  return randomBytes(16).toString('hex');
}
