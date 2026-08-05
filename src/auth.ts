import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * 鉴权：读取 Trae 本地 storage.json，校验企业版订阅状态
 * - macOS:  ~/Library/Application Support/Trae CN/User/globalStorage/storage.json
 * - Windows: %APPDATA%/Trae CN/User/globalStorage/storage.json
 * - Linux:   $XDG_CONFIG_HOME/Trae CN/User/globalStorage/storage.json
 *
 * 校验逻辑：
 * - 读取 iCubeServerData://icube.cloudide 字段（值为 JSON 字符串）
 * - 解析后查找 productType 字段
 * - 若存在 productType 则登录成功（已购买企业版）
 * - 若不存在则登录失败
 */

export interface AuthResult {
  ok: boolean;
  reason?: string;
  productType?: string;
}

export class Auth {
  private static authenticated = false;
  private static result: AuthResult | null = null;

  static isAuthenticated(): boolean {
    return this.authenticated;
  }

  static getResult(): AuthResult | null {
    return this.result;
  }

  /** 获取 Trae storage.json 路径 */
  private static getStoragePath(): string {
    const platform = process.platform;
    let base: string;
    if (platform === 'darwin') {
      base = path.join(os.homedir(), 'Library', 'Application Support');
    } else if (platform === 'win32') {
      base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else {
      // Linux
      base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    }
    return path.join(base, 'Trae CN', 'User', 'globalStorage', 'storage.json');
  }

  /** 执行鉴权：读取 storage.json 并校验 productType */
  static async verify(): Promise<AuthResult> {
    const storagePath = this.getStoragePath();

    if (!fs.existsSync(storagePath)) {
      this.result = {
        ok: false,
        reason: `未检测到 Trae 登录信息（${storagePath} 不存在），请先登录 Trae 企业版账号`,
      };
      this.authenticated = false;
      return this.result;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(storagePath, 'utf-8');
    } catch (e: any) {
      this.result = {
        ok: false,
        reason: `读取 storage.json 失败: ${e.message}`,
      };
      this.authenticated = false;
      return this.result;
    }

    let storageData: Record<string, any>;
    try {
      storageData = JSON.parse(raw);
    } catch (e: any) {
      this.result = {
        ok: false,
        reason: `storage.json 解析失败: ${e.message}`,
      };
      this.authenticated = false;
      return this.result;
    }

    const serverDataKey = 'iCubeServerData://icube.cloudide';
    const serverDataRaw = storageData[serverDataKey];
    if (!serverDataRaw) {
      this.result = {
        ok: false,
        reason: '未检测到 Trae 企业版订阅信息，请先登录 Trae 企业版账号',
      };
      this.authenticated = false;
      return this.result;
    }

    // serverDataRaw 是 JSON 字符串，需要二次解析
    let serverData: any;
    try {
      serverData = typeof serverDataRaw === 'string'
        ? JSON.parse(serverDataRaw)
        : serverDataRaw;
    } catch (e: any) {
      this.result = {
        ok: false,
        reason: `iCubeServerData 解析失败: ${e.message}`,
      };
      this.authenticated = false;
      return this.result;
    }

    // 递归查找 productType 字段
    const productType = this.findProductType(serverData);

    if (!productType) {
      this.result = {
        ok: false,
        reason: '当前账号未购买 Trae 企业版，无法使用知识库助手插件',
      };
      this.authenticated = false;
      return this.result;
    }

    // 存在 productType，登录成功
    this.result = {
      ok: true,
      productType,
    };
    this.authenticated = true;
    return this.result;
  }

  /** 递归查找对象中的 productType 字段 */
  private static findProductType(obj: any): string | undefined {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj === 'object') {
      if (obj.productType !== undefined && typeof obj.productType === 'string') {
        return obj.productType;
      }
      for (const key of Object.keys(obj)) {
        const result = this.findProductType(obj[key]);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  static reset() {
    this.authenticated = false;
    this.result = null;
  }
}
