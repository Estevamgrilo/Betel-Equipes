# PostgreSQL — preparação da migração

O arquivo `migrations/001_initial.sql` define a primeira estrutura relacional. Execute somente em um banco PostgreSQL **de testes**, com credenciais próprias e backups. Exemplo: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial.sql`.

**Atenção:** o servidor atual ainda usa JSON local. Esta migração cria tabelas, mas não altera a persistência do aplicativo nem importa os dados existentes. Não execute em produção. Antes da mudança real, implementar camada de acesso PostgreSQL, migração de dados, transações, testes de autorização, recuperação e backups.
