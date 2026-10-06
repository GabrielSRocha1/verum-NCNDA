import { randomBytes, createHash, createHmac, timingSafeEqual, randomInt, createPublicKey, verify as edVerify } from 'node:crypto';

export const sha256Hex = (data: string | Buffer | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const hmacHex = (key: Buffer, data: string): string => createHmac('sha256', key).update(data).digest('hex');

/** Token de 256 bits (CSPRNG) em base64url. */
export function newToken(): string { return randomBytes(32).toString('base64url'); }

// Alfabeto sem caracteres ambíguos (sem 0/O, 1/I/L).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `VOTC-${s}`;
}
export function normalizeInviteCode(input: string): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  const body = s.startsWith('VOTC') ? s.slice(4) : s;
  if (body.length !== 6) return null;
  for (const c of body) if (!CODE_ALPHABET.includes(c)) return null;
  return `VOTC-${body}`;
}

/** Comparação em tempo constante de dois hex de mesmo tamanho. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) {
    timingSafeEqual(ba.length ? ba : Buffer.alloc(32), ba.length ? ba : Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- base58 (Bitcoin/Solana)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export function base58Decode(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) throw new Error('base58 inválido');
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('base58 inválido');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

/** Endereço Solana = chave pública Ed25519 de 32 bytes em base58. */
export function isSolanaAddress(addr: string): boolean {
  if (typeof addr !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return false;
  try { return base58Decode(addr).length === 32; } catch { return false; }
}

/** Verifica assinatura Ed25519 (formato Solana: assinatura base58 de 64 bytes sobre a mensagem UTF-8). */
export function verifyEd25519(address: string, message: string, signatureB58: string): boolean {
  try {
    if (!isSolanaAddress(address)) return false;
    const pub = base58Decode(address);
    const sig = base58Decode(signatureB58);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/** JSON canônico (chaves ordenadas) para hash de termos. BigInt vira string. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('canonicalJson: apenas inteiros');
    return JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const keys = Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------- valores assinados para cookies
export function signValue(secret: Buffer, payload: string): string {
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function unsignValue(secret: Buffer, signed: string | undefined): string | null {
  if (!signed || typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = signed.slice(0, i);
  const mac = Buffer.from(signed.slice(i + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return payload;
}

export function abbreviateAddress(a: string | null | undefined): string {
  if (!a) return '—';
  return a.length <= 12 ? a : `${a.slice(0, 4)}...${a.slice(-4)}`;
}
