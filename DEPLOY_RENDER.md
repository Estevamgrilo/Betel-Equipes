# Betel Equipes — implantação de testes no Render

## Atenção
**Somente testes com dados fictícios.** A V22 ainda não foi auditada para dados pessoais reais. O serviço será acessível pela internet; não divulgue o endereço. O repositório pode ser público porque não contém segredos, mas não publique arquivos `.env` ou `data/`.

## Preparação
1. No GitHub, envie o conteúdo desta pasta **para a raiz** do repositório `Estevamgrilo/Betel-Equipes` (não envie a pasta como subpasta). Inclua o `render.yaml`.
2. No Render, crie o Blueprint a partir desse repositório e confira custos e disponibilidade dos planos de Web Service e PostgreSQL antes de confirmar. O `render.yaml` é apenas uma proposta; altere planos conforme sua conta e orçamento.
3. O Render provisionará o PostgreSQL e configurará `DATABASE_URL`, `NODE_ENV` e `BETEL_SETUP_KEY` no serviço. **Não publique o valor de `BETEL_SETUP_KEY`**.
4. Após deploy, verifique `https://SEU-ENDERECO.onrender.com/healthz` e procure `storage: postgresql`.
5. Faça setup do master com dados fictícios e a chave de setup via POST `/api/setup`. Para evitar expor a chave em histórico, utilize uma ferramenta API que não grave credenciais em repositórios; nunca inclua a chave em capturas de tela.
6. Teste login, logout, convites, permissões e criação de eventos com dados fictícios. Reinicie o serviço e verifique persistência.

## Limitações
- `app_state` JSONB é armazenamento intermediário; não são usadas ainda as tabelas normalizadas.
- Testes reais com PostgreSQL e auditoria de segurança ainda pendentes.
- Não rode mais de uma instância do serviço.
- Tokens em `sessionStorage` e ausência de proteções completas de produção.
- Não use dados reais de voluntários antes de revisão de privacidade, segurança e backup.
- A criação dos ciclos é manual e não há scheduler persistente.
