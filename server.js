// Servidor da apuração: HTTP + SQLite (node:sqlite) + SSE para tempo real. Sem dependências.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buscarCandidatos, buscarSecoes, listarMunicipios, semAcento } from './tse.js';
import { listarSecoesUrna, buscarBoletimUrna, PLEITO_PADRAO } from './urnas.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const PIN = String(process.env.VOTOS_PIN || '1234');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'data', 'votos.db'));

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS cargos(id TEXT PRIMARY KEY, nome TEXT, vagas INTEGER DEFAULT 1, legenda INTEGER DEFAULT 0, ordem INTEGER);
CREATE TABLE IF NOT EXISTS candidatos(id INTEGER PRIMARY KEY AUTOINCREMENT, cargo_id TEXT, numero TEXT, nome TEXT, partido TEXT, cor TEXT, UNIQUE(cargo_id,numero));
CREATE TABLE IF NOT EXISTS municipios(id INTEGER PRIMARY KEY AUTOINCREMENT, uf TEXT, nome TEXT, UNIQUE(uf,nome));
CREATE TABLE IF NOT EXISTS locais(id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, endereco TEXT, lat REAL, lng REAL, token TEXT, municipio_id INTEGER, UNIQUE(municipio_id,nome));
CREATE TABLE IF NOT EXISTS secoes(id INTEGER PRIMARY KEY AUTOINCREMENT, zona INTEGER, numero INTEGER, local_id INTEGER, aptos INTEGER DEFAULT 0, agregadas TEXT DEFAULT '', municipio_id INTEGER, UNIQUE(municipio_id,zona,numero));
CREATE TABLE IF NOT EXISTS boletins(secao_id INTEGER, cargo_id TEXT, status TEXT, comparecimento INTEGER, brancos INTEGER, nulos INTEGER, legenda INTEGER DEFAULT 0, usuario TEXT, updated_at TEXT, PRIMARY KEY(secao_id,cargo_id));
CREATE TABLE IF NOT EXISTS votos(secao_id INTEGER, cargo_id TEXT, candidato_id INTEGER, votos INTEGER, PRIMARY KEY(secao_id,cargo_id,candidato_id));
CREATE INDEX IF NOT EXISTS votos_cand ON votos(candidato_id);
CREATE TABLE IF NOT EXISTS historico(id INTEGER PRIMARY KEY AUTOINCREMENT, secao_id INTEGER, cargo_id TEXT, usuario TEXT, em TEXT, acao TEXT, dados TEXT);
`);

for (const alt of ['ALTER TABLE candidatos ADD COLUMN vice TEXT DEFAULT \'\'', 'ALTER TABLE secoes ADD COLUMN agregadas TEXT DEFAULT \'\'', 'ALTER TABLE candidatos ADD COLUMN favorito INTEGER DEFAULT 0', 'ALTER TABLE locais ADD COLUMN token TEXT', 'ALTER TABLE candidatos ADD COLUMN votos_gerais INTEGER']) { try { db.exec(alt); } catch {} }

// Bancos anteriores guardavam uma única cidade: recria locais/secoes com municipio_id (os ids são mantidos).
if (!db.prepare('PRAGMA table_info(secoes)').all().some(c => c.name === 'municipio_id')) {
  const nome = db.prepare("SELECT v FROM config WHERE k='municipio'").get()?.v || 'Aracati';
  db.exec('BEGIN');
  const mid = Number(db.prepare('INSERT INTO municipios(uf,nome) VALUES(?,?)').run('CE', nome).lastInsertRowid);
  db.exec(`CREATE TABLE locais_n(id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, endereco TEXT, lat REAL, lng REAL, token TEXT, municipio_id INTEGER, UNIQUE(municipio_id,nome));
    INSERT INTO locais_n SELECT id,nome,endereco,lat,lng,token,${mid} FROM locais; DROP TABLE locais; ALTER TABLE locais_n RENAME TO locais;
    CREATE TABLE secoes_n(id INTEGER PRIMARY KEY AUTOINCREMENT, zona INTEGER, numero INTEGER, local_id INTEGER, aptos INTEGER DEFAULT 0, agregadas TEXT DEFAULT '', municipio_id INTEGER, UNIQUE(municipio_id,zona,numero));
    INSERT INTO secoes_n SELECT id,zona,numero,local_id,aptos,agregadas,${mid} FROM secoes; DROP TABLE secoes; ALTER TABLE secoes_n RENAME TO secoes;`);
  db.exec('COMMIT');
}

// Votos zerados não precisam de linha (ausente = 0); bancos antigos guardavam todos os candidatos de cada boletim.
const zeros = db.prepare('SELECT COUNT(*) n FROM votos WHERE votos=0').get().n;
if (zeros) { db.exec('DELETE FROM votos WHERE votos=0'); console.log(`Limpeza: ${zeros} linhas de voto zerado removidas.`); }

const CORES = ['#0b6e5a', '#d4572a', '#3d5fc4', '#9a7b1c', '#8a4fa0', '#c2306b', '#2f8f9d', '#6b7a1f'];
const CARGOS = [
  ['presidente', 'Presidente', 1, 0], ['governador', 'Governador', 1, 0], ['senador', 'Senador', 2, 0],
  ['dep_federal', 'Deputado Federal', 1, 1], ['dep_estadual', 'Deputado Estadual', 1, 1],
];

function seedDemo() {
  const has = db.prepare('SELECT COUNT(*) n FROM cargos').get().n;
  if (has) return;
  CARGOS.forEach((c, i) => db.prepare('INSERT INTO cargos VALUES(?,?,?,?,?)').run(...c, i));
  db.prepare("INSERT OR REPLACE INTO config VALUES('municipio','Aracati')").run();
  db.prepare("INSERT OR REPLACE INTO config VALUES('demo','1')").run();
  const nomes = ['A', 'B', 'C', 'D'];
  const nums = { presidente: [13, 22, 15, 30], governador: [13, 45, 22, 30], senador: [131, 456, 222, 301], dep_federal: [1301, 4502, 2203, 3004], dep_estadual: [13011, 45022, 22033, 30044] };
  for (const [id] of CARGOS) nomes.forEach((n, i) => db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor) VALUES(?,?,?,?,?)').run(id, String(nums[id][i]), `Candidato Exemplo ${n}`, 'EXEMPLO', CORES[i]));
  const mun = Number(db.prepare('INSERT INTO municipios(uf,nome) VALUES(?,?)').run('CE', 'Aracati').lastInsertRowid);
  const centro = [-4.5617, -37.7697];
  const locais = ['E.E.F.M. Cel. Alexandrino', 'Escola Municipal Centro', 'Ginásio Poliesportivo', 'E.E.M. Padre Cícero', 'Escola Canoa Quebrada', 'Escola Cumbe', 'Escola Mundaú', 'Escola Majorlândia'];
  locais.forEach((nome, i) => {
    const a = (i / locais.length) * Math.PI * 2, r = i === 0 ? 0 : 0.02 + (i % 3) * 0.015;
    const lat = centro[0] + Math.sin(a) * r, lng = centro[1] + Math.cos(a) * r;
    const lid = db.prepare('INSERT INTO locais(nome,endereco,lat,lng,municipio_id) VALUES(?,?,?,?,?)').run(nome, '(exemplo)', lat, lng, mun).lastInsertRowid;
    for (let s = 0; s < 4 + (i % 3); s++) db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,municipio_id) VALUES(?,?,?,?,?)').run(18, i * 10 + s + 1, lid, 280 + ((i * 17 + s * 29) % 40), mun);
  });
}
seedDemo();

// ---------- dados ----------
// Só manda ao navegador a cidade pedida (m = id ou 'todas'): com o estado inteiro importado, o banco todo passa de dezenas de MB.
function snapshot(m) {
  const cfg = Object.fromEntries(db.prepare('SELECT k,v FROM config').all().map(r => [r.k, r.v]));
  const municipios = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM secoes s WHERE s.municipio_id=m.id) secoes_n,
    (SELECT COUNT(*) FROM boletins b JOIN secoes s ON s.id=b.secao_id WHERE s.municipio_id=m.id) boletins_n FROM municipios m ORDER BY m.nome`).all();
  // sem pedido válido: a única cidade, ou a que já tem mais boletins (evita carregar o estado todo por padrão)
  let sel = String(m);
  if (sel !== 'todas' && !municipios.some(x => String(x.id) === sel)) sel = municipios.length ? String([...municipios].sort((a, b) => b.boletins_n - a.boletins_n)[0].id) : 'todas';
  const filtro = sel === 'todas' ? '' : ` WHERE municipio_id=${Number(sel)}`;
  const secoes = db.prepare(`SELECT * FROM secoes${filtro} ORDER BY zona, numero`).all();
  const noEscopo = sel === 'todas' ? '' : ` WHERE secao_id IN (SELECT id FROM secoes WHERE municipio_id=${Number(sel)})`;
  // Totais por candidato calculados aqui (só boletins apurados); o navegador não precisa dos votos de cada seção.
  const totais = {};
  const juncao = sel === 'todas' ? '' : ` JOIN secoes s ON s.id=v.secao_id AND s.municipio_id=${Number(sel)}`;
  for (const r of db.prepare(`SELECT v.candidato_id id, SUM(v.votos) t FROM votos v JOIN boletins b ON b.secao_id=v.secao_id AND b.cargo_id=v.cargo_id${juncao} WHERE b.status='apurada' GROUP BY v.candidato_id`).all()) totais[r.id] = r.t;
  // Por seção só vão os votos dos candidatos exibidos (favoritos do cargo; sem favoritos, os 10 mais votados).
  // Os votos completos de uma seção vêm sob demanda em /api/secao.
  const candidatos = db.prepare('SELECT * FROM candidatos ORDER BY cargo_id, id').all();
  const interesse = [];
  for (const cargo of new Set(candidatos.map(c => c.cargo_id))) {
    const doCargo = candidatos.filter(c => c.cargo_id === cargo);
    const favs = doCargo.filter(c => c.favorito);
    const alvo = favs.length ? favs : [...doCargo].sort((a, b) => (totais[b.id] || 0) - (totais[a.id] || 0) || a.nome.localeCompare(b.nome, 'pt-BR')).slice(0, 10);
    interesse.push(...alvo.map(c => c.id));
  }
  const vmap = {};
  if (interesse.length) {
    const filtroVoto = noEscopo ? `${noEscopo} AND` : ' WHERE';
    for (const v of db.prepare(`SELECT * FROM votos${filtroVoto} candidato_id IN (${interesse.map(Number).join(',')})`).all()) (vmap[`${v.secao_id}|${v.cargo_id}`] ||= {})[v.candidato_id] = v.votos;
  }
  const boletins = db.prepare(`SELECT * FROM boletins${noEscopo}`).all().map(b => ({ ...b, votos: vmap[`${b.secao_id}|${b.cargo_id}`] || {} }));
  return {
    config: cfg,
    cargos: db.prepare('SELECT * FROM cargos ORDER BY ordem').all(),
    candidatos,
    totais,
    municipios,
    municipioSel: sel,
    locais: db.prepare(`SELECT id,nome,endereco,lat,lng,municipio_id FROM locais${filtro} ORDER BY nome`).all(),
    secoes,
    boletins,
    ts: Date.now(),
  };
}

// Resposta pronta (JSON comprimido) guardada até o próximo dado mudar.
let versaoDados = 0;
const cacheDados = new Map();
function dadosComprimidos(m) {
  const chave = `${versaoDados}|${m}`;
  let c = cacheDados.get(chave);
  if (!c) { if (cacheDados.size > 8) cacheDados.clear(); c = { cru: Buffer.from(JSON.stringify(snapshot(m))) }; c.gz = zlib.gzipSync(c.cru, { level: 4 }); cacheDados.set(chave, c); }
  return c;
}

const MINUSCULAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const tituloNome = (n) => String(n).toLowerCase().split(' ').map((p, i) => (i && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
function acharMunicipio(uf, nome) {
  return db.prepare('SELECT * FROM municipios WHERE uf=?').all(uf).find(m => semAcento(m.nome) === semAcento(nome));
}
function municipioId(uf, nome) {
  return acharMunicipio(uf, nome)?.id ?? Number(db.prepare('INSERT INTO municipios(uf,nome) VALUES(?,?)').run(uf, nome).lastInsertRowid);
}
const int = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN; };

function salvarBoletim(b, usuario) {
  const secao = db.prepare('SELECT * FROM secoes WHERE id=?').get(b.secao_id);
  const cargo = db.prepare('SELECT * FROM cargos WHERE id=?').get(b.cargo_id);
  if (!secao || !cargo) throw new Error('Seção ou cargo inexistente.');
  const status = b.status === 'rascunho' ? 'rascunho' : 'apurada';
  // parcial: só atualiza o que veio no pedido e mantém o resto do boletim (usado ao lançar só os favoritos).
  const existente = b.parcial ? db.prepare('SELECT * FROM boletins WHERE secao_id=? AND cargo_id=?').get(secao.id, cargo.id) : null;
  const votosAntes = {};
  if (existente) for (const v of db.prepare('SELECT candidato_id, votos FROM votos WHERE secao_id=? AND cargo_id=?').all(secao.id, cargo.id)) votosAntes[v.candidato_id] = v.votos;
  const br = int(b.brancos ?? existente?.brancos ?? 0), nu = int(b.nulos ?? existente?.nulos ?? 0), leg = cargo.legenda ? int(b.legenda ?? existente?.legenda ?? 0) : 0;
  if ([br, nu, leg].some(Number.isNaN)) throw new Error('Há campos com valor inválido.');
  const cands = db.prepare('SELECT id FROM candidatos WHERE cargo_id=?').all(cargo.id);
  let soma = br + nu + leg;
  const linhas = [];
  for (const c of cands) { const v = int(b.votos?.[c.id] ?? votosAntes[c.id] ?? 0); if (Number.isNaN(v)) throw new Error('Há votos inválidos.'); soma += v; linhas.push([c.id, v]); }
  // O comparecimento é calculado a partir dos votos lançados (senador: cada eleitor vota em 2).
  const comp = Math.ceil(soma / cargo.vagas);
  if (status === 'apurada') {
    if (soma === 0) throw new Error('Lance ao menos um voto antes de salvar.');
    if (secao.aptos > 0 && comp > secao.aptos) throw new Error(`Os votos somam ${soma}, mais do que os ${secao.aptos} eleitores aptos desta seção${cargo.vagas > 1 ? ` (x${cargo.vagas})` : ''}. Confira a digitação.`);
  }
  const agora = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR REPLACE INTO boletins VALUES(?,?,?,?,?,?,?,?,?)').run(secao.id, cargo.id, status, comp, br, nu, leg, usuario, agora);
    db.prepare('DELETE FROM votos WHERE secao_id=? AND cargo_id=?').run(secao.id, cargo.id);
    for (const [cid, v] of linhas) if (v > 0) db.prepare('INSERT INTO votos VALUES(?,?,?,?)').run(secao.id, cargo.id, cid, v);
    db.prepare('INSERT INTO historico(secao_id,cargo_id,usuario,em,acao,dados) VALUES(?,?,?,?,?,?)').run(secao.id, cargo.id, usuario, agora, status, JSON.stringify(b));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function excluirBoletim(secao_id, cargo_id, usuario) {
  db.prepare('DELETE FROM boletins WHERE secao_id=? AND cargo_id=?').run(secao_id, cargo_id);
  db.prepare('DELETE FROM votos WHERE secao_id=? AND cargo_id=?').run(secao_id, cargo_id);
  db.prepare('INSERT INTO historico(secao_id,cargo_id,usuario,em,acao,dados) VALUES(?,?,?,?,?,?)').run(secao_id, cargo_id, usuario, new Date().toISOString(), 'excluido', '{}');
}

// ---------- importação CSV ----------
function parseCsv(txt) {
  txt = txt.replace(/^﻿/, '').trim();
  const first = txt.split(/\r?\n/)[0];
  const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const rows = txt.split(/\r?\n/).filter(Boolean).map(l => l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')));
  const head = rows.shift().map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function importar(tipo, csv, municipio_id) {
  const rows = parseCsv(csv);
  let n = 0;
  db.exec('BEGIN');
  try {
    if (tipo === 'secoes') {
      const mun = db.prepare('SELECT id FROM municipios WHERE id=?').get(Number(municipio_id));
      if (!mun) throw new Error('Escolha a cidade das seções antes de importar.');
      for (const r of rows) {
        const zona = int(r.zona), numero = int(r.secao ?? r.numero), aptos = int(r.aptos || 0);
        const nome = r.local || r['local de votacao'];
        if (Number.isNaN(zona) || Number.isNaN(numero) || !nome) throw new Error(`Linha inválida: ${JSON.stringify(r)}`);
        const lat = r.lat ? Number(String(r.lat).replace(',', '.')) : null, lng = r.lng ? Number(String(r.lng).replace(',', '.')) : null;
        db.prepare('INSERT INTO locais(nome,endereco,lat,lng,municipio_id) VALUES(?,?,?,?,?) ON CONFLICT(municipio_id,nome) DO UPDATE SET endereco=COALESCE(NULLIF(excluded.endereco,\'\'),endereco), lat=COALESCE(excluded.lat,lat), lng=COALESCE(excluded.lng,lng)').run(nome, r.endereco || '', lat, lng, mun.id);
        const lid = db.prepare('SELECT id FROM locais WHERE nome=? AND municipio_id=?').get(nome, mun.id).id;
        db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,municipio_id) VALUES(?,?,?,?,?) ON CONFLICT(municipio_id,zona,numero) DO UPDATE SET local_id=excluded.local_id, aptos=excluded.aptos').run(zona, numero, lid, Number.isNaN(aptos) ? 0 : aptos, mun.id);
        n++;
      }
    } else if (tipo === 'candidatos') {
      for (const r of rows) {
        const cargo = db.prepare('SELECT id FROM cargos WHERE id=? OR lower(nome)=lower(?)').get(r.cargo, r.cargo);
        if (!cargo || !r.numero || !r.nome) throw new Error(`Linha inválida (cargo/numero/nome): ${JSON.stringify(r)}`);
        const ja = db.prepare('SELECT cor FROM candidatos WHERE cargo_id=? AND numero=?').get(cargo.id, r.numero);
        const qtd = db.prepare('SELECT COUNT(*) n FROM candidatos WHERE cargo_id=?').get(cargo.id).n;
        db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor) VALUES(?,?,?,?,?) ON CONFLICT(cargo_id,numero) DO UPDATE SET nome=excluded.nome, partido=excluded.partido').run(cargo.id, r.numero, r.nome, r.partido || '', ja?.cor || CORES[qtd % CORES.length]);
        n++;
      }
    } else throw new Error('Tipo de importação desconhecido.');
    db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

function zerar(escopo) {
  db.exec('BEGIN');
  db.exec('DELETE FROM votos; DELETE FROM boletins; DELETE FROM historico;');
  if (escopo === 'tudo') db.exec('DELETE FROM candidatos; DELETE FROM secoes; DELETE FROM locais; DELETE FROM municipios;');
  if (escopo === 'tudo') db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
  db.exec('COMMIT');
}


// ---------- importação direta do TSE ----------
let importando = false;
const pastaTse = () => path.join(ROOT, 'data', 'tse');
// todos: importa todos os municípios da UF de uma vez (candidatos e arquivo de locais lidos uma só vez).
async function importarTse({ uf = 'CE', municipio = 'Aracati', todos = false }) {
  uf = String(uf).trim().toUpperCase();
  if (importando) throw new Error('Já existe uma importação em andamento.');
  importando = true;
  try {
    const pasta = pastaTse();
    const nomes = todos ? await listarMunicipios(uf, pasta) : [municipio];
    const c = await buscarCandidatos(uf, pasta);
    const cidades = [];
    for (const nome of nomes) cidades.push(await buscarSecoes(uf, nome, pasta)); // o arquivo da UF fica em cache
    if (!c.candidatos.length) throw new Error('O TSE não devolveu candidatos.');
    const demo = db.prepare("SELECT v FROM config WHERE k='demo'").get()?.v === '1';
    if (!demo && db.prepare('SELECT 1 FROM municipios WHERE uf<>?').get(uf)) throw new Error('Os candidatos são por estado: este sistema trabalha com um estado por vez. Apague tudo em Cadastro para trocar de UF.');
    db.exec('BEGIN');
    try {
      if (demo) db.exec('DELETE FROM votos; DELETE FROM boletins; DELETE FROM historico; DELETE FROM candidatos; DELETE FROM secoes; DELETE FROM locais; DELETE FROM municipios;');
      // candidatos: atualiza, inclui os novos e remove os que saíram da lista (se ainda sem votos)
      const porCargo = {};
      for (const k of c.candidatos) {
        (porCargo[k.cargo] ||= []).push(k);
        const ja = db.prepare('SELECT cor FROM candidatos WHERE cargo_id=? AND numero=?').get(k.cargo, k.numero);
        const qtd = db.prepare('SELECT COUNT(*) n FROM candidatos WHERE cargo_id=?').get(k.cargo).n;
        db.prepare('INSERT INTO candidatos(cargo_id,numero,nome,partido,cor,vice) VALUES(?,?,?,?,?,?) ON CONFLICT(cargo_id,numero) DO UPDATE SET nome=excluded.nome, partido=excluded.partido, vice=excluded.vice').run(k.cargo, k.numero, k.nome, k.partido, ja?.cor || CORES[qtd % CORES.length], k.vice);
      }
      let removidos = 0;
      for (const cargo of Object.keys(porCargo)) {
        const nums = new Set(porCargo[cargo].map(x => x.numero));
        for (const r of db.prepare('SELECT id,numero FROM candidatos WHERE cargo_id=?').all(cargo)) {
          if (nums.has(r.numero)) continue;
          if (db.prepare('SELECT 1 FROM votos WHERE candidato_id=? AND votos>0').get(r.id)) continue;
          db.prepare('DELETE FROM votos WHERE candidato_id=?').run(r.id);
          db.prepare('DELETE FROM candidatos WHERE id=?').run(r.id); removidos++;
        }
      }
      const mids = [];
      for (const s of cidades) {
      const mid = municipioId(uf, tituloNome(s.nomeMunicipio)); mids.push(mid);
      for (const x of s.secoes) {
        db.prepare('INSERT INTO locais(nome,endereco,lat,lng,municipio_id) VALUES(?,?,?,?,?) ON CONFLICT(municipio_id,nome) DO UPDATE SET endereco=excluded.endereco, lat=COALESCE(excluded.lat,lat), lng=COALESCE(excluded.lng,lng)').run(x.local, x.endereco, x.lat, x.lng, mid);
        const lid = db.prepare('SELECT id FROM locais WHERE nome=? AND municipio_id=?').get(x.local, mid).id;
        db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,agregadas,municipio_id) VALUES(?,?,?,?,?,?) ON CONFLICT(municipio_id,zona,numero) DO UPDATE SET local_id=excluded.local_id, aptos=excluded.aptos, agregadas=excluded.agregadas').run(x.zona, x.numero, lid, x.aptos, x.agregadas, mid);
      }
      }
      db.prepare("INSERT OR REPLACE INTO config VALUES('demo','0')").run();
      db.prepare("INSERT OR REPLACE INTO config VALUES('tse_importado_em',?)").run(new Date().toISOString());
      db.exec('COMMIT');
      const todasSecoes = cidades.flatMap(s => s.secoes);
      return { municipio_id: mids[0], municipio: tituloNome(cidades[0].nomeMunicipio), cidades: cidades.length, candidatos: c.candidatos.length, removidos, secoes: todasSecoes.length, agregadas: cidades.reduce((t, s) => t + s.totalAgregadas, 0), locais: new Set(cidades.flatMap(s => s.secoes.map(x => s.nomeMunicipio + '|' + x.local))).size, comCoordenadas: new Set(cidades.flatMap(s => s.secoes.filter(x => x.lat != null).map(x => s.nomeMunicipio + '|' + x.local))).size, avisos: c.avisos, limpouExemplo: demo };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { importando = false; }
}


// ---------- boletins de urna do TSE (.bu / .dat) ----------
const urnas = { rodando: false, total: 0, feitos: 0, gravados: 0, pendentes: 0, semSecao: [], falhas: [], ignorados: {}, inicio: null, fim: null, erro: null };

// Grava o boletim oficial da seção. Sobrescreve lançamentos manuais da mesma seção/cargo (fica no histórico).
// Guarda só votos > 0 (quem não aparece tem 0): em Fortaleza, 1.000 candidatos x 5.000 seções seriam milhões de linhas zeradas.
let stmtUrna = null, candsUrna = null;
function prepararUrna() {
  candsUrna = new Map(); // cargo -> { cargo, ids: numero -> id }, válido durante uma importação
  stmtUrna = {
    cargo: db.prepare('SELECT * FROM cargos WHERE id=?'),
    cands: db.prepare('SELECT id,numero FROM candidatos WHERE cargo_id=?'),
    bol: db.prepare('INSERT OR REPLACE INTO boletins VALUES(?,?,?,?,?,?,?,?,?)'),
    delVotos: db.prepare('DELETE FROM votos WHERE secao_id=? AND cargo_id=?'),
    voto: db.prepare('INSERT INTO votos VALUES(?,?,?,?)'),
    hist: db.prepare('INSERT INTO historico(secao_id,cargo_id,usuario,em,acao,dados) VALUES(?,?,?,?,?,?)'),
  };
}
function gravarBoletimUrna(secao, bu) {
  if (!stmtUrna) prepararUrna();
  const agora = new Date().toISOString();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const c of bu.cargos) {
      if (!c.cargo) continue;
      let ref = candsUrna.get(c.cargo);
      if (!ref) {
        const cargo = stmtUrna.cargo.get(c.cargo);
        if (!cargo) continue;
        ref = { cargo, ids: new Map(stmtUrna.cands.all(cargo.id).map(r => [r.numero, r.id])) };
        candsUrna.set(c.cargo, ref);
      }
      const { cargo, ids } = ref;
      const votos = new Map();
      for (const v of c.nominais) {
        const id = ids.get(v.numero);
        if (id == null) { const k = `${cargo.id}:${v.numero}`; urnas.ignorados[k] = (urnas.ignorados[k] || 0) + v.votos; continue; }
        votos.set(id, (votos.get(id) || 0) + v.votos);
      }
      const legenda = cargo.legenda ? c.legenda.reduce((a, x) => a + x.votos, 0) : 0;
      stmtUrna.bol.run(secao.id, cargo.id, 'apurada', bu.comparecimento, c.brancos, c.nulos, legenda, 'TSE', agora);
      stmtUrna.delVotos.run(secao.id, cargo.id);
      for (const [cid, v] of votos) if (v > 0) stmtUrna.voto.run(secao.id, cargo.id, cid, v);
      stmtUrna.hist.run(secao.id, cargo.id, 'TSE', agora, 'apurada', JSON.stringify({ origem: 'urna-tse', emissao: bu.emissao, comparecimento: bu.comparecimento, brancos: c.brancos, nulos: c.nulos, legenda }));
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

// Roda em segundo plano; a tela consulta /api/urnas/status.
// Cidades: uma (municipio_id), ou todas as cadastradas (todas: true).
async function importarUrnas({ municipio_id, todas, pleito = PLEITO_PADRAO }) {
  if (urnas.rodando) throw new Error('Já existe uma importação de urnas em andamento.');
  const cidades = todas ? db.prepare('SELECT * FROM municipios ORDER BY nome').all() : [db.prepare('SELECT * FROM municipios WHERE id=?').get(Number(municipio_id))].filter(Boolean);
  if (!cidades.length) throw new Error(todas ? 'Importe as seções de ao menos uma cidade do TSE antes de importar os boletins de urna.' : 'Escolha uma cidade cadastrada.');
  const fila = [], semSecao = [];
  for (const m of cidades) {
    const lista = await listarSecoesUrna(m.uf, m.nome, pleito);
    const doBanco = db.prepare('SELECT id,zona,numero,agregadas FROM secoes WHERE municipio_id=?').all(m.id);
    const porChave = new Map(doBanco.map(x => [`${x.zona}|${x.numero}`, x]));
    // seção agregada vota na urna da principal: não tem boletim próprio, os votos já estão no da principal
    const agregadas = new Set(doBanco.flatMap(x => String(x.agregadas || '').split(',').filter(Boolean).map(n => `${x.zona}|${Number(n)}`)));
    for (const s of lista.secoes) {
      const chave = `${Number(s.zona)}|${Number(s.secao)}`;
      if (agregadas.has(chave)) continue;
      const secao = porChave.get(chave);
      if (!secao) semSecao.push(`${m.nome} ${Number(s.zona)}/${Number(s.secao)}`);
      else fila.push({ m, codigo: lista.codigo, s, secao });
    }
  }
  if (!fila.length) throw new Error('Nenhuma das seções cadastradas tem boletim no TSE. Importe antes as seções da cidade.');
  prepararUrna();
  Object.assign(urnas, { rodando: true, total: fila.length, feitos: 0, gravados: 0, pendentes: 0, semSecao, falhas: [], ignorados: {}, inicio: new Date().toISOString(), fim: null, erro: null });
  const trabalhador = async () => {
    for (let it; (it = fila.shift());) {
      const nome = `${cidades.length > 1 ? it.m.nome + ' ' : ''}${Number(it.s.zona)}/${Number(it.s.secao)}`;
      try {
        const bu = await buscarBoletimUrna(it.m.uf, it.codigo, it.s.zona, it.s.secao, pleito);
        if (!bu) urnas.pendentes++;
        else if (bu.secao !== Number(it.s.secao) || bu.zona !== Number(it.s.zona)) throw new Error(`boletim de outra seção (${bu.zona}/${bu.secao})`);
        else { gravarBoletimUrna(it.secao, bu); urnas.gravados++; }
      } catch (e) { urnas.falhas.push(`${nome}: ${e.message}`); }
      if (++urnas.feitos % 10 === 0) broadcast();
    }
  };
  // não espera: devolve já, e o trabalho continua
  Promise.all(Array.from({ length: 8 }, trabalhador))
    .catch((e) => { urnas.erro = e.message; })
    .finally(() => { urnas.rodando = false; urnas.fim = new Date().toISOString(); db.prepare("INSERT OR REPLACE INTO config VALUES('urnas_importadas_em',?)").run(urnas.fim); broadcast(); });
  return { cidades: cidades.map(m => m.nome), total: urnas.total };
}

function excluirMunicipio(id) {
  db.exec('BEGIN');
  try {
    for (const t of ['votos', 'boletins', 'historico']) db.prepare(`DELETE FROM ${t} WHERE secao_id IN (SELECT id FROM secoes WHERE municipio_id=?)`).run(id);
    db.prepare('DELETE FROM secoes WHERE municipio_id=?').run(id);
    db.prepare('DELETE FROM locais WHERE municipio_id=?').run(id);
    db.prepare('DELETE FROM municipios WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}


// ---------- seções e locais (edição manual) ----------
const num = (x) => { const n = Number(String(x ?? '').replace(',', '.')); return String(x ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
function salvarSecao(b) {
  const zona = int(b.zona), numero = int(b.numero), aptos = int(b.aptos || 0), local = Number(b.local_id);
  if ([zona, numero, aptos].some(Number.isNaN) || !numero) throw new Error('Informe zona, número da seção e aptos com números válidos.');
  const loc = db.prepare('SELECT municipio_id FROM locais WHERE id=?').get(local);
  if (!loc) throw new Error('Escolha o local de votação.');
  const agregadas = String(b.agregadas || '').replace(/[^\d,]/g, '');
  try {
    if (b.id) db.prepare('UPDATE secoes SET zona=?, numero=?, local_id=?, aptos=?, agregadas=?, municipio_id=? WHERE id=?').run(zona, numero, local, aptos, agregadas, loc.municipio_id, Number(b.id));
    else db.prepare('INSERT INTO secoes(zona,numero,local_id,aptos,agregadas,municipio_id) VALUES(?,?,?,?,?,?)').run(zona, numero, local, aptos, agregadas, loc.municipio_id);
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error(`Já existe a seção ${zona}/${numero}.`); throw e; }
}
function excluirSecao(id) {
  db.prepare('DELETE FROM votos WHERE secao_id=?').run(id);
  db.prepare('DELETE FROM boletins WHERE secao_id=?').run(id);
  db.prepare('DELETE FROM secoes WHERE id=?').run(id);
}
function salvarLocal(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw new Error('Informe o nome do local.');
  const lat = num(b.lat), lng = num(b.lng);
  if ((lat != null && (lat < -35 || lat > 6)) || (lng != null && (lng < -75 || lng > -30))) throw new Error('Coordenadas fora do Brasil. Confira latitude e longitude.');
  try {
    if (b.id) db.prepare('UPDATE locais SET nome=?, endereco=?, lat=?, lng=? WHERE id=?').run(nome, String(b.endereco || ''), lat, lng, Number(b.id));
    else {
      if (!db.prepare('SELECT 1 FROM municipios WHERE id=?').get(Number(b.municipio_id))) throw new Error('Escolha uma cidade (no topo da página) antes de criar o local.');
      return Number(db.prepare('INSERT INTO locais(nome,endereco,lat,lng,municipio_id) VALUES(?,?,?,?,?)').run(nome, String(b.endereco || ''), lat, lng, Number(b.municipio_id)).lastInsertRowid);
    }
    return Number(b.id);
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error('Já existe um local com esse nome.'); throw e; }
}
function excluirLocal(id) {
  if (db.prepare('SELECT 1 FROM secoes WHERE local_id=?').get(id)) throw new Error('Este local ainda tem seções. Mova ou exclua as seções antes.');
  db.prepare('DELETE FROM locais WHERE id=?').run(id);
}


// ---------- chefe de local: link próprio, sem PIN ----------
const ipsDaRede = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
function baseUrl() {
  const c = db.prepare("SELECT v FROM config WHERE k='base_url'").get()?.v;
  return (c || `http://${ipsDaRede()[0] || 'localhost'}:${PORT}`).replace(/\/+$/, '');
}
function tokenDoLocal(localId, regenerar = false) {
  const l = db.prepare('SELECT token FROM locais WHERE id=?').get(localId);
  if (!l) throw new Error('Local inexistente.');
  if (l.token && !regenerar) return l.token;
  const t = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE locais SET token=? WHERE id=?').run(t, localId);
  return t;
}
function localPorToken(t) {
  const l = t && String(t).length >= 8 ? db.prepare('SELECT id,nome,endereco,municipio_id FROM locais WHERE token=?').get(String(t)) : null;
  if (!l) throw new Error('Link inválido ou desativado. Peça um novo link à coordenação.');
  return l;
}
// o chefe lança só os candidatos favoritos de cada cargo
function gruposFavoritos() {
  return db.prepare('SELECT * FROM cargos ORDER BY ordem').all().map(c => ({
    cargo: { id: c.id, nome: c.nome, vagas: c.vagas },
    candidatos: db.prepare('SELECT id,numero,nome,partido,vice,cor FROM candidatos WHERE cargo_id=? AND favorito=1 ORDER BY nome').all(c.id),
  })).filter(g => g.candidatos.length);
}
function dadosChefe(t) {
  const local = localPorToken(t);
  const grupos = gruposFavoritos();
  const secoes = db.prepare('SELECT id,zona,numero,aptos,agregadas FROM secoes WHERE local_id=? ORDER BY zona,numero').all(local.id);
  const bols = [];
  for (const s of secoes) for (const g of grupos) {
    const b = db.prepare('SELECT status,updated_at FROM boletins WHERE secao_id=? AND cargo_id=?').get(s.id, g.cargo.id);
    if (!b) continue;
    const votos = {};
    for (const v of db.prepare('SELECT candidato_id,votos FROM votos WHERE secao_id=? AND cargo_id=?').all(s.id, g.cargo.id)) votos[v.candidato_id] = v.votos;
    bols.push({ secao_id: s.id, cargo_id: g.cargo.id, status: b.status, updated_at: b.updated_at, votos });
  }
  return { municipio: db.prepare('SELECT nome FROM municipios WHERE id=?').get(local.municipio_id)?.nome || '', local, secoes, grupos, boletins: bols };
}
function salvarChefe(t, b) {
  const local = localPorToken(t);
  const secao = db.prepare('SELECT id FROM secoes WHERE id=? AND local_id=?').get(Number(b.secao_id), local.id);
  if (!secao) throw new Error('Esta seção não pertence ao seu local.');
  const permitidos = new Set(db.prepare('SELECT id FROM candidatos WHERE cargo_id=? AND favorito=1').all(b.cargo_id).map(c => String(c.id)));
  const votos = {};
  for (const [k, v] of Object.entries(b.votos || {})) { if (!permitidos.has(String(k))) throw new Error('Candidato fora da lista.'); votos[k] = v; }
  if (!Object.keys(votos).length) throw new Error('Digite os votos antes de enviar.');
  const quem = String(b.nome || '').trim().slice(0, 40) || 'chefe';
  salvarBoletim({ secao_id: secao.id, cargo_id: b.cargo_id, status: 'apurada', parcial: true, votos }, `${quem} · ${local.nome}`.slice(0, 80));
}

// ---------- http ----------
const clients = new Set();
const broadcast = (evt = 'update') => { versaoDados++; for (const r of clients) r.write(`event: ${evt}\ndata: ${Date.now()}\n\n`); };
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 20000);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); }); req.on('end', () => ok(d)); req.on('error', no); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/data') {
      const c = dadosComprimidos(url.searchParams.get('m') || '');
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
      return res.end(gz ? c.gz : c.cru);
    }
    if (url.pathname === '/api/tse/municipios') {
      const uf = String(url.searchParams.get('uf') || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(uf)) throw new Error('UF inválida.');
      return json(res, 200, { uf, municipios: await listarMunicipios(uf, pastaTse()) });
    }
    if (url.pathname === '/api/secao' && req.method === 'GET') { // ?id=1 ou ?id=1,2,3 (votos completos das seções)
      const ids = String(url.searchParams.get('id') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
      if (!ids.length) return json(res, 200, { boletins: [] });
      const lista = ids.join(',');
      const vm = {};
      for (const v of db.prepare(`SELECT * FROM votos WHERE secao_id IN (${lista})`).all()) (vm[`${v.secao_id}|${v.cargo_id}`] ||= {})[v.candidato_id] = v.votos;
      return json(res, 200, { boletins: db.prepare(`SELECT * FROM boletins WHERE secao_id IN (${lista})`).all().map(b => ({ ...b, votos: vm[`${b.secao_id}|${b.cargo_id}`] || {} })) });
    }
    if (url.pathname === '/api/urnas/status') return json(res, 200, urnas);
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname === '/api/chefe' && req.method === 'GET') return json(res, 200, dadosChefe(url.searchParams.get('t')));
    if (url.pathname === '/api/chefe/boletim' && req.method === 'POST') {
      salvarChefe(url.searchParams.get('t'), JSON.parse((await readBody(req)) || '{}'));
      broadcast(); return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      if (req.headers['x-pin'] !== PIN) return json(res, 401, { erro: 'PIN incorreto.' });
      versaoDados++; // qualquer escrita invalida o cache
      const usuario = decodeURIComponent(req.headers['x-user'] || 'anônimo').slice(0, 40);
      const body = JSON.parse((await readBody(req)) || '{}');
      if (url.pathname === '/api/auth') return json(res, 200, { ok: true });
      if (url.pathname === '/api/admin/link') { const t = tokenDoLocal(Number(body.local_id), !!body.regenerar); return json(res, 200, { ok: true, url: `${baseUrl()}/chefe?t=${t}`, base: baseUrl() }); }
      if (url.pathname === '/api/admin/config') { const v = String(body.base_url || '').trim(); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('Informe o endereço completo, começando com http:// ou https://'); db.prepare("INSERT OR REPLACE INTO config VALUES('base_url',?)").run(v); broadcast(); return json(res, 200, { ok: true, base: baseUrl() }); }
      if (url.pathname === '/api/boletim' && req.method === 'POST') { salvarBoletim(body, usuario); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/boletim' && req.method === 'DELETE') { excluirBoletim(body.secao_id, body.cargo_id, usuario); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/admin/importar') { const n = importar(body.tipo, body.csv, body.municipio_id); broadcast(); return json(res, 200, { ok: true, n }); }
      if (url.pathname === '/api/admin/importar-tse') { const r = await importarTse(body); broadcast(); return json(res, 200, { ok: true, ...r }); }
      if (url.pathname === '/api/admin/importar-urnas') { const r = await importarUrnas(body); return json(res, 200, { ok: true, ...r }); }
      if (url.pathname === '/api/municipio' && req.method === 'DELETE') { excluirMunicipio(Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/secao' && req.method === 'POST') { salvarSecao(body); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/secao' && req.method === 'DELETE') { excluirSecao(Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/local' && req.method === 'POST') { const id = salvarLocal(body); broadcast(); return json(res, 200, { ok: true, id }); }
      if (url.pathname === '/api/local' && req.method === 'DELETE') { excluirLocal(Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/votos-gerais') {
        const vazio = body.votos === '' || body.votos == null;
        const n = vazio ? null : int(body.votos);
        if (!vazio && Number.isNaN(n)) throw new Error('Informe um número de votos válido.');
        db.prepare('UPDATE candidatos SET votos_gerais=? WHERE id=?').run(n, Number(body.id)); broadcast(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/favorito') { db.prepare('UPDATE candidatos SET favorito=? WHERE id=?').run(body.favorito ? 1 : 0, Number(body.id)); broadcast(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/admin/zerar') { zerar(body.escopo); broadcast(); return json(res, 200, { ok: true }); }
      return json(res, 404, { erro: 'Rota não encontrada.' });
    }
    // estáticos
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!path.extname(p)) p += '.html';
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 400, { erro: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nApuração Aracati 2026 rodando.\n  Neste computador: http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Na rede (celulares): http://${i.address}:${PORT}`);
  console.log(`  PIN de lançamento: ${PIN} ${process.env.VOTOS_PIN ? '' : '(padrão; defina VOTOS_PIN para trocar)'}\n`);
});
