# TAIGA MCP Policy Engine — Implementation runbook v1.0 (consolidado, executável; R6 aplicado)
24/11/2026. Consenso Claude+GPT registrado em `debate-r5-claude.md`. **Este documento é a única fonte de execução.** Substitui `archive/implementation-v0.3-superseded.md`. Não depende do Taiga para gerenciar a implementação: o estado vive aqui (checklist §3), em commits e em `evidence/` (§2.4). **Autorização:** nada é executado antes de o PO dizer explicitamente "pode começar". Dados normativos: `architecture.md` (modelo de dados, formato de política, catálogo, diagramas), `ui/mockups.html` (visual normativo), `matrix-alignment.md` + a matriz DRAFT de 64 pares (alvo da v2).

## 1. Decisões fechadas (não reabrir)
1. **Escopo integral, KISS.** Um backend TypeScript (taiga-mcp existente), um Postgres, UI vanilla TS, um motor. Sem React, Redis, Kafka, ORM, DSL, broker. Funções e módulos, não hierarquia de classes. Preservar pnpm/lockfile/Node 22/`node:test`. **Proibido `.mjs`**: tudo `.ts`.
2. **v1 = paridade com o legado** (7 estados, 49 pares, código atual). **v2 = matriz de 64 pares**, candidata aprovada pela UI do próprio motor, nunca default de projeto existente. O schema nasce com: chave semântica de estado, owner/ator por papel fixo OU `executor`/`validator`, destinatário explícito em notificações.
3. **GPT-only** = política com `executorAllowed=[gpt]` e `validatorAllowed=[gpt]` (v1: troca de atores e rotas, mesma estrutura). Reversível por nova proposta+ativação. Passado nunca reescrito.
4. **Topologia (medida):** host único `scope-dev`, usuário `dev`, `systemd --user`. Passa a haver **UM processo HTTP residente** com `/mcp` (bearer por ator) + listener admin privado `/admin` no mesmo processo; **um `TaigaClient` por ator** (credenciais `TAIGA_<ATOR>_USERNAME/PASSWORD`). O túnel do GPT e o registro MCP do Claude apontam para o residente. Launchers stdio antigos desligados no cutover, nunca em paralelo com o residente em modo de negócio. Se o `tunnel-client` não encaminhar o bearer: adapter stdio fino.
5. **Postgres:** `pg`, migrations SQL numeradas, advisory lock de sessão por projeto, journal. Dados em **disco local**, nunca em `/scope` (NFS). `DATABASE_URL` é a única ligação host-específica.
6. **Ativação (A-6):** 409 com a lista se houver Task em In Progress, Request, GPT Validation ou Human Decision; Story/Epic em fase ativa; request/continuation/merge pendente; journal incerto. Teste concorrente sob lock.
7. **Journal (A-7):** uma linha por transição composta (comentário+PATCH), escrita antes do comentário e fechada após `verify` (com fase `pending_effect` até o efeito recuperável existir, ver F3.4), dentro de `mutate`. **Journal é evidência de recuperação, nunca autoridade**; o status do Taiga manda. (Decisão explícita: contradiz a premissa antiga "nada sobrevive à chamada".)
8. **Auth admin (A-5):** bearer PO existente, mantido só em memória da página (sem cookie, sem localStorage, sem CSRF próprio), checagem de Host/Origin; GET também responde 401 sem token.
9. **Integração e CI (ajuste R6-2):** sem push autônomo. O PO autoriza a publicação da branch DEV ou fornece execução CI equivalente no SHA exato. **A próxima fatia só começa após o gate verde**; a branch seguinte parte do SHA aceito da anterior via GitGate, nunca de `main` desatualizada. Se não houver CI disponível, registrar testes locais como provisórios; não marcar a fatia concluída nem avançar até execução equivalente autorizada no mesmo SHA.
9b. **Git (D2):** código em branch GitGate do repo `/scope/taiga/taiga-mcp` (sem git cru, sem push). Docs de design ficam em `/scope/taiga/taiga-mcp/docs/policy-engine`.
10. **M-3 assinatura** centralizada no residente (§6.F3). **M-4** reconcile paginado por `version` (§6.F3b). **M-5** Human Decision simplificado só na v2. **B-1..B-6** conforme `debate-r5-claude.md` §2.
11. **D-5/D-6:** v1 preserva (risco conhecido registrado); v2 nega GPT→Cancelled em Human Decision e Done.
12. **WIP por Sprint; External Blocked não terminal e fora do contador; Done manual do PO nunca autoriza merge.**

## 1A. KISS/YAGNI — revisão final do PO (normativa, prevalece sobre exemplos históricos)
- Implementar somente o caminho necessário para o requisito atual. Reusar código, bibliotecas, contratos e infraestrutura existentes. A árvore §4 é mapa de responsabilidades, não obrigação de criar um arquivo, classe ou interface por responsabilidade; separar apenas quando melhora leitura/teste ou elimina duplicação real. Um evaluator, um catálogo, um service, um acesso PG e um mecanismo de recuperação; nenhuma camada de abstração para tecnologia futura.
- Sem fallback especulativo, cadeia de fallback, retry genérico, circuit breaker, cache distribuído, fila nova, HA, plugin engine, provider abstraction ou feature flag de conveniência. Ausência de configuração obrigatória, versão inválida, conflito, falta de permissão ou dependência indisponível: erro explícito, sem alternativa permissiva. Não implementar dois caminhos de transporte: medir tunnel em F0, escolher HTTP direto; adapter stdio fino somente se incompatibilidade real comprovada, e só no transporte.
- Falhas que merecem tratamento agora: timeout/indisponibilidade de Taiga ou PG, concorrência real, restart/crash após comentário ou PATCH, perda de entrega Bridge, migração parcial e deploy reprovado. Reusar mutate, readback, journal/continuation existentes e transações PG; uma recuperação por operação, sem retry cego de write. Se evidência insuficiente, marcar uncertain, mostrar ao operador e parar a operação afetada. Não construir recuperação automática para todas combinações hipotéticas. Reusar envelope assinado persistido; não gerar nova autorização em cada retry.
- Um reconcile periódico simples (loop paginado sequencial por projeto, sem sobreposição, limites configuráveis), usando version e histórico apenas quando necessário. Guardar somente ID/versão/evento necessário para dedup e recovery, nunca espelhar cards completos. Sem polling adaptativo, scheduler próprio, webhook alternativo ou segundo worker. Erro em uma varredura: registrar e tentar novamente no próximo intervalo normal; sem cascata de retries.
- UI: TS vanilla, CSS do mockup, HTTP nativo, Zod existente; um live reload REACH (poll/restart/SSE) em DEV, sem Vite/HMR alternativo. Uma API por ação; compartilhar view models e services, sem duplicar lógica nas oito telas nem criar endpoint redundante só porque exemplo antigo o cita. Preservar contratos e escopo aprovados.
- Testes: parametrizar as 49/64 combinações no evaluator/contrato, reusar suíte existente; E2E real para os fluxos permitidos representativos, três personas e fronteiras de alto risco, sem 64 scripts de browser independentes. Testar os cenários reais de recuperação acima; não inventar matriz combinatória de falhas impossíveis. Gate F5 continua exigindo cobertura de todos 64 pares e checklist original. Um relatório de evidência por fatia, não burocracia duplicada.
- Antes de adicionar mecanismo, escrever no evidence/Fn/summary.md em uma frase: requisito atual ou falha concreta que o exige, e por que o caminho existente não basta. Se não houver justificativa concreta, não implementar. Refatorar o trecho tocado para legibilidade, sem reescrever o projeto inteiro. Consultar RAG globalmente, sem collections/filtros, antes de decisões relevantes; usar evidência substantiva, não títulos. Referências desta revisão: trace 1465, Practical Python Design Patterns p.84, chunk b1dbc0e7-2997-57ba-824e-a840dbaef3cd (resolver necessidade atual, evoluir quando necessário); trace 1466, Release It!, Timeouts, chunk 35c28a63-a20c-516f-bf6b-bd37b070e731 (timeouts e evitar retries imediatos). Trace 1467 retornou títulos, não usado como evidência. Nenhuma mudança de escopo nem de visual.

## 2. Método de execução
### 2.1 Preflight (antes de F0, uma vez)
1. Ler `/scope/knowledge-base/RUNBOOK.md`, `/scope/CLAUDE.md`, `/scope/taiga-mcp/knowledge-base/RULES.md` integralmente; invocar skill `claude-tooling:git` antes de qualquer branch/commit.
2. `cd /scope/taiga/taiga-mcp && git status && git rev-parse HEAD` (esperado: `main`, limpo; SHA registrado em `evidence/F0/baseline.md`).
3. RAG global (sem filtro de coleção) antes de cada fatia: registrar a pergunta e o que mudou em `evidence/Fn/rag.md`.
### 2.2 Regras permanentes
- **Teste antes de código** (vermelho → verde) em cada slice. Rodar localmente **só** o que mexi + `tsc --noEmit` + lint; a suíte completa roda no CI (GitLab). Não bloquear o chat aguardando pipeline; a próxima fatia só começa após o gate verde ou CI equivalente autorizado pelo PO.
- Cada slice = branch GitGate `feature/<slug>`; commits pequenos e lógicos; `gitgate` só com comandos suportados (`gitgate help`). Mensagem de commit sem trailer extra além do exigido pelo ambiente.
- Tudo que o PO precisar executar sai como "André, run X" com bloco de comando no fim.
- Nada de edição no container vivo; DEV isolado (checkout + DB descartável).
### 2.3 Critério de pronto de cada fatia
(a) checklist da fatia 100% marcado, (b) testes listados verdes localmente e no CI, (c) `evidence/Fn/` preenchido, (d) paridade v1 intacta (teste oráculo verde), (e) diff revisado com `simplify` e checado contra "uma responsabilidade por função".
### 2.4 Evidência
`/scope/taiga/taiga-private/evidence/F<n>/` com: `summary.md` (SHA, comandos, resultados), saídas de teste, `rag.md`, screenshots (F4), logs. Nada de segredo.
### 2.5 Recuperação (vale para toda fatia)
- Falha de teste/CI: corrigir na mesma branch, nunca desligar gate. Branch quebrada: `gitgate switch` para a anterior; nada de reset destrutivo.
- Migração falhou: migrations são aditivas e transacionais; restaurar do dump pré-migração (`pg_dump` obrigatório antes de cada `migrate` em dado real); nunca DROP em dado vivo.
- Crash no meio de transição composta: reiniciar o residente; o reconcile lê o journal pendente, relê o Taiga e classifica (`intent` → `external_applied` → `verified` / `uncertain`); `uncertain` nunca reenvia às cegas e aparece em System/API.
- Cutover reprovado: seção §7.

## 3. Checklist mestre (marcar aqui; é o único tracker)
- [x] F0 baseline+topologia+CI  - [x] F1 oráculo+evaluator+fixture  - [ ] F2 PG+residente+API  - [ ] F3 catálogo+PEP+mirror+lifecycle  - [ ] F3b matriz v2 (lab)  - [ ] F4 UI 8 telas  - [ ] F5 release+cutover+hardening

## 4. Estrutura-alvo de arquivos (nomes finais; ajustar só com justificativa registrada)
```
src/policy/{types,catalog,legacy-seed,validator,evaluator,resolver,service,repository,scope,guards,mirror,journal,reconcile,migrate-v2}.ts
src/admin/{server,routes,auth,schemas,endpoint-catalog}.ts
src/admin-ui/{page,shell,theme,api-client,overview,projects,ownership,transitions,operations,proposals,history,system}.ts + assets/taiga-mcp.svg
db/migrations/NNNN_*.sql      scripts/{policy-migrate,policy-reconcile,policy-oracle}.ts
test/policy/**  test/oracle/**  test/e2e/**   deploy/{dev,prod}/
```
Modificados: `src/server.ts`, `src/http.ts`, `src/index.ts`, `src/client.ts` (credenciais por parâmetro), `src/workflow/{policy,transition,assignment,notify,continuation,continuation-recovery,start-rules,project-profile}.ts`, `src/workflow/tools.ts`, `src/tools/projects.ts`, `.gitlab-ci.yml`, `package.json`.

## 5. Gates comuns de CI (crescem por fatia; nunca job vazio)
validate = lint + typecheck + `node --test` ; PG integration (F2+) ; contract API (F2+) ; UI build + Playwright (F4+) ; migration test fresh+upgrade (F2+) ; public-surface (F5). Tag verde/vermelha existente (`vYYYY.MM.NNNNNN[-fail]`) preservada.

## 6. Fatias

### F0 — Baseline, topologia e CI (sem mudança de comportamento)
**Pré-condição:** autorização do PO.
**Passos**
1. Branch GitGate `feature/policy-engine-f0`.
2. Registrar baseline: SHA, `pnpm install --frozen-lockfile`, `pnpm build`, `node --test` (resultado completo), hash de `tools/list` (257 tools) → `evidence/F0/baseline.md`.
3. Medir topologia de novo (PIDs, launchers `taiga-mcp-gpt.sh`, `~/.local/bin/taiga-mcp.sh`, perfil do tunnel) e gravar. Confirmar se o `tunnel-client` encaminha bearer para HTTP local (teste com `curl` ao `/mcp` local com bearer de teste).
4. **Postgres:** exigir `DATABASE_URL` válido. Para DEV/CI: PG 16 descartável (container ou instalação local do PO). Entregar ao PO o compose/comandos ("André, run X"); verificar com `select 1` e escrita em volume local.
5. CI: confirmar `.gitlab-ci.yml` atual (test + tag) e adicionar lint/typecheck como gates; sem deploy ainda.
6. Gerar o inventário runtime de tools (nome, mutação sim/não, escopo, entidade) → `evidence/F0/tools.json` (base do catálogo F3).
**Testes:** suíte atual 100% verde, sem alteração de código de produção.
**Aceite:** baseline reproduzível; `DATABASE_URL` funcional; decisão do adapter (tunnel) registrada; CI roda gates novos.
**Commit:** `chore(policy): baseline, topology evidence and CI gates`.
**Parada/rollback:** nada a reverter (somente CI/doc); se baseline vermelha, parar e registrar.

### F1 — Oráculo legado + evaluator puro + fixture
**Passos**
1. `scripts/policy-oracle.ts` gera golden JSON do **código atual**: para cada entidade × (from,to) × papel (gpt, claude, po, anônimo, desconhecido) → `resolveTransition` + `ownerRole` + artefato + modo + override. Inclui wildcard `* → cancelled`, regra de Request, Epic/Story/Issue/Sprint e as 15 diferenças D-1..D-15 como **casos nomeados**. Golden revisado manualmente (evitar tautologia): comparar com a tabela 3A de `matrix-alignment.md`.
2. `src/policy/{types,catalog,legacy-seed,validator,evaluator}.ts`: política como dado (JSON), `evaluate(snapshot, facts)` puro. Seed legado gerado do código (TASK_PAIRS etc.) sem wildcard ambíguo.
3. Teste de paridade: evaluator(seed legado) == golden em 100% dos casos. **Sem autoridade dupla em runtime**: `policy.ts` continua sendo quem decide; o evaluator só roda em teste.
4. Fixture GPT-only (JSON) que passa no evaluator: Task `To Do → In Progress → GPT Validation → Done` só com `gpt`; Human Decision só PO; sem despacho a Claude. Fixture v2 (matriz 64) separada, **só validada**, não ativa.
5. Validador rejeita: estado inexistente, alias ambíguo, papel sem binding, artefato/guard desconhecido, duplicidade, transição impossível, ausência de saída, violação de invariante.
**Testes:** oráculo, paridade, validador (casos negativos), GPT-only fixture, v2 fixture válida.
**Aceite:** 100% paridade; D-1..D-15 documentados como casos; zero mudança de comportamento.
**Commits:** `test(policy): legacy oracle`, `feat(policy): pure evaluator and legacy seed`, `test(policy): gpt-only and v2 fixtures`.

### F2 — Postgres + residente HTTP + API mínima
**Passos**
1. `pg` + lockfile; `db/migrations/0001_policy_schema.sql` (DDL de `architecture.md` §3 + correções obrigatórias §3.0 + FKs compostas por projeto + índices em FKs), tabelas: `project_binding`, `policy_version` (append-only), `policy_review`, `policy_activation`, `mutation_journal`, `policy_audit`, `provisioning_intent`. `scripts/policy-migrate.ts` (lock de migração, idempotente).
2. `src/policy/repository.ts` com `withProjectLock` (advisory de sessão, `pg_try_advisory_lock`, unlock em finally, descarta cliente se unlock incerto), pool limitado, timeouts.
3. `src/client.ts` aceita credenciais por parâmetro; `src/http.ts` mantém **mapa ator→TaigaClient** (resolvido pelo bearer); `account-binding` valida cada conta; falta de conta de um ator = erro na subida.
4. `src/policy/service.ts` (propose/approve/reject/rollback/simulate/activate) usado por MCP e admin. Aprovação: PO-only, `expected_revision`+hash+reason, ativa em **uma transação** com audit; stale = 409; DB fora = fail-closed.
5. `src/admin/*`: API `/admin/api/v1` (tabela §10), validação Zod, erros estruturados `{code,message,problems,correlation_id}`, 401 sem token também em GET.
6. **Resolver + PEP mínimo (ajuste R6-1):** integrar `resolver` e um PEP mínimo apenas no projeto **descartável de laboratório** (binding de bootstrap + journal dos writes exercitados). A ativação real só ocorre depois de bloquear os caminhos alternativos desses writes. F3 completa o catálogo. **F2 não troca launchers produtivos**; seu rollback afeta somente o laboratório.
7. Dev runner: watcher por polling + restart + SSE (padrão REACH `dev-reload.ts`), uma opção só.
8. Unit systemd `--user` do residente (arquivo em `deploy/dev/`), com healthcheck `/health` (SHA, schema, DB).
**Testes (PG real):** migração fresh e upgrade; concorrência de lock (2 conexões, kill session); propose→approve ativa e a **próxima decisão MCP usa a revisão nova sem restart**; stale 409; 403 agente aprovando; DB down fail-closed; restart preserva política; GPT e Claude usam o mesmo `/mcp` com contas corretas (`tools/list` + uma mutação real em projeto de laboratório como cada ator).
**Aceite:** residente estável; API cobre propose/approve/history; nenhum writer stdio ativo em paralelo.
**Commits:** `feat(db): policy schema and migrations`, `feat(policy): repository, lock and service`, `feat(http): per-actor clients in resident process`, `feat(admin): api v1`.
**Rollback:** desligar apenas o residente DEV e descartar/restaurar o laboratório. Launchers produtivos permanecem intactos.

### F3 — Catálogo, PEP, mirror e lifecycle (GPT-only live)
**F3.1 Mirror:** `src/policy/mirror.ts`: lê todas as páginas de `/projects`, metadata (roles, status, defaults, custom defs), identidade UUID (read-only, reaproveitando o scan de `identity.ts`). Upsert por **instância+project ID** (nunca slug). Projeto elegível ganha binding + versão 1 = seed legado + activation de bootstrap (idempotente, sob lock). Sync não sobrescreve política ativa nem escreve cards. Drift bloqueia writes governados do projeto e mostra proposta de reparo. Criação de projeto (`tools/projects.ts`): intent no journal antes do POST, readback, seed do mirror na mesma operação; DB fora ⇒ rejeita antes do POST; POST incerto ⇒ reconcilia, nunca duplica.
**F3.2 Catálogo + PEP:** `src/policy/catalog.ts` gerado de `evidence/F0/tools.json` e conferido bidirecionalmente com o registro runtime e os mutadores internos. Cada uma das tools tem `operation`, `scope resolver`, `rule` ou **fail-closed**. PEP central em `governance.ts`/`server.ts`: avalia → guards obrigatórios → executa. Teste: catálogo == `tools/list` exato; tool sem regra falha na subida de projeto gerenciado; bypass por bulk/field/import/reorder/alias bloqueado; negado = zero side effects.
**F3.3 Lifecycle:** `notify.ts` ganha contrato `{event, recipient}`; `continuation.ts:78` deixa de usar `other(actor)`; recuperação usa a política pinada. Mesmo ator = sem despacho Bridge, mas `TASK_DONE` local permanece.
**F3.4 Assinatura de merge (M-3):** o residente guarda a chave Ed25519 (nunca em env de ator). Fluxo preservado: valida `merge_context` + identidade autorizada + alvo/SHA **antes** do write; assina **depois** de Done provado e relido; falha de assinatura nunca desfaz o Done. Policy define quem pode ser Validator; assinatura só em aprovação tipada. Branch ativa sem `merge_context` ⇒ obrigação pendente recuperável. **Recuperação pós-Done (ajuste R6-5):** o contexto/obrigação de merge é persistido **antes** do write; a linha de journal só fecha de fato quando o envelope assinado está recuperável e a entrega é idempotente (fase de efeito `pending_effect` entre `verified` e `complete`). Crash entre verify e assinatura/entrega ⇒ o reconcile recupera o envelope já persistido ou assina uma única autorização a partir do contexto persistido e do Done relido, com identidade estável da operação; reentrega o mesmo envelope; nunca assina por mera observação de Done. Teste de crash nesse intervalo obrigatório.
**F3.5 GPT-only live em laboratório:** projeto `TAIGA POLICY LAB` criado via MCP; proposta GPT-only pela API, aprovada pelo PO; GPT executa Task completa (plan → In Progress → handoff → GPT Validation → approval → Done) sem despacho a Claude; Human Decision só PO; segundo projeto (v1 padrão) permanece idêntico (sem vazamento).
**F3b — Matriz v2 em laboratório** (após F3.5): `src/policy/migrate-v2.ts`: migrador versionado e retomável (PATCH do status existente, nunca criar+deletar; `GPT Validation`→`Validation`, novo `External Blocked`, campos `Executor`/`Validator` por Task, aliases explícitos, dry-run), writes congelados até readback + ativação; **nunca** cair em legacy no meio. Implementar: owner por campo (lido sob lock, nunca cacheado por status), Request com resposta+resume numa só versão (B-2), External Blocked (B-3), Human Decision simplificado (M-5; tool antiga desativada só em v2), D-5/D-6 negados, reconcile M-4 (`src/policy/reconcile.ts`: varredura paginada por projeto v2; compara `version` com o espelho; só corrige `assigned_to`; chave de evento durável; baseline na 1ª execução; não emite TASK_DONE por move do PO), Done manual do PO sem autorização de merge (B-4).
**Critérios obrigatórios de F3b (ajuste R6-3):** os itens B-1..B-6 de `debate-r5-claude.md` §2 são aceite, com seus testes negativos. Além disso: (a) o migrador preenche `Executor`/`Validator` em **todas** as Tasks abertas (default do projeto, sem inventar valores) e recusa ativar enquanto houver Task sem persona válida; (b) alteração de persona de Task em fase ativa é recusada para agentes (PO soberano: inconsistência reportada, writes recusados até resolver); (c) a checagem de ativação (A-6) inclui `External Blocked`, `Validation` e obrigações v2 pendentes; (d) recuperação explícita de Done manual (reabrir → Validation) e de abandon em Cancelled com branch ativa; (e) o reconcile varre **todos** os projetos v2 (Tasks abertas inclusive sem Sprint, terminais de Sprint aberta e terminais cuja `version` mudou), nunca só Sprint aberta.
**Testes F3:** mirror com fixtures (vazio/cheio/ausente/UUID duplicado/legado/renomeado/inacessível), idempotência, `TASK_DONE` e assinatura E2E (3 combinações Executor/Validator válidas; falha de assinatura antes/depois do PATCH; replay), recuperação após restart, journal sob falha (timeout antes/depois do POST/PATCH, crash após comentário, após status), dois cards no mesmo status com owners distintos, corrida campo/PATCH, assignee já correto, duas mudanças entre polls, manual fora de Sprint, dois Sprints/dois starts concorrentes. Oráculo v1 permanece verde.
**Aceite:** 257 tools classificadas; v1 paritária; GPT-only fecha o fluxo sem Claude; v2 só em laboratório.
**Commits (mínimo):** `feat(policy): mirror`, `feat(policy): operation catalog and PEP`, `feat(workflow): explicit notification recipient`, `feat(policy): central merge signing`, `feat(policy): gpt-only lab proof`, `feat(policy): v2 matrix migrator`, `feat(policy): v2 reconcile`.
**Rollback:** reverter política do laboratório por nova proposta; se a v2 falhar a meio, o migrador retoma do journal (nunca ativa parcial).

### F4 — UI das 8 telas (visual idêntico ao mockup)
**Passos:** shell + CSS por tokens (ver §9), uma tela por vez, cada uma já com backend real: Overview, Projects, Ownership, Transitions, Operations, Proposals, History, System/API. Roles & Bindings dentro de Ownership/Operations (sem nova navegação). Browser só renderiza o view-model do servidor (cores de status da API Taiga, não tabela JS). Segurança: `textContent`/`createElement`, nunca `innerHTML` com dado externo; sem `onclick` inline; CSP.
**Testes:** Playwright (Chromium pinado) 8 telas em 1440×900, 900px e mobile contra fixture do mockup (mascarar só timestamps); teclado, foco, accordion, contraste AA, estados loading/error/empty/stale; XSS com nomes maliciosos do Taiga; admin não acessível pelo túnel. PO propõe e aprova GPT-only real pelo browser; refresh persiste. Hot reload: alterar CSS/TS e a tela atualiza sem F5. Baseline de screenshots revisada pelo PO; **nunca** atualização automática de snapshot.
**Aceite:** nenhuma tela com botão falso; todas as 8 consomem API real; diff visual dentro da tolerância revisada.
**Commits:** um por tela + `feat(ui): shell and tokens`, `test(ui): visual and e2e`.

### F5 — Release, ensaio, cutover e hardening
1. CI/CD completo: build imutável (imagem/digest/manifest), release só com tag verde, candidate DEV, produção só após autorização do PO, `resource_group`, deploy não-manual após a 1ª liberação. Publicação GitHub **desarmada** até: scan do histórico inteiro, README público sem dados privados, licença MIT/UPSTREAM preservada, autorização do PO.
2. Docs: reescrever README/docs upstream obsoletos (atribuição preservada); atualizar `knowledge-base/RULES.md`, `CLAUDE.md`, Bridge docs e profile.
3. Ensaio (rehearsal) em instância/projeto descartável: backup+restore reais, reinício, rollback, mirror de todos os projetos elegíveis em dry-run, paridade, GPT-only e v1 simultâneos.
4. **Hardening D3:** usuário Unix próprio para o residente, segredos 600 ("André, run X").
5. Cutover (§7).
**Gate F5 v2 (ajuste R6-4):** exige E2E dos 64 pares + checklist original da matriz + as três personas (Executor/Validator combinações válidas) em laboratório; rollback v2 só se compatível com metadata/artefatos, senão fica **bloqueado** até existir migração reversa segura e testada. **Nunca iniciar binário legado sobre vocabulário v2.**
**Aceite final (DoD):** projetos existentes idênticos por paridade; todos os elegíveis espelhados (0 drift inexplicado); novos projetos provisionados automaticamente; catálogo completo; API/UI funcionais com aprovação real e efeito imediato; E2E v1, GPT-only e v2 (64 pares); backup/rollback validados; CI verde; sem política duplicada ou default escondido; túnel estável; docs e diagramas atualizados.

## 7. Cutover e rollback
**Pré-voo:** SHA atual, launchers e perfil do tunnel, Tasks/Sprints ativos, continuations e autorizações pendentes, backup do banco do Taiga e do estado do MCP, snapshot do PG após bootstrap; restauração testada.
**Congelar:** janela combinada com o PO; parar agentes/roteamento; drenar em voo; pausar Bridge; manter a API do Taiga viva para reconciliar.
**Implantar:** imagem verde → migrar → seed → dry-run de paridade → reconcile → health → autenticar os 3 atores → `tools/list` → leitura canário → escrita só no laboratório → PO aprova GPT-only no lab → reabrir projetos padrão → religar túnel/Bridge.
**Abortar se:** projeto ausente, deriva de papel, UUID mudou, falha de paridade, despacho inesperado a Claude, mutação não autorizada, assinatura divergente, continuation corrompida, DB não pronto, mutação parcial sem classificação.
**Rollback:** parar escritas, exportar audit+journal, reconciliar o que persistiu, restaurar imagem/config/túnel anteriores. **Se alguma política GPT-only ou v2 já foi usada em cards reais** (v2: ver Gate F5 v2, rollback bloqueado sem migração reversa), primeiro reverter a política e resolver pendências/ownership (o runtime antigo não impõe a nova política); nunca baixar versão às cegas. Não restaurar o banco inteiro do Taiga só para desfazer política. Histórico preservado.

## 8. Matriz de testes obrigatória (resumo)
Oráculo legado completo; autorização (identidade falsa, spoof de projeto, bulk/campo/import/reorder, negado ⇒ zero side effects); lifecycle completo (ordem, Task ativa por Sprint, blocked, request, human decision, closure, Story/Sprint); persistência e ativação (fresh/upgrade, restart, lock, stale, rollback como novo evento, DB fora fail-closed); fault injection (timeout/crash em cada ponto, sem retry cego, nunca apagar artefato); Bridge/Git (formato original, recipient explícito, assinatura, replay, sem merge em Cancelled, GitGate real); UI; deploy; desempenho comparado ao baseline (medido, sem SLO inventado).

## 9. Contrato de UI aprovado (normativo; copiado do pacote v0.3)
Fonte normativa: ui/mockups.html, aprovado pelo PO. **Não redesenhar.** Manter HTML visual, CSS, logo, gradiente, grid, sidebar, tabs, cards, hierarquia, labels e tabelas. Transferir CSS para módulo/arquivo com tokens únicos; sem substituir pelo visual REACH literal. O REACH é referência de estrutura e live reload. Não acrescentar constelação ou mudar paleta, apesar da proposta inicial de fundo de rede. Tema dark é obrigatório; light só se PO pedir depois. 
Paleta extraída do CSS original, não cores inventadas:
| Token | Hex | Uso |
|---|---|---|
| bg | #0b1420 | fundo |
| panel | #111f2d | cartões |
| line | #263a49 | bordas |
| muted | #93a8b9 | secundário |
| text | #e5edf3 | principal |
| accent | #32bfa3 | teal, foco e destaque |
| green | #64d6ac | allow |
| amber | #e8b86b | alerta, locked |
| red | #ef8690 | erro |
| glow | #163a43 | gradiente radial |
| sidebar | #0b1623dc | painel lateral translúcido |
| nav-active | #143c3b | seleção |
| nav-active-text | #b6f5e6 | texto seleção |
| nav-hover | #17313d | hover |
| button | #197f6c | ação primária |
| button-border | #259b85 | borda primária |
| table-header | #142433 | tabela |
| input | #132333 | controles |
| details | #101e2b | accordion |
| changed | #203b38 | célula alterada |
| changed-text | #b9f2df | destaque diff |
| link | #76ddc7 | links |
| deny | #8395a5 | deny |
| before | #f0acac | diff anterior |
| after | #83dec0 | diff posterior |
| brand-fill | #163e3d | hexágono |
| brand-node | #8bf0d4 | nós |
Status colors do mockup: To Do #8b9dc3, In Progress #f5a623, Request #2d9cdb, GPT Validation #8e6ccf, Human Decision #d0021b, Done #27ae60, Cancelled #95a5a6. Em produção usar cor real do Taiga fornecida pela API, não tabela JS hardcoded. 
Font system-ui,sans-serif 15px/1.45; header 26px; card title 16px; stat 32px; tabela 13px; muted 13px; sidebar 238px; main padding 30px; header 87px; cards gap 13px; card radius 10px, accordion 7px, input 6px; mobile breakpoint 900px (sidebar 180px, grid 2 cols, rowgrid 1 col). Preservar layout visual desktop, corrigir overflow e acessibilidade sem alterar desenho aprovado. Nenhuma dependência de CDN.
Logo SVG original (43x43 com viewBox 48): 
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-label="Taiga MCP">
  <path d="M24 3 43 13v22L24 45 5 35V13Z" fill="#163e3d" stroke="#32bfa3" stroke-width="2"/>
  <path d="M15 16 33 16 24 33 15 16M24 16V33" stroke="#8bf0d4" stroke-width="2" fill="none"/>
  <g fill="#8bf0d4"><circle cx="15" cy="16" r="3"/><circle cx="33" cy="16" r="3"/><circle cx="24" cy="33" r="3"/></g>
</svg>
```
Nav iconografia aprovada: ◈ Overview, ▤ Projects, ◉ Ownership, ⇄ Transitions, ☷ Operations, ◇ Proposals, ◷ History, ⚙ System/API; chevron ›, ✓ Allow, — Deny, ◇ Override, cadeado Locked. Reproduzir formas, se converter glyphs para SVG local, manter aparência e accessible name; sem pacote iconográfico obrigatório. Logo único referenciado em header/favicon/README. Controles reais usam texto e ícone, nunca só cor. 
Visual acceptance: copiar mockup para fixture de design, renderizar todas 8 telas em browser Chromium pinado (desktop 1440x900 ou viewport original verificado; também 900px e mobile), comparar screenshots da UI real com fixture API representando mesmos dados, mascarar apenas timestamps/labels demo. Baseline revisada pelo PO; não aceitar snapshot update automático. Testar keyboard, foco, accordion, semântica HTML, contraste WCAG AA, loading/error/empty/stale, feedback via aria-live. Se contraste exigir mudança pequena, informar PO com antes/depois; não alterar mockup agora. 
Dados demonstrativos atuais são fixtures, não política default garantida. Ex.: contagem de cards, RAG/REACH, cores, propostas, statuses e owners apenas ilustração; API real retorna valores. API server gera view model: projects list, matrix rows, action permissions, disabledReason, diff, review status, counts, health. Browser não replica evaluator. View faz apenas interação/presentation: expand/collapse, navegação, filtro de apresentação de registros já permitidos, layout, input, render e request. Sem cache de decisão, regras de negócio, cálculo de elegibilidade ou side effects locais. 
**Live reload:** reutilizar somente o padrão REACH dev-reload.ts:1–39: polling em network share, restart controlado do processo DEV e SSE com instance id, browser reload ao reconectar. Compilar TS com tsc existente. Não adicionar Vite, HMR ou fallback. Produção serve assets compilados, sem watcher/SSE DEV. Testar alteração CSS/TS real e atualização sem F5; avisar antes de descartar draft não salvo.


## 10. API v1 e MCP (normativo)
Prefixo privado /admin/api/v1. JSON, content-type explícito, no-store, erros estruturados {code,message,problems,correlation_id}; 401 identidade inválida, 403 sem autorização, 404 escopo inexistente/inacessível, 409 versão/conflito/drift/in-flight, 422 política inválida, 503 dependência indisponível. Limite de corpo e timeout configuráveis. Paginação de histórico e projetos. Validar tipos com Zod e queries parametrizadas. Nunca retornar secrets ou payload integral de artefatos.
| Método/rota | Ação | Principal |
|---|---|---|
| GET /health | build, schema, db, Taiga, readiness/mirror, modo manutenção | admin autenticado ou health privado mínimo |
| GET /catalog | operações, entidades, guards, status semântico, schemas | PO/agente autorizado |
| GET /projects | lista, filtro managed/legacy/drift, policy revision | PO/agente autorizado |
| GET /projects/{id} | metadados, estado de espelhamento, política ativa | idem |
| GET /projects/{id}/policies | histórico imutável, revisão, hash, autor | idem |
| GET /projects/{id}/policies/{revision} | documento e matriz expandida | idem |
| POST /projects/{id}/simulate | decisão/effects/guards com fatos fornecidos claramente simulados; nenhum write | idem |
| POST /projects/{id}/proposals | base revision, mudanças estruturadas, motivo, candidate hash | PO/agente autorizado |
| GET /projects/{id}/proposals | pendências e diff semântico | idem |
| POST /projects/{id}/proposals/{id}/approve | aprovar e ativar atomicamente se base ainda atual e sem operações conflitantes; hash e reason obrigatórios | PO |
| POST /projects/{id}/proposals/{id}/reject | rejeitar, motivo | PO |
| POST /projects/{id}/rollback | criar proposta cujo conteúdo copia versão antiga; aprovação explícita (pode ser endpoint único para PO com confirmação) | PO |
| POST /projects/{id}/reconcile | dry run ou aplicar espelhamento; nunca sobrescrever política | PO |
| POST /reconcile | inventário geral; dry run padrão | PO |
| GET /projects/{id}/audit | decisões, resultado, actor, versão, filtro | PO; agentes somente escopo autorizado |
| GET /projects/{id}/export | política/metadata sem segredos | PO |
| POST /projects/{id}/import | criar proposta, não ativar | PO/agente autorizado |
| GET /endpoints | catálogo e health real | PO |
MCP: taiga_policy_projects_list, taiga_policy_get, taiga_policy_catalog, taiga_policy_simulate, taiga_policy_propose, taiga_policy_proposals_list, taiga_policy_reconcile_preview. Aprovação via UI ou ferramenta PO autenticada se explicitamente necessária; não oferecer approve a GPT/Claude. Ferramenta de admin nunca permite actor/role arbitrário. Manter taiga_task_workflow_state com campos owner_role, policy_revision, allowed/denied e artefato real; adicionar generic taiga_policy_actions(entity,id) para outros tipos. Tool descriptions devem direcionar à descoberta. Validar compatibilidade de schemas existentes. API e MCP chamam mesma camada service.

Read models dos 8 telas: Overview GET /overview; Projects GET /projects; Ownership GET /projects/{id}/ownership; Transitions GET /projects/{id}/matrix; Operations GET /projects/{id}/operations; Proposals GET/POST /projects/{id}/proposals; History GET /projects/{id}/policies e /audit; System GET /health, /endpoints, POST /reconcile. Todos projeções do mesmo evaluator/repositório; o browser nunca decide.
