# Agente IA · Concurso GM São Gonçalo

Painel de estudos para o concurso da Guarda Municipal de São Gonçalo (RJ), edital nº 001/PMSG/2026, banca Instituto Selecon. Prova objetiva em 24/01/2027.

- **Plano do dia** que se ajusta ao seu ritmo, com as 589 aulas do curso até 02/01 e depois revisão e simulados.
- **Revisão espaçada** (1, 7 e 30 dias), **flashcards** das leis, **cronômetro** de estudo.
- **Questões, simulados, lei seca e TAF**, com gráficos de evolução.
- **Professor IA**: gera questões no estilo Selecon a partir do texto oficial das leis, tira dúvidas e analisa seu desempenho.

## Como funciona

| Parte | Onde roda |
|---|---|
| Site (`public/`) | Vercel, como app instalável (PWA) |
| Login e progresso | Supabase (tabela `docs`, criada por `supabase.sql`) |
| Professor IA (`api/claude.js`) | Função da Vercel que chama a API do Claude com a chave guardada no servidor |

## Variáveis de ambiente na Vercel

| Nome | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | chave da API da Anthropic |
| `SUPABASE_URL` | Project URL do Supabase |
| `SUPABASE_ANON_KEY` | chave anon do Supabase |
| `ALLOWED_EMAILS` | e-mails que podem usar a IA, separados por vírgula |
| `CLAUDE_MODEL` | opcional; padrão `claude-opus-5-5` |

O passo a passo completo está em `COMO PUBLICAR.txt`.

As leis em `public/leis/` são textos oficiais (Planalto e Diário Oficial de São Gonçalo), com a fonte na primeira linha de cada arquivo.
