# Betel Equipes

Aplicativo de gestão de equipes e escalas da Igreja Batista Betel.

## Status

Repositório inicializado. **O código da versão V21 ainda não foi enviado integralmente.** Não tente implantar este repositório no Render antes de adicionar os arquivos do aplicativo.

## Requisitos

- Node.js 20 ou superior
- PostgreSQL para produção
- Variáveis de ambiente definidas no painel da hospedagem (não no repositório)

## Arquivos a adicionar

`server.js`, `scheduler.js`, `cycles.js`, `package.json`, `public/`, `db/` e `tests/` do pacote V21.

## Segurança

Nunca publicar `.env`, `data/database.json`, senhas, tokens ou dados reais de voluntários. A V21 é uma versão de testes e ainda requer validação de integração PostgreSQL e revisão de segurança antes do uso público.
