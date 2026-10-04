# Apuração Aracati 2026

Acompanha a apuração por seção, usando o boletim de urna. Sem dependências: precisa só do Node 22.13 ou mais novo.

## Rodar

```bash
VOTOS_PIN=suasenha npm start
```

Abre em `http://localhost:3000`. O terminal mostra também o endereço da rede (ex.: `http://192.168.x.x:3000`) para abrir no celular ou na TV, desde que estejam no mesmo Wi-Fi.

## Telas

| Endereço | Para quê |
|---|---|
| `/` | Dashboard: mapa, ranking, tabela de seções |
| `/lancar` | Digitar o boletim de urna (pede nome e PIN) |
| `/telao` | Tela cheia para TV. `?cargo=governador` fixa o cargo, `?foco=13` destaca o candidato, `?auto=1` alterna os cargos a cada 20 s |
| `/admin` | Importar seções e candidatos (CSV), zerar dados |

## Antes da eleição

O jeito mais rápido: em `/admin`, clique em **Importar do TSE** (UF e município já vêm como CE e Aracati). Ele grava candidatos dos cinco cargos, seções, locais, endereços, coordenadas e aptos, e apaga os dados de exemplo. Pode clicar de novo para atualizar. Os arquivos baixados ficam em `data/tse/`.

Por planilha (alternativa):

1. Em `/admin`, importe as seções (`zona;secao;local;endereco;lat;lng;aptos`) e os candidatos (`cargo;numero;nome;partido`).
2. Clique em Apagar tudo uma vez para remover os dados de exemplo **antes** de importar os reais.
3. Defina `VOTOS_PIN` e passe o PIN para quem for lançar.

## Regras de conferência

Votos de candidatos + legenda + brancos + nulos precisam bater com o comparecimento (senador: comparecimento × 2). Só boletins salvos como "apurada" entram nos totais; rascunhos aparecem como "em lançamento".

Dados ficam em `data/votos.db` (SQLite). Cada gravação e exclusão fica na tabela `historico`.
# paineleleicoes
