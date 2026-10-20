# Agente IA · Concurso GM São Gonçalo

Painel de estudos para o concurso da Guarda Municipal de São Gonçalo (RJ), edital nº 001/PMSG/2026, banca Instituto Selecon. Prova objetiva em 24/01/2027.

- **Plano do dia** que se ajusta ao seu ritmo, com as 589 aulas do curso até 02/01 e depois revisão e simulados.
- **Revisão espaçada** (1, 7 e 30 dias), **flashcards** das leis, **cronômetro** de estudo.
- **Questões, simulados, lei seca e TAF**, com gráficos de evolução.
- **Professor IA**: gera questões no estilo Selecon a partir do texto oficial das leis, tira dúvidas e analisa seu desempenho.

## Como rodar no Mac

Dois cliques em `Abrir painel.command`, ou:

```bash
npm install
npm start          # lê a chave do arquivo .env (veja .env.example)
```

O painel abre em http://localhost:3000. O progresso fica salvo no navegador (localStorage), com backup e importação na aba **Ajustes**.

## Como funciona

| Parte | O que faz |
|---|---|
| `public/` | O painel (HTML único, ícones, leis, service worker) |
| `server.js` | Servidor local: entrega `public/` e encaminha `/api/claude` |
| `api/claude.js` | Chama a API do Claude com a chave guardada no servidor; também funciona como função da Vercel |

## Variáveis de ambiente

| Nome | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | chave da API da Anthropic |
| `CLAUDE_MODEL` | opcional; padrão `claude-opus-5-5` |
| `APP_PASSWORD` | obrigatória só na Vercel: senha que o navegador envia para usar a IA |

As leis em `public/leis/` são textos oficiais (Planalto e Diário Oficial de São Gonçalo), com a fonte na primeira linha de cada arquivo.
