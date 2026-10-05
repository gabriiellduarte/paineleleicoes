// Baixa os boletins de urna (BU) oficiais direto do TSE, seção por seção.
//   1. {pleito}/config/{uf}/{uf}-p00{pleito}-cs.json          → municípios, zonas e seções já totalizadas
//   2. dados/{uf}/{mun}/{zona}/{secao}/p00{pleito}-{uf}-m{mun}-z{zona}-s{secao}-aux.json → hash do arquivo
//   3. dados/{uf}/{mun}/{zona}/{secao}/{hash}/o0{pleito}{uf}{mun}{zona}{secao}-bu.dat   → o boletim (ASN.1)
import { lerBoletim } from './bu.js';
import { semAcento } from './tse.js';

const BASE = process.env.URNA_BASE || 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna';
export const PLEITO_PADRAO = process.env.URNA_PLEITO || '3220'; // Eleições Gerais 2026, 1º turno

const CABECALHOS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: 'https://resultados.tse.jus.br/oficial/app/index.html',
};
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// GET com novas tentativas. 404 devolve null (o arquivo ainda não existe).
async function baixar(url, tentativas = 3) {
  let erro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: CABECALHOS, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`TSE respondeu ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { erro = e; await pausa(500 * (i + 1)); }
  }
  throw new Error(`${url.split('/').slice(-1)[0]}: ${erro.message}`);
}

const pleitoOk = (p) => { if (!/^\d{3,5}$/.test(String(p))) throw new Error('Código do pleito inválido.'); return String(p); };

// Lista as seções do município que já têm boletim publicado.
export async function listarSecoesUrna(uf, municipio, pleito = PLEITO_PADRAO) {
  pleito = pleitoOk(pleito);
  const u = uf.toLowerCase();
  const buf = await baixar(`${BASE}/${pleito}/config/${u}/${u}-p${pleito.padStart(6, '0')}-cs.json`);
  if (!buf) throw new Error(`O TSE não tem o pleito ${pleito} para ${uf.toUpperCase()}.`);
  const cfg = JSON.parse(buf.toString('utf8'));
  const alvo = semAcento(municipio);
  const mu = (cfg.abr || []).flatMap((e) => e.mu || []).find((m) => semAcento(m.nm) === alvo || m.cd === String(municipio));
  if (!mu) throw new Error(`Município "${municipio}" não encontrado na apuração do TSE (${uf.toUpperCase()}).`);
  const secoes = mu.zon.flatMap((z) => z.sec.map((s) => ({ zona: z.cd, secao: s.ns })));
  return { codigo: mu.cd, nome: mu.nm, secoes };
}

// Baixa e decodifica o boletim de uma seção. Devolve null se ainda não foi publicado.
export async function buscarBoletimUrna(uf, codigoMunicipio, zona, secao, pleito = PLEITO_PADRAO) {
  pleito = pleitoOk(pleito);
  const u = uf.toLowerCase();
  const dir = `${BASE}/${pleito}/dados/${u}/${codigoMunicipio}/${zona}/${secao}`;
  const auxBuf = await baixar(`${dir}/p${pleito.padStart(6, '0')}-${u}-m${codigoMunicipio}-z${zona}-s${secao}-aux.json`);
  if (!auxBuf) return null;
  const aux = JSON.parse(auxBuf.toString('utf8'));
  // Pode haver mais de uma versão (reimpressão); vale a última publicada.
  const versao = [...(aux.hashes || [])].reverse().find((h) => (h.arq || []).some((a) => a.tp === 'bu'));
  if (!versao) return null;
  const nome = versao.arq.find((a) => a.tp === 'bu').nm;
  const bu = await baixar(`${dir}/${versao.hash}/${nome}`);
  if (!bu) return null;
  return lerBoletim(bu);
}
