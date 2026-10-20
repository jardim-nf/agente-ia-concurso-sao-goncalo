#!/bin/bash
# Dois cliques neste arquivo abrem o painel no navegador. Deixe a janela do Terminal aberta enquanto estuda.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "O Node.js não está instalado. Baixe em https://nodejs.org e tente de novo."
  read -r -p "Aperte Enter para fechar."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Preparando na primeira vez..."
  npm install --no-audit --no-fund || { read -r -p "Falhou. Aperte Enter para fechar."; exit 1; }
fi

if [ ! -f .env ]; then
  echo
  echo "Para ligar o Professor IA, cole sua chave da API da OpenAI (começa com sk-)"
  echo "ou da Anthropic (começa com sk-ant-). Os caracteres não aparecem enquanto você cola."
  echo "Ela fica salva só neste Mac, no arquivo .env desta pasta. Enter em branco pula esta etapa."
  read -r -s -p "Chave: " KEY
  echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  if [ -n "$KEY" ]; then
    umask 077
    case "$KEY" in
      sk-ant-*) printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" > .env; echo "Chave da Anthropic salva." ;;
      *) printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=gpt-4o-mini\n' "$KEY" > .env; echo "Chave da OpenAI salva (modelo gpt-4o-mini)." ;;
    esac
  fi
fi

(sleep 1.5; open "http://localhost:3000") &
if [ -f .env ]; then
  node --env-file=.env server.js
else
  node server.js
fi
