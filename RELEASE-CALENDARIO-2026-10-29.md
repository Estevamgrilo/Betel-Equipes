# Publicação consolidada — Betel Equipes

Versão: indisponibilidades por calendário, 29/10/2026.

Este commit reúne, em uma única implantação da branch main, as alterações já presentes nos arquivos da aplicação:
- Cadastro de indisponibilidade por datas, sem depender de eventos previamente cadastrados.
- Bloqueio de novas atribuições manuais quando o voluntário estiver indisponível na data.
- Respeito às indisponibilidades na geração e aprovação de escalas automáticas.
- Liberação de períodos completos ou datas específicas de uma indisponibilidade.
- Respostas HTML com cache desativado para evitar interface antiga.

Não modifica o banco de dados nem remove escalas existentes.
