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
  point_id?: string;          // 知识库切片ID（feedback 事件用）
  answer?: string;            // AI 回答内容（feedback 事件用，截断 8000 字符）
  feedback?: 'like' | 'dislike';
  feedback_reason?: string;   // 点踩原因（多选以分号拼接）
}

export interface KBResultData {
  count: number;
  doc_name: string;
  point_id: string;
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
  private static disposed = false;
  private static extensionPath: string | undefined;

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
    if (this.disposed) {
      throw new Error('插件已停用，无法启动后端服务');
    }
    // 每次启动前记录 extensionPath，用于后续文件系统存活检测
    this.extensionPath = context.extensionPath;
    // 文件系统存活检测：VS Code 卸载时会立即删除扩展目录
    const binaryPath = this.getBinaryPath(context.extensionPath);
    if (!fs.existsSync(binaryPath)) {
      this.disposed = true;
      throw new Error('插件文件已被删除，服务不可用');
    }
    if (this.proc && !this.proc.killed) {
      return;
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

    this.proc = spawn(binaryPath, [], { env, windowsHide: true });

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
    if (this.disposed) {
      return { id: req.id, type: 'error', error: '插件已停用' };
    }
    // 快速文件存活检测：VS Code 卸载时二进制文件会被立即删除，
    // 此时即使旧进程还在也应拒绝请求
    try {
      const binaryPath = this.getBinaryPath(context.extensionPath);
      if (!fs.existsSync(binaryPath)) {
        this.disposed = true;
        // 进程还在就杀掉
        if (this.proc && !this.proc.killed) {
          try { this.proc.kill('SIGKILL'); } catch {}
          this.proc = undefined;
        }
        for (const [id, cb] of this.pending) {
          this.pending.delete(id);
          cb({ id, type: 'error', error: '插件已卸载，服务已停止' });
        }
        return { id: req.id, type: 'error', error: '插件已卸载，服务已停止' };
      }
    } catch {
      // fs 异常也直接拒绝
      this.disposed = true;
      return { id: req.id, type: 'error', error: '插件已卸载，服务已停止' };
    }
    try {
      await this.ensureProcess(context);
    } catch (err: any) {
      return { id: req.id, type: 'error', error: err?.message || '后端服务不可用' };
    }
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
      try {
        this.proc!.stdin.write(JSON.stringify(req) + '\n');
      } catch {
        this.pending.delete(req.id);
        clearTimeout(timeout);
        resolve({ id: req.id, type: 'error', error: '后端进程不可用' });
      }
    });
  }

  static isDisposed(): boolean {
    return this.disposed;
  }

  static dispose() {
    this.disposed = true;
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
