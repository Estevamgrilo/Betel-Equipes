# Betel Equipes V7 — teste local

## Iniciar
Requer Node.js 20+. Entre na pasta, configure `BETEL_SETUP_KEY` e execute `npm start`.

```bash
export BETEL_SETUP_KEY='defina-uma-chave-secreta-longa'
npm start
```

Acesse http://localhost:3000. O primeiro master deve ser criado **uma única vez** via API:

```bash
curl -X POST http://localhost:3000/api/setup -H 'Content-Type: application/json' -d '{"setupKey":"defina-uma-chave-secreta-longa","name":"Administrador","email":"admin@exemplo.com","password":"uma-senha-forte-com-12-caracteres"}'
```

Entre no site com e-mail e senha. No painel `/painel.html`, o master pode criar equipes, gerar convites e delegar níveis e equipes. Voluntários se cadastram pela opção de código na página inicial.

## Limites desta versão
Esta é uma **versão de desenvolvimento local**. O armazenamento ainda é JSON (`data/database.json`) e **não é PostgreSQL**. As escalas, cursos, notificações, trilhas, recuperação de senha e sincronização do protótipo V5 ainda não foram implementadas. A página do protótipo V5 usa dados simulados. Não disponibilize publicamente ou use dados pessoais reais antes de revisão de segurança, testes, proteção contra abuso, política de privacidade e migração para banco adequado. Sessões ficam em sessionStorage, apenas para teste local. Mantenha a pasta `data` fora de backups compartilhados e nunca publique as credenciais.


## Ajuste da logo
A logo oficial foi substituída pelo arquivo enviado novamente (`public/logo-betel-oficial.png`). A tela de acesso usa caminho relativo com versão para evitar cache antigo.


## V8 — agenda e escalas manuais
Após entrar, use **Agenda e escalas reais** no painel. Master ou líder geral cria eventos, seleciona equipes e determina explicitamente se haverá transmissão. Liderança autorizada pode escalar e substituir pessoas manualmente. Mudanças são registradas no log. Sem geração automática, aprovação de ciclos, verificação de conflito ou habilitação técnica nesta etapa. O banco continua JSON local, **não apto para produção**.

## V9 — motor inicial de propostas
API autenticada: `POST /api/functions` (sector, name, automatic), `GET /api/functions`, `POST /api/skills` (userId, functionId, approved), `POST /api/unavailability` (from, to), `POST /api/schedule/preview` (eventIds), `GET /api/schedule/proposals`, `POST /api/schedule/approve` (proposalId).

A geração é **manual sob demanda**, não agenda ciclos de 60 dias. Só considera funções marcadas automatic=true, voluntários com habilitação validada, indisponibilidade e conflitos de mesmo evento e intervalo de 12 horas. Propostas são rascunhos, aprovação aplica apenas vagas livres e registra auditoria. Ainda não existe UI para essas APIs, pontuação, trilha, equilíbrio avançado de experiência, transações, PostgreSQL nem testes completos. **Não use em produção.**

## V10 — painel de propostas inteligentes
Na página `/painel.html`, líderes master e geral têm a seção **Escalas inteligentes**. Selecionam eventos, geram proposta, veem atribuições e alertas, e confirmam aplicação apenas às vagas livres. A API da V9 continua responsável pela validação.

**Limitações:** não há edição individual de propostas, regras completas de equilíbrio, ciclos de 60 dias ou banco PostgreSQL. O armazenamento JSON e sessões de teste não são adequados para produção. Não cadastre dados pessoais reais nem publique o servidor na internet.

## V11 — edição de propostas antes da aprovação
Na tela Escalas inteligentes, o líder master ou geral pode escolher uma vaga sugerida, substituir o voluntário ou remover a sugestão. A API `POST /api/schedule/edit` exige autenticação, valida permissões, habilitação, indisponibilidade e conflitos de 12 horas e registra auditoria. Após editar, gere nova prévia para revisão.

**Limites:** a V11 não implementa ainda classificação de experiência, distribuição avançada, ciclos de 60 dias nem PostgreSQL. O sistema permanece para testes locais.


## V12 — equilíbrio inicial de experiência e carga
O motor considera `skills.level` (estagiario, iniciante, intermediario, avancado, diretor), **por função**, ao selecionar pessoas já habilitadas. Penaliza concentração de escalas nos últimos 14 dias e repetição no mesmo dia. Prioriza mentor avançado quando já há iniciante na equipe e alerta quando o conjunto não tem mentor. Não bloqueia aprovação por alerta, nem garante combinação perfeita: exige revisão do líder.

A V12 **não** inclui interface para editar níveis; estes podem ser preenchidos no registro de habilidade, com aprovação da liderança. Não há ciclos automáticos de 60 dias nem banco PostgreSQL. Não utilizar em produção.

## V13 — ciclos de 60 dias (primeira etapa)
APIs autenticadas para master/líder geral: `POST /api/cycles/config` com `{ "anchor": "2026-11-01" }`, `GET /api/cycles` e `POST /api/cycles/prepare`. O intervalo de cada ciclo é de 60 dias (inclusive); a preparação do próximo ocorre a partir do dia 45 do ciclo anterior, 15 dias antes do início. A preparação é idempotente, preserva ciclos anteriores, não altera eventos nem atribuições e deixa cada ciclo `pending_review`.

**Ainda não existe execução automática em segundo plano, interface de ciclos, geração automática de eventos nem publicação de escalas.** A API `prepare` precisa ser chamada por um líder ou por um agendador futuro. A aprovação de propostas segue o fluxo anterior. A data é calculada em UTC, portanto revisar fuso horário antes de produção. Banco JSON local, não apto para dados reais.


## V14 — painel de ciclos
A tela autenticada do líder master/geral agora mostra a Central de Ciclos: configura a âncora, lista ciclos, prepara ciclos elegíveis e seleciona eventos dentro do período para gerar propostas. Os eventos devem existir previamente; a preparação não cria cultos, não publica escalas e não agenda tarefas em segundo plano. O líder deve revisar e aprovar cada proposta em Escalas inteligentes. O armazenamento continua JSON local, apenas para desenvolvimento.

## V15 — cultos recorrentes
No painel de ciclos, configure a ativação dos cinco horários padrão e clique em **Criar cultos no ciclo selecionado**. O endpoint `POST /api/recurrence/generate` cria eventos idempotentemente por chave de recorrência e data; não cria atribuições nem habilita transmissão. `GET/POST /api/recurrence` permitem consultar e salvar os horários. Eventos especiais continuam manuais. A preparação de ciclos ainda é manual, sem agendador em segundo plano. Os setores padrão excluem transmissão, que exige decisão explícita do líder. Para personalizar títulos, horários e setores além dos padrões, use a API; a interface atual alterna apenas ativação. Banco JSON e autenticação de teste: não utilizar em produção.

## V16 — fundação PostgreSQL e testes automatizados
Inclui esquema relacional inicial em `db/migrations/001_initial.sql` e testes dos ciclos com `npm test`. **O servidor continua lendo e gravando JSON**. A migração de persistência e a implantação HTTPS são etapas futuras.

## V17 — Persistência PostgreSQL (primeira integração)

Execute `npm install` e defina `DATABASE_URL` para habilitar o PostgreSQL. O servidor cria uma tabela `app_state` e guarda o estado da aplicação em `jsonb` com controle de revisão. Sem `DATABASE_URL`, em desenvolvimento, usa JSON local; em `NODE_ENV=production`, a ausência da URL impede a inicialização. **Esta é uma migração intermediária, não o uso das tabelas normalizadas do esquema V16.**

Antes de apontar para um banco novo, confira se o arquivo local `data/database.json` contém apenas dados de teste: o estado inicial é copiado somente na primeira inicialização. Não rode várias instâncias simultaneamente: a revisão detecta concorrência, mas a camada atual não implementa retry automático. Faça backup antes de migrar.

A autenticação por token em `sessionStorage`, ausência de rate limiting, políticas de sessão e outras limitações impedem exposição pública. Esta entrega não foi testada com um servidor PostgreSQL real.


## V18 — Proteções iniciais e verificação
- Limitação básica de 15 requisições por 15 minutos por IP para login, cadastro e configuração inicial. Em produção, substituir por solução compartilhada e confiável atrás de proxy.
- Cabeçalhos de segurança para respostas HTML e API (CSP inicial, proteção contra iframe, Referrer-Policy).
- Não é uma revisão de segurança completa. Tokens permanecem em sessionStorage e PostgreSQL real ainda não foi validado.
- Execute `npm test` e `npm start` para testar localmente.


## V19 — Encerramento de sessão no servidor
- `POST /api/logout` invalida o token apresentado no servidor e registra o encerramento no histórico.
- O botão **Sair** do painel chama essa API antes de apagar o token local.
- O fluxo de logout foi verificado com uma chamada real ao servidor local.
- Ainda faltam testes com PostgreSQL real, autenticação com cookies HttpOnly, revisão de autorização e implantação HTTPS. **Não publicar para uso real.**

## V20 — Testes de integração e ambiente PostgreSQL descartável
- `npm test` executa testes unitários e teste de ponta a ponta **local** de setup, login, logout e persistência após reinício.
- `docker compose -f docker-compose.test.yml up -d` inicia PostgreSQL de testes, exigindo `POSTGRES_TEST_PASSWORD`.
- `DATABASE_URL_TEST=postgres://betel_test:SENHA@127.0.0.1:5433/betel_test npm test` também executa teste real de PostgreSQL (somente banco exclusivo descartável). Instale dependências com `npm install` antes.
- O teste PostgreSQL verifica reconexão, escrita e revisão concorrente. Ele altera temporariamente a chave `__v20_probe` do estado: **nunca executar contra banco com dados reais**.
- Sem Docker/PostgreSQL disponível, o teste de banco é pulado e não se pode afirmar conexão real validada.
- **Ainda não é seguro publicar**: falta cookie HttpOnly, proteção CSRF, backup, revisão de permissões e testes com proxy HTTPS.


## V21 — reforço de sessões e acesso
- Sessões passam a expirar em 12 horas (antes, 24 horas).
- Sessões expiradas são removidas da memória persistida na próxima operação que salva o banco.
- Alteração de cargo ou equipes revoga todas as sessões do usuário afetado, exigindo novo login.
- Cabeçalhos adicionais de proteção: Permissions-Policy e Cross-Origin-Resource-Policy.
- Testes de integração de revogação de sessão e autorização incluídos.

**Atenção:** ainda não houve validação com PostgreSQL real ou publicação HTTPS. Não cadastrar dados reais antes de auditoria e testes de infraestrutura.
