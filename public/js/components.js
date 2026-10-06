import { h, icon, api, toast, copy, openSheet, qrSvg, state, fmtDate, STATUS_PT } from './core.js';

export function legChips(legs) {
  return h('div', { class: 'chips' }, legs.map((l) =>
    h('span', { class: `chip ${l.onchain ? 'chip-onchain' : 'chip-off'}`, title: l.name }, `${l.side === 'ENTREGA' ? 'Entrega' : 'Recebe'} ${l.symbol} · ${l.chip}`)));
}

export function commissionTable(lines, gradeTotalBps) {
  const total = lines.reduce((a, l) => a + l.bps, 0);
  return h('table', { class: 'comm' },
    h('tbody', {},
      lines.map((l) => h('tr', { class: l.kind === 'RESIDUO' ? 'residual' : '' },
        h('td', {}, l.kind === 'RESIDUO' ? `${l.label} → ${l.role ?? ''}` : l.label,
          l.role && l.kind !== 'RESIDUO' ? h('div', { class: 'small muted' }, l.role) : null),
        h('td', {}, l.kind === 'RESIDUO' ? `${l.bpsLabel} resíduo` : l.bpsLabel))),
      h('tr', { class: 'total' }, h('td', {}, 'Deságio total da grade'),
        h('td', {}, `${Math.floor(total / 100)},${String(total % 100).padStart(2, '0')}%${total !== gradeTotalBps ? ' ✗' : ''}`))));
}

/** Card de Qualificação: dados básicos, sem encher linguiça. */
export function qualCard(d, { onClick = null } = {}) {
  const o = d.offer;
  const [from, to] = d.direction.split(' → ');
  const content = [
    h('div', { class: 'qual-head' },
      h('div', { class: 'qual-top' },
        h('span', { class: 'chip chip-seal' }, o.kindLabel),
        h('div', { class: 'chips' },
          d.isDemo ? h('span', { class: 'chip chip-demo' }, 'DEMO / TESTNET — NO REAL FUNDS') : null,
          h('span', { class: `chip ${['LOCKED', 'SETTLED'].includes(d.version.status) ? 'chip-ok' : 'chip-status'}` }, STATUS_PT[d.version.status] ?? d.version.status))),
      o.businessName ? h('div', { class: 'qual-business' }, o.businessName) : null,
      h('div', { class: 'qual-title' }, o.title),
      h('div', { class: 'direction', 'aria-label': `Direção ${from} para ${to}` }, h('span', {}, from), h('span', { class: 'arrow' }, '→'), h('span', {}, to)),
      legChips(d.legs)),
    h('div', { class: 'qual-body' },
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', {}, 'Volume'), h('b', {}, o.volume)),
        h('div', { class: 'fact' }, h('span', {}, 'Valor de referência'), h('b', { class: 'mono' }, o.reference ? o.reference.label : '—'))),
      h('div', { class: 'grade' }, h('span', { class: 'mono' }, o.grade.label), h('span', { class: 'muted small' }, `grade · deságio total ${o.grade.discountLabel}`)),
      commissionTable(d.lines, o.grade.totalBps),
      o.conditions.length ? h('ul', { class: 'conditions', 'aria-label': 'Condições' }, o.conditions.map((c) => h('li', {}, c))) : null,
      d.honestyNotice ? h('div', { class: 'notice notice-risk' }, d.honestyNotice) : null,
      h('div', { class: 'qual-foot' },
        h('span', {}, o.validUntil ? `${o.expired ? 'Expirada em' : 'Válida até'} ${fmtDate(o.validUntil)}` : 'Sem validade (permanente)', ` · ${d.code} · v${d.version.no}`),
        h('span', { class: 'kn' }, d.signatures.label))),
  ];
  return onClick
    ? h('button', { class: 'qual', onclick: onClick, 'aria-label': `Abrir parceiros de ${o.title}` }, content)
    : h('div', { class: 'qual', style: 'cursor:default' }, content);
}

/** Card de Parceiro. Ordem e cores vêm de quem chama (índice). */
export function partnerCard(p, index, { onClick }) {
  const color = index % 2 === 0 ? 'blue' : 'white';
  if (!p.filled) {
    return h('div', { class: `pcard empty ${p.isPayMaster ? 'pm' : ''}` },
      h('div', {},
        p.payMasterBadge ? h('span', { class: 'chip', style: 'margin-bottom:8px' }, p.payMasterBadge) : null,
        h('div', { class: 'prole' }, p.role),
        h('div', { class: 'pmeta' }, 'Cadeira aguardando convite')),
      h('div', { class: 'pright' }, h('span', { class: 'pct' }, p.bpsLabel)));
  }
  return h('button', {
    class: `pcard ${color} ${p.isPayMaster ? 'pm' : ''}`, onclick: onClick,
    'aria-label': `${p.payMasterBadge ? p.payMasterBadge + ', ' : ''}${p.name}, ${p.role}, ${p.bpsLabel}. Abrir QR de pagamento`,
  },
    p.payMasterBadge ? h('span', { class: 'pm-badge' }, icon('shield'), p.payMasterBadge) : null,
    h('div', {},
      h('div', { class: 'pname' }, p.name, p.isMe ? ' (você)' : ''),
      h('div', { class: 'prole' }, p.role),
      h('div', { class: 'pmeta' },
        p.contactVisible ? [h('div', {}, p.phone), h('div', {}, p.email)] : h('div', {}, 'Contato visível após aceite do convite'),
        h('div', { class: 'mono' }, p.walletShort))),
    h('div', { class: 'pright' }, h('span', { class: 'icon-btn', 'aria-hidden': 'true' }, icon('qr')), h('span', { class: 'pct' }, p.bpsLabel)),
    h('div', { class: 'pstatus' }, p.signed ? '✓ assinado' : '○ pendente'));
}

/** Bottom sheet de meia tela com QR Code e pagamento. */
export async function openQrSheet(deal, p) {
  let data;
  try { data = await api('GET', `/api/deals/${deal.id}/qr/${p.id}`); } catch (e) { toast(e.message, 'err'); return; }
  openSheet((s) => {
    s.render(
      h('div', { class: 'row' }, h('div', {}, h('h2', {}, data.name), h('div', { class: 'muted small' }, data.role)),
        data.demo ? h('span', { class: 'chip chip-demo' }, 'DEMO') : null),
      h('div', { class: 'qrbox' }, qrSvg(data.uri)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Rede'), h('dd', { class: 'mono' }, data.network),
        h('dt', {}, 'Ativo'), h('dd', {}, data.asset ? data.asset.symbol : '—'),
        data.amountLabel ? [h('dt', {}, 'Valor (participação)'), h('dd', { class: 'mono' }, data.amountLabel)] : null,
        h('dt', {}, 'Endereço'), h('dd', { class: 'mono' }, data.addressShort)),
      h('div', { class: 'paylabel' }, data.payment.label),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ghost', onclick: () => copy(data.address, 'Endereço completo copiado') }, 'Copiar endereço completo'),
        // Deep link só aparece se a Verum Wallet expuser um de verdade. Hoje não expõe: botão oculto.
        data.deepLink ? h('a', { class: 'btn btn-blue', href: data.deepLink }, 'ABRIR NA VERUM WALLET') : null,
        h('button', { class: 'btn btn-blue', onclick: () => s.close() }, 'FECHAR')),
      h('p', { class: 'notice notice-info', style: 'margin-top:14px' }, 'Confira rede e ativo antes de pagar. A assinatura acontece dentro da Verum Wallet.'),
      data.demo ? h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Endereço de demonstração. Não envie fundos reais.') : null,
    );
  }, { label: `Pagamento para ${data.name}` });
}

/** Sheet "Gerar convite" do admin. O resultado (link + código) aparece uma única vez. */
export function openInviteSheet(deal, slot, onDone) {
  openSheet((s) => {
    let ttl = '24';
    const form = () => s.render(
      h('h2', {}, 'Gerar convite'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Operação'), h('dd', { class: 'mono' }, `${deal.code} · ${deal.offer.title}`),
        h('dt', {}, 'Função do convidado'), h('dd', {}, slot.role),
        h('dt', {}, 'Percentual destinado'), h('dd', { class: 'mono' }, `${slot.bpsLabel} (${slot.bps} bps)`)),
      h('label', { class: 'field' }, h('span', {}, 'Validade'),
        h('select', { onchange: (e) => { ttl = e.target.value; } },
          ['6', '12', '24', '48', '72'].map((v) => h('option', { value: v, selected: v === '24' }, `${v} horas${v === '24' ? ' (padrão)' : ''}`)))),
      h('p', { class: 'small muted', style: 'margin-bottom:14px' }, 'Função e percentual ficam travados no convite. O parceiro não altera nenhum dos dois.'),
      h('button', { class: 'btn btn-primary btn-block', onclick: generate }, 'GERAR CONVITE'));
    const generate = async () => {
      try {
        const r = await api('POST', '/invitations', { dealId: deal.id, roleKey: slot.roleKey, roleSeq: slot.seq, ttlHours: Number(ttl) });
        result(r);
        onDone?.();
      } catch (e) { toast(e.message, 'err'); }
    };
    const result = (r) => s.render(...inviteResultNodes(r, s));
    form();
  }, { label: 'Gerar convite' });
}

/** Resultado do convite (link + código exibidos uma única vez). Reusado ao gerar novo link. */
export function inviteResultNodes(r, s) {
  return [
      h('h2', {}, 'Convite gerado'),
      h('p', { class: 'notice notice-risk', style: 'margin:10px 0' }, 'Link e código aparecem só agora. Copie antes de fechar.'),
      h('label', { class: 'field' }, h('span', {}, 'Link (uso único)'), h('div', { class: 'sigmsg' }, r.link)),
      h('label', { class: 'field' }, h('span', {}, 'Código'), h('div', { class: 'mono', style: 'font-size:26px;font-weight:700;letter-spacing:.08em' }, r.code)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-blue', onclick: () => copy(r.link, 'Link copiado') }, 'COPIAR LINK'),
        h('button', { class: 'btn btn-blue', onclick: () => copy(r.code, 'Código copiado') }, 'COPIAR CÓDIGO')),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', {
          class: 'btn btn-ghost', onclick: async () => {
            if (navigator.share) { try { await navigator.share({ title: 'VERUM NCNDA — Convite privado', text: r.message }); } catch { /* cancelado */ } }
            else copy(r.message, 'Compartilhamento indisponível: mensagem copiada');
          },
        }, 'COMPARTILHAR'),
        h('button', { class: 'btn btn-ghost', onclick: () => copy(r.message, 'Mensagem pronta copiada') }, 'MENSAGEM PRONTA')),
      h('details', { style: 'margin-top:14px' }, h('summary', { class: 'small muted' }, 'Ver mensagem pronta'), h('div', { class: 'sigmsg', style: 'margin-top:8px' }, r.message)),
      h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:14px', onclick: () => s.close() }, 'FECHAR'),
  ];
}
export function showInviteResult(r) {
  openSheet((s) => s.render(...inviteResultNodes(r, s)), { label: 'Convite gerado' });
}
