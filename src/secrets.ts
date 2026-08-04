import * as vscode from 'vscode';

/**
 * 密钥管理：使用 VS Code SecretStorage 安全存储
 * - trae_user_token: 用户 Trae 企业版登录态（预留，待鉴权方案确认后启用）
 * 注意：APIKey 已编译进 Go 二进制，JS 层不接触密钥
 */
export class Secrets {
  private static KEY_TOKEN = 'trae_user_token';
  private static storage: vscode.SecretStorage;

  static init(storage: vscode.SecretStorage) {
    this.storage = storage;
  }

  static async getToken(): Promise<string | undefined> {
    return this.storage.get(this.KEY_TOKEN);
  }

  static async setToken(token: string): Promise<void> {
    await this.storage.store(this.KEY_TOKEN, token);
  }

  static async clearToken(): Promise<void> {
    await this.storage.delete(this.KEY_TOKEN);
  }
}
