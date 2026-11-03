// 只访问本工具的随机引用条目，不枚举系统凭据，不通过子进程传递秘密。
import { createRequire } from 'node:module';

export const SERVICE = 'dev-notify.node.credentials.v1';
export interface Bundle { telegram_token?: string; feishu_webhook?: string; feishu_secret?: string }
export interface Reference { backend: 'keyring' | 'system'; id: string }
export interface Store {
  read(id: string): Bundle | null;
  create(id: string, values: Bundle): void;
  remove(id: string): void;
}
export class CredentialError extends Error {}
const fields = ['telegram_token', 'feishu_webhook', 'feishu_secret'];
export function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new CredentialError('系统凭据引用无效。');
}
export function decodeBundle(raw: Uint8Array): Bundle {
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !fields.includes(key))
      || Object.values(result).some(value => typeof value !== 'string')) throw new Error();
    return result;
  } catch { throw new CredentialError('系统凭据数据无效，请重新运行 setup。'); }
}
export function encodeBundle(values: Bundle): Uint8Array {
  const encoded = Buffer.from(JSON.stringify(values), 'utf8');
  decodeBundle(encoded);
  // Windows Credential Manager 通用凭据 blob 上限 2560 字节，跨平台采用保守值。
  if (encoded.byteLength > 2400) throw new CredentialError('凭据总长度超过 2400 字节，请检查输入；没有保存。');
  return encoded;
}
interface NativeEntry {
  getSecret(): number[] | null;
  setSecret(secret: Uint8Array): void;
  deleteCredential(): boolean;
}
type EntryConstructor = new (service: string, account: string) => NativeEntry;
export class KeyringStore implements Store {
  constructor(private Entry: EntryConstructor) {}
  private entry(id: string): NativeEntry { validateId(id); return new this.Entry(SERVICE, id); }
  read(id: string): Bundle | null {
    validateId(id);
    try {
      const raw = this.entry(id).getSecret();
      return raw === null ? null : decodeBundle(Uint8Array.from(raw));
    } catch { throw new CredentialError('无法读取系统凭据，或内容无效。请解锁系统凭据存储并允许访问，或重新运行 setup 配置。'); }
  }
  create(id: string, values: Bundle): void {
    validateId(id);
    const encoded = encodeBundle(values);
    let entry: NativeEntry;
    try {
      entry = this.entry(id);
      if (entry.getSecret() !== null) throw new CredentialError('这个随机凭据引用已经存在，没有覆盖，请重试。');
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('无法访问系统凭据存储，请检查系统权限。');
    }
    try { entry.setSecret(encoded); }
    catch {
      // 后端可能已写入后才抛错，仅清理此前确认不存在的本次随机条目。
      try { entry.deleteCredential(); }
      catch { throw new CredentialError(`凭据写入状态未知，清理也失败了。请检查引用 ID：${id}`); }
      throw new CredentialError('系统凭据写入失败，配置没有切换。');
    }
  }
  remove(id: string): void {
    validateId(id);
    try { this.entry(id).deleteCredential(); }
    catch { throw new CredentialError('系统凭据删除失败，请检查存储权限。'); }
  }
}
const require = createRequire(import.meta.url);
export function nativeStore(platform = process.platform): Store {
  if (platform !== 'win32' && platform !== 'darwin') throw new CredentialError('系统凭据仅支持 Windows 和 macOS；其他平台请使用环境变量。');
  try {
    const binding = require('@napi-rs/keyring') as { Entry: EntryConstructor };
    return new KeyringStore(binding.Entry);
  } catch {
    throw new CredentialError('原生凭据组件无法加载。请确认 npm 安装保留了 optional 依赖，并且架构匹配；不会降级为明文存储。');
  }
}
export function resolveReference(reference: Reference): Bundle {
  if (reference.backend === 'system') throw new CredentialError('这是旧版原型保存的凭据引用。请用 setup 重新输入并保存为 Node 凭据，或显式提供环境变量；不会自动读取或删除旧凭据。');
  const values = nativeStore().read(reference.id);
  if (values === null) throw new CredentialError('系统凭据条目缺失，请运行 setup 重新配置。');
  return values;
}
