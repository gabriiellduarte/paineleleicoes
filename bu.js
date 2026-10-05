// Leitor de Boletim de Urna (arquivo .bu / .dat do TSE): ASN.1 em BER, sem dependências.
// Estrutura (conforme observada nos arquivos oficiais de 2026):
//   envelope { cabecalho, tipo, identificacao, ..., OCTET STRING(EntidadeBoletimUrna) }
//   EntidadeBoletimUrna {
//     ..., [0] { abertura, encerramento }, comparecimento, [1] { biometria, manual, ... },
//     resultadosVotacaoPorEleicao { eleição { idEleicao, ..., votacoes { votacao { tipo, comparecimento, totaisVotosCargo { cargo { [1]codigoCargo, ..., votos } } } } } }
//   }
//   voto = { [1]tipoVoto (1 nominal, 2 branco, 3 nulo, 4 legenda), [2]quantidade, [3]{partido, número}, ordem, hash }

function tlv(b, p) {
  const t0 = b[p++];
  const cls = t0 >> 6, cons = !!(t0 & 32);
  let tag = t0 & 31;
  if (tag === 31) { tag = 0; let x; do { x = b[p++]; tag = tag * 128 + (x & 127); } while (x & 128); }
  let len = b[p++];
  if (len & 128) { const n = len & 127; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p++]; }
  if (p + len > b.length) throw new Error('Arquivo BU truncado ou corrompido.');
  return { cls, cons, tag, start: p, end: p + len };
}

// Lê os filhos de um nó construído. Cada filho: { cls, tag, cons, v (Buffer), kids() }.
function filhos(b, s, e) {
  const out = [];
  for (let p = s; p < e;) {
    const t = tlv(b, p);
    const v = b.subarray(t.start, t.end);
    out.push({ ...t, v, b, kids: () => (t.cons ? filhos(b, t.start, t.end) : []) });
    p = t.end;
  }
  return out;
}

const inteiro = (n) => { let x = 0; for (const c of n.v) x = x * 256 + c; return x; };
const texto = (n) => n.v.toString('latin1');
const kidsOf = (n) => n.kids();

export const CARGO_POR_CODIGO = { 1: 'presidente', 3: 'governador', 5: 'senador', 6: 'dep_federal', 7: 'dep_estadual' };

// Dá erro claro se não parecer um BU.
export function lerBoletim(buf) {
  let raiz;
  try { raiz = filhos(buf, 0, buf.length); } catch (e) { throw new Error(`Não é um boletim de urna válido (${e.message})`); }
  if (raiz.length !== 1 || !raiz[0].cons) throw new Error('Não é um boletim de urna válido.');
  const env = kidsOf(raiz[0]);
  const octeto = [...env].reverse().find((n) => n.cls === 0 && n.tag === 4);
  if (!octeto) throw new Error('Boletim sem o bloco de dados (OCTET STRING).');
  const corpo = filhos(octeto.v, 0, octeto.v.length);
  if (corpo.length !== 1) throw new Error('Bloco de dados do boletim inesperado.');
  const f = kidsOf(corpo[0]);

  // identificação: [0] { { município, zona }, local, seção } aparece como o primeiro U16 que contém C0 / ou SEQUENCE com 3 filhos
  const idSecao = f.filter((n) => n.cls === 0 && n.tag === 16).map(kidsOf).find((k) => k.length === 3 && k[0].cons && k[1].tag === 2 && k[2].tag === 2);
  if (!idSecao) throw new Error('Não achei a identificação da seção no boletim.');
  const [mz] = idSecao;
  const [municipio, zona] = kidsOf(mz).map(inteiro);
  const local = inteiro(idSecao[1]), secao = inteiro(idSecao[2]);

  const datas = f.filter((n) => n.cls === 0 && n.tag === 27).map(texto);              // emissão
  const c0 = f.find((n) => n.cls === 2 && n.tag === 0);                                // abertura/encerramento
  const [abertura, encerramento] = c0 ? kidsOf(c0).map(texto) : [];
  const comparecimento = inteiro(f.find((n) => n.cls === 0 && n.tag === 2));
  const resultados = f.filter((n) => n.cls === 0 && n.tag === 16).map(kidsOf).find((k) => k.length && k.every((x) => x.cons && x.tag === 16 && kidsOf(x)[0]?.tag === 2 && kidsOf(x).length >= 5));
  if (!resultados) throw new Error('Boletim sem resultados de votação.');

  const cargos = [];
  for (const eleicao of resultados) {
    const ek = kidsOf(eleicao);
    const idEleicao = inteiro(ek[0]);
    const votacoes = kidsOf(ek[4]);
    for (const votacao of votacoes) {
      for (const grupo of kidsOf(votacao).filter((n) => n.cons && n.tag === 16)) {      // totaisVotosCargo
        for (const cargo of kidsOf(grupo)) {
          const ck = kidsOf(cargo);
          const codigo = inteiro(ck.find((n) => n.cls === 2 && n.tag === 1));
          const lista = ck.find((n) => n.cons && n.tag === 16 && n.cls === 0);
          if (!lista) continue;
          const itens = { nominais: [], legenda: [], brancos: 0, nulos: 0 };
          for (const v of kidsOf(lista)) {
            const vk = kidsOf(v);
            const tipo = inteiro(vk.find((n) => n.cls === 2 && n.tag === 1));
            const qtd = inteiro(vk.find((n) => n.cls === 2 && n.tag === 2));
            const id = vk.find((n) => n.cls === 2 && n.tag === 3);
            if (tipo === 2) itens.brancos += qtd;
            else if (tipo === 3) itens.nulos += qtd;
            else if (id) {
              const nums = kidsOf(id).map(inteiro);
              const numero = String(nums[nums.length - 1]);
              (tipo === 4 ? itens.legenda : itens.nominais).push({ numero, partido: nums.length > 1 ? nums[0] : null, votos: qtd });
            } else itens.nulos += 0;
          }
          cargos.push({ eleicao: idEleicao, codigo, cargo: CARGO_POR_CODIGO[codigo] || null, ...itens });
        }
      }
    }
  }
  return { municipio, zona, local, secao, emissao: datas[0] || '', abertura, encerramento, comparecimento, cargos };
}
