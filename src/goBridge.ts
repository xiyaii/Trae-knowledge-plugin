import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Secrets } from './secrets';

export interface KBRequest {
  id: string;
  type: string;               // 'query' | 'track'
  event?: string;             // 'install' | 'login_success' | 'query' | 'feedback'
  query?: string;
  history?: Array<{ role: string; content: string }>;
  token?: string;
  user_id?: string;           // iCubeAuthInfo://usertag 的值
  machine_id?: string;        // vscode.env.machineId
  platform?: string;          // darwin-arm64 / win32-x64
  plugin_ver?: string;        // 插件版本
  msg_id?: string;            // 关联的 query 请求 ID（feedback 事件用）
  doc_name?: string;          // 命中文档名（feedback 事件用）
  answer?: string;            // AI 回答内容（feedback 事件用，截断 8000 字符）
  feedback?: 'like' | 'dislike';
  feedback_reason?: string;   // 点踩原因（多选以分号拼接）
}

export interface KBResultData {
  count: number;
  doc_name: string;
  chunk_title: string;
  score: number;
  rerank_score: number;
  content: string;
  md_content?: string;
}

export interface KBResponse {
  id: string;
  type: 'result' | 'error';
  data?: KBResultData;
  error?: string;
}

/**
 * GoBridge: 管理 Go 后端子进程，通过 JSON Lines 协议通信
 * - APIKey 已编译进 Go 二进制（ldflags -X main.builtInAPIKey=xxx），JS 层不接触密钥
 * - 用户登录态通过环境变量 TRAE_USER_TOKEN 注入（预留）
 */
export class GoBridge {
  private static proc: ChildProcessWithoutNullStreams | undefined;
  private static pending = new Map<string, (resp: KBResponse) => void>();
  private static buffer = '';
  private static cachedToken: string | undefined;

  private static getBinaryPath(extensionPath: string): string {
    const platform = process.platform;
    const arch = process.arch;
    let binaryName = `kb-server-${platform}-${arch}`;
    if (platform === 'win32') {
      binaryName += '.exe';
    }
    return path.join(extensionPath, 'bin', binaryName);
  }

  static async ensureProcess(
    context: vscode.ExtensionContext
  ): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }

    const binaryPath = this.getBinaryPath(context.extensionPath);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `Go 后端二进制不存在: ${binaryPath}，请先运行 npm run build-go`
      );
    }

    // 确保二进制有执行权限（vsix 安装后可能丢失）
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // 忽略 chmod 失败
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    const token = await Secrets.getToken();
    if (token) {
      env.TRAE_USER_TOKEN = token;
    }

    this.proc = spawn(binaryPath, [], { env });

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const resp: KBResponse = JSON.parse(trimmed);
          const cb = this.pending.get(resp.id);
          if (cb) {
            this.pending.delete(resp.id);
            cb(resp);
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    });

    this.proc.stderr.on('data', (data: Buffer) => {
      console.error('[kb-server] stderr:', data.toString());
    });

    this.proc.on('exit', (code) => {
      console.log(`[kb-server] 进程退出，code=${code}`);
      this.proc = undefined;
      for (const [id, cb] of this.pending) {
        this.pending.delete(id);
        cb({ id, type: 'error', error: 'Go 后端进程已退出' });
      }
    });
  }

  static async query(
    context: vscode.ExtensionContext,
    req: KBRequest
  ): Promise<KBResponse> {
    await this.ensureProcess(context);
    // 传递用户登录态给 Go 端用于鉴权（预留，当前 Go 端对空 token 仅记警告）
    req.token = this.cachedToken;
    // 超时分级：query 60s（知识库检索可能较慢），track 10s（埋点应快速完成）
    const timeoutMs = req.type === 'track' ? 10000 : 60000;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          resolve({ id: req.id, type: 'error', error: `请求超时（${timeoutMs / 1000}s）` });
        }
      }, timeoutMs);
      this.pending.set(req.id, (resp: KBResponse) => {
        clearTimeout(timeout);
        resolve(resp);
      });
      this.proc!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  static dispose() {
    if (this.proc) {
      // 先尝试 SIGTERM 优雅退出，清理 pending 请求
      for (const [id, cb] of this.pending) {
        this.pending.delete(id);
        cb({ id, type: 'error', error: '插件已停用，请求已取消' });
      }
      this.buffer = '';
      // 发送 SIGTERM；若进程未退出则在 500ms 后 SIGKILL
      const proc = this.proc;
      this.proc = undefined;
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGKILL'); } catch {}
          }
        }, 500);
      } catch {
        // 进程可能已退出
      }
    }
  }
}
