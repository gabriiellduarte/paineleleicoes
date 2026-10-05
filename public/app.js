// Núcleo compartilhado: dados em tempo real (SSE), cálculos de apuração e utilidades de interface.
export const D = { totais: {}, cargos: [], candidatos: [], municipios: [], locais: [], secoes: [], boletins: [], config: {}, municipioId: 'todas', rotulo: '', multi: false };
const listeners = new Set();
let timer;

export async function carregar() {
  const r = await fetch('/api/data?m=' + encodeURIComponent(municipioSalvo() || ''), { cache: 'no-store' });
  aplicar(await r.json());
  idx();
  listeners.forEach(f => f());
}
export function aoMudar(f) { listeners.add(f); }

// ---------- cidade selecionada ----------
// O servidor manda todas as cidades; aqui D.secoes/locais/boletins ficam só com a cidade escolhida
// (ou todas), de modo que as telas não precisam saber de cidades.
export function municipioSalvo() { try { return localStorage.getItem('municipio'); } catch { return null; } }
function aplicar(raw) {
  const ms = raw.municipios || [];
  const sel = raw.municipioSel;
  const nomes = new Map(ms.map(m => [m.id, m.nome]));
  const secoes = raw.secoes.map(x => ({ ...x, cidade: nomes.get(x.municipio_id) || '' }));
  const locais = raw.locais.map(x => ({ ...x, cidade: nomes.get(x.municipio_id) || '' }));
  Object.assign(D, raw, { secoes, locais, municipioId: sel, multi: ms.length > 1, rotulo: sel === 'todas' ? (ms.length > 1 ? 'Todas as cidades' : ms[0]?.nome || '') : nomes.get(Number(sel)) });
}
export function escolherMunicipio(id) {
  try { localStorage.setItem('municipio', String(id)); } catch {}
  return carregar();
}
// "12/0034" e, com várias cidades à vista, o nome da cidade
export const rotuloSecao = s => `${s.zona}/${String(s.numero).padStart(4, '0')}${D.multi && D.municipioId === 'todas' && s.cidade ? ` · ${s.cidade}` : ''}`;

const I = { secao: new Map(), local: new Map(), bol: new Map(), cand: new Map(), porLocal: new Map() };
function idx() {
  I.secao = new Map(D.secoes.map(s => [s.id, s]));
  I.local = new Map(D.locais.map(l => [l.id, l]));
  I.cand = new Map(D.candidatos.map(c => [c.id, c]));
  I.porLocal = new Map();
  for (const s of D.secoes) { const l = I.porLocal.get(s.local_id); l ? l.push(s) : I.porLocal.set(s.local_id, [s]); }
  I.bol = new Map(D.boletins.map(b => [`${b.secao_id}|${b.cargo_id}`, b]));
}
export const secaoPorId = id => I.secao.get(id);
export const localPorId = id => I.local.get(id);
// Boletim da seção. Na carga geral só vêm os votos dos candidatos exibidos; se os votos completos da seção
// já foram pedidos (completar) e continuam atuais, devolve essa versão.
export const boletim = (secaoId, cargoId) => {
  const k = `${secaoId}|${cargoId}`, b = I.bol.get(k), f = cheios.get(k);
  return f && b && f.updated_at === b.updated_at ? f : b;
};
const cheios = new Map();
const pedidos = new Set();
function secaoCompleta(secaoId) {
  return D.cargos.every(c => { const k = `${secaoId}|${c.id}`, b = I.bol.get(k); return !b || cheios.get(k)?.updated_at === b.updated_at; });
}
// true se os votos de todos os candidatos das seções já estão aqui; senão busca no servidor (em lotes) e chama aoCompletar.
export function garantirCompletas(ids, aoCompletar) {
  const falta = ids.filter(id => !secaoCompleta(id));
  if (!falta.length) return true;
  const novos = falta.filter(id => !pedidos.has(id));
  novos.forEach(id => pedidos.add(id));
  for (let i = 0; i < novos.length; i += 200) {
    const lote = novos.slice(i, i + 200);
    fetch(`/api/secao?id=${lote.join(',')}`, { cache: 'no-store' }).then(r => r.json()).then(j => {
      for (const b of j.boletins || []) cheios.set(`${b.secao_id}|${b.cargo_id}`, b);
    }).catch(() => {}).finally(() => { lote.forEach(id => pedidos.delete(id)); aoCompletar(); });
  }
  return false;
}
export const garantirCompleta = (secaoId, aoCompletar) => garantirCompletas([secaoId], aoCompletar);
export const candidatosDe = cargoId => D.candidatos.filter(c => c.cargo_id === cargoId);

export function iniciar() {
  const el = document.getElementById('live');
  const set = ok => { if (el) el.innerHTML = `<i class="dot ${ok ? '' : 'off'}"></i>${ok ? 'ao vivo' : 'reconectando…'} · ${new Date().toLocaleTimeString('pt-BR')}`; };
  const es = new EventSource('/api/stream');
  es.addEventListener('update', () => { clearTimeout(timer); timer = setTimeout(async () => { await carregar(); set(true); }, 150); });
  es.onopen = () => { carregar().then(() => set(true)); };
  es.onerror = () => set(false);
  return carregar().then(() => set(true));
}

// status: 'apurada' | 'rascunho' | 'aguardando'
export function statusSecao(secaoId, cargoId) { return boletim(secaoId, cargoId)?.status || 'aguardando'; }
export const ROTULO = { apurada: 'Apurada', rascunho: 'Em lançamento', aguardando: 'Aguardando' };
export const CLASSE = { apurada: 's-ok', rascunho: 's-part', aguardando: 's-wait' };
export const COR_STATUS = { apurada: '#1f8a4c', rascunho: '#e8a23a', aguardando: '#6c7b76' };

// só boletins "apurada" entram nos totais
// locais (Set de ids, opcional): restringe o resultado às seções desses locais de votação
export function resultado(cargoId, locais = null) {
  const cands = candidatosDe(cargoId);
  const secs = locais ? D.secoes.filter(s => locais.has(s.local_id)) : D.secoes;
  const ids = new Set(secs.map(s => s.id));
  const doCargo = D.boletins.filter(b => b.cargo_id === cargoId && ids.has(b.secao_id));
  const bols = doCargo.filter(b => b.status === 'apurada');
  // sem filtro de locais: totais calculados no servidor; com filtro: soma dos votos enviados por seção (candidatos exibidos)
  const soma = new Map();
  if (!locais) for (const id in D.totais) soma.set(+id, D.totais[id]);
  else for (const b of bols) for (const id in b.votos) soma.set(+id, (soma.get(+id) || 0) + b.votos[id]);
  const rank = cands.map(c => ({ ...c, votos: soma.get(c.id) || 0 }));
  const legenda = bols.reduce((a, b) => a + (b.legenda || 0), 0);
  const brancos = bols.reduce((a, b) => a + b.brancos, 0), nulos = bols.reduce((a, b) => a + b.nulos, 0);
  const comp = bols.reduce((a, b) => a + b.comparecimento, 0);
  const validos = rank.reduce((a, c) => a + c.votos, 0) + legenda;
  rank.sort((a, b) => b.votos - a.votos || a.nome.localeCompare(b.nome, 'pt-BR'));
  const favoritos = rank.filter(c => c.favorito);
  const exibidos = favoritos.length ? favoritos : rank.slice(0, 10);
  const modo = favoritos.length ? 'favoritos' : 'top10';
  const aptosTotal = secs.reduce((a, s) => a + s.aptos, 0);
  const aptosApuradas = bols.reduce((a, b) => a + (secaoPorId(b.secao_id)?.aptos || 0), 0);
  return {
    rank, exibidos, modo, legenda, brancos, nulos, comp, validos, aptosTotal, aptosApuradas,
    secoesTotal: secs.length, apuradas: bols.length,
    rascunho: doCargo.filter(b => b.status === 'rascunho').length,
  };
}

export function statusLocal(localId, cargoId) {
  const ss = I.porLocal.get(localId) || [];
  const st = ss.map(s => statusSecao(s.id, cargoId));
  const ap = st.filter(x => x === 'apurada').length;
  const status = ap === ss.length && ss.length ? 'apurada' : (ap || st.includes('rascunho')) ? 'rascunho' : 'aguardando';
  return { status, total: ss.length, apuradas: ap };
}

export const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
export const fmt = n => (n ?? 0).toLocaleString('pt-BR');
export const pct = (v, t, d = 1) => (t ? (v / t * 100).toFixed(d).replace('.', ',') : '0,0') + '%';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function cargoAtual() {
  const q = new URLSearchParams(location.search).get('cargo');
  let c = q || localStorage.getItem('cargo');
  if (!D.cargos.some(x => x.id === c)) c = D.cargos[0]?.id;
  return c;
}
export function seletorCargo(el, aoTrocar) {
  const atual = cargoAtual();
  el.innerHTML = D.cargos.map(c => `<option value="${c.id}" ${c.id === atual ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
  el.onchange = () => {
    try { localStorage.setItem('cargo', el.value); } catch {}
    const u = new URL(location.href); if (u.searchParams.has('cargo')) { u.searchParams.set('cargo', el.value); history.replaceState(null, '', u); }
    aoTrocar(el.value);
  };
}

export function menu(ativo) {
  const itens = [['/', 'Dashboard'], ['/urnas', 'Por seção'], ['/lancar', 'Lançar boletim'], ['/candidatos', 'Candidatos'], ['/secoes', 'Seções'], ['/telao', 'Telão'], ['/admin', 'Cadastro']];
  document.querySelector('.topbar').insertAdjacentHTML('afterbegin',
    `<a class="brand" href="/">Apuração <span id="brand-mun"></span><small>ELEIÇÕES 2026</small></a><nav class="nav">${itens.map(([h, t]) => `<a href="${h}" class="${h === ativo ? 'on' : ''}">${t}</a>`).join('')}</nav><select class="sel" id="sel-mun" aria-label="Cidade" style="margin-left:auto" hidden></select>`);
  const sel = document.getElementById('sel-mun');
  sel.onchange = () => escolherMunicipio(sel.value);
  const atualizar = () => {
    document.getElementById('brand-mun').textContent = D.rotulo || 'Aracati';
    sel.hidden = !D.multi;
    sel.innerHTML = `<option value="todas">Todas as cidades${D.municipios.length > 20 ? ' (lento)' : ''}</option>` + D.municipios.map(m => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
    sel.value = D.municipioId;
  };
  listeners.add(atualizar); atualizar();
}

// ---------- escrita (PIN + nome) ----------
export function credenciais() {
  let pin = localStorage.getItem('pin'), user = localStorage.getItem('user');
  return { pin, user };
}
export function pedirLogin() {
  return new Promise(ok => {
    const c = credenciais();
    if (c.pin && c.user) return ok(c);
    const w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:4000;padding:16px';
    w.innerHTML = `<form class="dialog"><h2>Entrar para lançar</h2><p class="muted">Informe seu nome (fica no histórico) e o PIN combinado com a coordenação.</p>
      <input class="num" style="text-align:left" id="lg-user" placeholder="Seu nome" autocomplete="name" required>
      <input class="num" style="text-align:left" id="lg-pin" placeholder="PIN" type="password" inputmode="numeric" autocomplete="off" required>
      <div id="lg-err" class="no" style="color:var(--bad)"></div><button class="btn pri">Entrar</button></form>`;
    document.body.append(w);
    w.querySelector('#lg-user').focus();
    w.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const user = w.querySelector('#lg-user').value.trim(), pin = w.querySelector('#lg-pin').value.trim();
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'x-pin': pin, 'x-user': encodeURIComponent(user) }, body: '{}' });
      if (!r.ok) { w.querySelector('#lg-err').textContent = 'PIN incorreto.'; return; }
      localStorage.setItem('pin', pin); localStorage.setItem('user', user); w.remove(); ok({ pin, user });
    };
  });
}
export async function enviar(metodo, rota, corpo) {
  const { pin, user } = credenciais();
  const r = await fetch(rota, { method: metodo, headers: { 'x-pin': pin || '', 'x-user': encodeURIComponent(user || ''), 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { localStorage.removeItem('pin'); await pedirLogin(); return enviar(metodo, rota, corpo); }
  if (!r.ok) throw new Error(j.erro || 'Erro ao salvar.');
  return j;
}
export function toast(msg, erro = false) {
  const t = document.createElement('div'); t.className = 'toast' + (erro ? ' err' : ''); t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), erro ? 5000 : 2200);
}

export function rankingHtml(res, rotulo = D.rotulo) {
  return res.exibidos.map(c => `<div class="cand"><span class="n">${esc(c.numero)}</span><span class="name">${esc(c.nome)}${c.partido ? ` <span class="muted" style="font-weight:400">${esc(c.partido)}</span>` : ''}</span><span class="v">${fmt(c.votos)}<small>${esc(rotulo)}</small>${c.votos_gerais != null ? `<em>${fmt(c.votos_gerais)}<small>geral</small></em>` : ''}</span></div>`).join('')
    || '<div class="empty">Nenhum candidato cadastrado para este cargo. Use a aba Cadastro.</div>';
}

// ---------- mapa (Leaflet) ----------
export function criarMapa(el, escuro = false) {
  if (!window.L) { el.innerHTML = '<div class="empty">Mapa indisponível sem internet.</div>'; return null; }
  if (escuro) el.classList.add('escuro');
  const m = L.map(el, { zoomControl: !escuro, attributionControl: !escuro }).setView([-4.5617, -37.7697], 12);
  const url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; // o telão escurece via CSS (ver .escuro)
  L.tileLayer(url, { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  m._camada = L.layerGroup().addTo(m);
  return m;
}
// votosPorLocal (Map local→votos, opcional): mostra só os locais com voto desse candidato, com os votos no pino
export function desenharLocais(m, cargoId, aoClicar, selecionados = null, votosPorLocal = null) {
  if (!m) return;
  m._camada.clearLayers();
  if (m._mun !== D.municipioId) { m._mun = D.municipioId; m._ajustado = false; } // trocou de cidade: reenquadra
  const pts = [];
  for (const l of D.locais) {
    if (l.lat == null || l.lng == null) continue;
    const st = statusLocal(l.id, cargoId);
    if (st.status === 'aguardando') continue; // só aparecem locais com votos já lançados
    const vl = votosPorLocal ? votosPorLocal.get(l.id) || 0 : null;
    if (votosPorLocal && !vl) continue;
    const r = votosPorLocal ? 12 + Math.min(Math.sqrt(vl), 14) * 1.2 : 12 + Math.min(st.total, 8) * 1.6;
    const marcado = selecionados?.has(l.id); // locais somados no dashboard: contorno azul grosso
    const mk = L.circleMarker([l.lat, l.lng], { radius: r + (marcado ? 3 : 0), color: marcado ? '#1560d4' : '#fff', weight: marcado ? 5 : 2, fillColor: COR_STATUS[st.status], fillOpacity: .95 }).addTo(m._camada);
    if (marcado) mk.bringToFront();
    mk.bindTooltip(votosPorLocal ? fmt(vl) : String(st.total), { permanent: true, direction: 'center', className: 'pino' });
    mk.bindPopup(`<b>${esc(l.nome)}</b><br>${votosPorLocal ? `${fmt(vl)} votos · ` : ''}${st.apuradas}/${st.total} seções apuradas`);
    if (aoClicar) mk.on('click', () => aoClicar(l));
    pts.push([l.lat, l.lng]);
  }
  if (m._aviso) { m._aviso.remove(); m._aviso = null; }
  if (!pts.length) {
    m._aviso = L.control({ position: 'topright' });
    m._aviso.onAdd = () => { const d = L.DomUtil.create('div'); d.textContent = votosPorLocal ? 'Nenhum local com votos deste candidato.' : 'Nenhum local com votos lançados neste cargo ainda.'; d.style.cssText = 'background:rgba(20,32,29,.85);color:#fff;padding:6px 10px;border-radius:6px;font:12px sans-serif'; return d; };
    m._aviso.addTo(m);
  }
  if (pts.length && !m._ajustado) { m.fitBounds(pts, { padding: [30, 30], maxZoom: 14 }); m._ajustado = true; }
}
