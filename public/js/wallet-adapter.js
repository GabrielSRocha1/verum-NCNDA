// WalletAdapter (cliente). Aceita SOMENTE o provider da Verum Wallet.
// Não existe, até aqui, API pública da Verum Wallet para web: em DEMO usamos uma carteira simulada
// marcada "DEMO", que assina mensagens Ed25519 de verdade (verificadas pelo backend).
// Nenhuma seed, chave privada ou senha é pedida ao usuário em nenhum momento.

/**
 * Formas usadas só para conferência de tipos (JSDoc; nada disso existe em runtime).
 * @typedef {{ id: string, isVerumWallet?: boolean, [k: string]: any }} Provider
 * @typedef {{ key: string, name: string, hint?: string }} Persona
 */

export const VERUM_PROVIDER_ID = 'verum-wallet';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const nacl = () => {
  const n = globalThis.nacl;
  if (!n) throw new Error('Biblioteca de assinatura indisponível');
  return n;
};

/** Escolhe o provider: só a Verum Wallet. Qualquer outro (Phantom, Solflare, injetados) é recusado. */
export function selectProvider(providers) {
  const list = Array.isArray(providers) ? providers : [];
  const p = list.find((x) => x && x.id === VERUM_PROVIDER_ID && x.isVerumWallet === true);
  if (!p) {
    const err = new Error('Somente a Verum Wallet pode conectar nesta mesa.');
    err.code = 'PROVIDER_REFUSED';
    throw err;
  }
  return p;
}

/** Chave DEMO derivada de semente pública — idêntica à do servidor (src/demo.ts). */
export function demoPersonaKeyPair(key) {
  const n = nacl();
  const seed = n.hash(new TextEncoder().encode(`verum-ncnda-demo-persona:${key}`)).slice(0, 32);
  return n.sign.keyPair.fromSeed(seed);
}

/** Provider simulado da Verum Wallet (somente DEMO). */
export class DemoVerumWalletProvider {
  constructor({ personas = [], storage = null } = {}) {
    this.id = VERUM_PROVIDER_ID;
    this.isVerumWallet = true;
    this.demo = true;
    this.label = 'Verum Wallet (DEMO)';
    this.personas = personas;
    this.storage = storage;
    this.current = null;
  }
  guestSeeds() {
    try { return JSON.parse(this.storage?.getItem('votc-demo-guests') ?? '[]'); } catch { return []; }
  }
  accounts() {
    const guests = this.guestSeeds().map((g) => {
      const kp = nacl().sign.keyPair.fromSeed(Uint8Array.from(g.seed));
      return { key: `guest:${g.id}`, name: g.label, hint: 'Carteira criada neste aparelho (DEMO)', address: base58Encode(kp.publicKey), kind: 'guest' };
    });
    const personas = this.personas.map((p) => ({ ...p, kind: 'persona', address: base58Encode(demoPersonaKeyPair(p.key).publicKey) }));
    return [...guests, ...personas];
  }
  createGuest() {
    const seed = Array.from(nacl().randomBytes(32));
    const list = this.guestSeeds();
    const id = list.length + 1;
    list.push({ id, label: `Nova carteira ${String(id).padStart(2, '0')}`, seed });
    this.storage?.setItem('votc-demo-guests', JSON.stringify(list));
    return this.accounts().find((a) => a.key === `guest:${id}`);
  }
  keyPairFor(key) {
    if (key.startsWith('guest:')) {
      const g = this.guestSeeds().find((x) => `guest:${x.id}` === key);
      if (!g) throw new Error('Conta não encontrada');
      return nacl().sign.keyPair.fromSeed(Uint8Array.from(g.seed));
    }
    return demoPersonaKeyPair(key);
  }
  connect(key) {
    const kp = this.keyPairFor(key);
    this.current = { key, address: base58Encode(kp.publicKey) };
    return this.current;
  }
  /** Assina MENSAGEM (identidade/aceite/autorização). Nunca transação. */
  signMessage(message) {
    if (!this.current) throw new Error('Carteira não conectada');
    const kp = this.keyPairFor(this.current.key);
    return base58Encode(nacl().sign.detached(new TextEncoder().encode(message), kp.secretKey));
  }
}

/**
 * WalletAdapter: isAvailable() decide a TELA 1 do convite.
 * - DEMO: o provider simulado está disponível, a menos que o teste "simular sem Verum Wallet" esteja ligado.
 * - Fora do DEMO: indisponível até existir integração real publicada pela Verum Wallet (não inventamos API).
 *
 * @param {{ demoMode?: boolean, simulateMissing?: boolean, personas?: Persona[], storage?: Storage | null, injected?: Provider[] }} opts
 */
export function createWalletAdapter({ demoMode, simulateMissing = false, personas = [], storage = null, injected = [] }) {
  const providers = [...injected];
  if (demoMode) providers.push(new DemoVerumWalletProvider({ personas, storage }));
  let provider = null;
  try { provider = selectProvider(providers); } catch { provider = null; }
  return {
    provider,
    isAvailable: () => !!provider && !simulateMissing,
    attestation: null, // não existe mecanismo de atestação: nunca afirmar "autocustódia verificada"
  };
}
