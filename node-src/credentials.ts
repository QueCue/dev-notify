// 只访问本工具的随机引用条目，不枚举系统凭据，不通过子进程传递秘密。
import { createRequire } from 'node:module';
import { t } from './i18n.js';

export const SERVICE = 'dev-notify.node.credentials.v1';
export interface Bundle { telegram_token?: string; feishu_webhook?: string; feishu_secret?: string; feishu_app_id?: string; feishu_app_secret?: string }
export interface Reference { backend: 'keyring' | 'system'; id: string }
export interface Store {
  read(id: string): Bundle | null;
  create(id: string, values: Bundle): void;
  remove(id: string): void;
}
export class CredentialError extends Error {}
const fields = ['telegram_token', 'feishu_webhook', 'feishu_secret', 'feishu_app_id', 'feishu_app_secret'];
export function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new CredentialError(t('credentials.invalidReference'));
}
export function decodeBundle(raw: Uint8Array): Bundle {
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !fields.includes(key))
      || Object.values(result).some(value => typeof value !== 'string')) throw new Error();
    return result;
  } catch { throw new CredentialError(t('credentials.invalidBundle')); }
}
export function encodeBundle(values: Bundle): Uint8Array {
  const encoded = Buffer.from(JSON.stringify(values), 'utf8');
  decodeBundle(encoded);
  // Windows Credential Manager 通用凭据 blob 上限 2560 字节，跨平台采用保守值。
  if (encoded.byteLength > 2400) throw new CredentialError(t('credentials.tooLong'));
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
    } catch { throw new CredentialError(t('credentials.readFailed')); }
  }
  create(id: string, values: Bundle): void {
    validateId(id);
    const encoded = encodeBundle(values);
    let entry: NativeEntry;
    try {
      entry = this.entry(id);
      if (entry.getSecret() !== null) throw new CredentialError(t('credentials.exists'));
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError(t('credentials.accessFailed'));
    }
    try { entry.setSecret(encoded); }
    catch {
      // 后端可能已写入后才抛错，仅清理此前确认不存在的本次随机条目。
      try { entry.deleteCredential(); }
      catch { throw new CredentialError(t('credentials.writeUnknown', { id })); }
      throw new CredentialError(t('credentials.writeFailed'));
    }
  }
  remove(id: string): void {
    validateId(id);
    try { this.entry(id).deleteCredential(); }
    catch { throw new CredentialError(t('credentials.deleteFailed')); }
  }
}
const require = createRequire(import.meta.url);
export function nativeStore(platform = process.platform): Store {
  if (platform !== 'win32' && platform !== 'darwin') throw new CredentialError(t('credentials.platform'));
  try {
    const binding = require('@napi-rs/keyring') as { Entry: EntryConstructor };
    return new KeyringStore(binding.Entry);
  } catch {
    throw new CredentialError(t('credentials.nativeLoad'));
  }
}
export function resolveReference(reference: Reference): Bundle {
  if (reference.backend === 'system') throw new CredentialError(t('credentials.oldReference'));
  const values = nativeStore().read(reference.id);
  if (values === null) throw new CredentialError(t('credentials.missingEntry'));
  return values;
}
