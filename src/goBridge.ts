import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Secrets } from './secrets';

export interface KBRequest {
  id: string;
  type: string;
  query: string;
  history?: Array<{ role: string; content: string }>;
  token?: string;
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
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      this.proc!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  static dispose() {
    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }
  }
}
