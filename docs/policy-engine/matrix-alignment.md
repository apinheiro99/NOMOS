# Alinhamento: docs do taiga-mcp + Matriz de 64 transições x Policy Engine
24/11/2026, Claude. Li INTEIRO: `taiga-mcp/docs/` (README, getting-started, agent-architecture, advanced-workflows, examples) e `Taiga MCP - Workflow Exhaustive Transition Matrix.md` (508 linhas), mais `UPSTREAM.md`. Verifiquei no código: **a matriz NÃO está implementada** (`External Blocked`, `Executor` e `Validator` não existem em `src/`; `project-profile.ts` ainda cria `GPT Validation`; o único commit do arquivo é `d524d5e docs(workflow): add exhaustive workflow transition matrix`). Nada foi alterado.

## 1. O que cada doc é
| Doc | O que é | Veredito |
|---|---|---|
| Matriz 64 (Nov 11, DRAFT) | Contrato novo do workflow de Task: 8 estados, `Executor`/`Validator` por Task, assignee derivado do estado, PO soberano, Bridge só GPT↔Claude. | **Muito útil.** É o seed natural da política v2. |
| agent-architecture, advanced-workflows, examples, getting-started | Documentação do fork upstream (illodev, MIT): "~170 tools", status mudado por `taiga_tasks_update`, sprint fechada por `milestones_update closed:true`, instalação por `npx @illodev/taiga-mcp`. | **Defasada e incompatível** com o governado (hoje são 257 tools; mudar status por `tasks_update` e fechar Sprint assim são recusados). Só serve de agrupamento por família. |

## 2. O que ajuda (aproveitar agora)
- **A matriz já é a especificação de dados do motor.** Cada linha tem origem, destino, quem move, assignee de destino, notificação e condição. Isso mapeia 1:1 para `allow`, `owner`, `effect` e `guards` do formato da política (architecture.md §3.1). A v2 da política nasce dela, em vez de ser inventada.
- **GPT-only já está dentro da matriz.** A regra 7 diz `Executor=Claude ⇒ Validator=GPT`, `Executor=GPT ⇒ Validator=GPT|Claude`, `Claude/Claude` inválido. A linha `In Progress → Request` só vale se Executor≠GPT (a mesma "Request route: denied (self-request)" que o mockup mostra). Ou seja, GPT-only é "o conjunto permitido de Executor é só GPT", e não um ramo de código.
- **Princípio central** ("nenhum estado necessário fica na memória do MCP") coincide com o `mutate` atual e com o journal só-como-evidência do A-7.
- **Checklist adversarial (34 itens)** vira a base do oráculo de testes da F1 e dos testes da v2.
- **Agrupamento por família** do `agent-architecture.md` (Stories, Tasks, Issues, Epics, Sprints, Wiki, Team, Project Setup, Reporter) é quase igual às famílias da tela Operations do mockup. Reaproveitar os nomes.

## 3. Incompatibilidades reais (formato pedido pela própria matriz: cenário, regra, o que quebra, correção mínima)

**M-1. Vocabulário diferente do baseline que o motor tem que preservar.**
Cenário: o motor semeia a v1 com o legado (7 estados, `GPT Validation`, 49 pares) e a matriz exige 8 estados com `Validation` e `External Blocked`.
Regra: matriz §6 itens 1-2; architecture.md §1 ("DRAFT de 64 pares... não implementar por acidente") diz o contrário do cabeçalho da matriz ("fonte de verdade").
O que quebra: duas autoridades para o mesmo workflow.
Correção mínima: **a v1 do motor = legado (paridade); a matriz é a v2, aprovada pelo PO pela própria UI do motor.** E as chaves da política passam a ser **semânticas** (`in_progress`, `validation`, `external_blocked`…) com o nome de exibição vindo do Taiga. O rename `GPT Validation → Validation` vira dado do projeto, não reescrita de regra.

**M-2. Dono de estado "por Task" x "por política de projeto".**
Cenário: a matriz faz `In Progress → Executor` e `Validation → Validator`, lidos de custom fields da Task. O formato do motor tem `owner` fixo por estado.
O que quebra: o evaluator não conseguiria expressar o dono sem um fato extra.
Correção mínima: `owner` aceita um papel **ou** uma referência a campo (`{ field: "Executor" }`), e o servidor lê o campo como fato. A política do projeto passa a guardar só `executorAllowed`, `validatorAllowed` e `defaultExecutor/Validator`. GPT-only = `executorAllowed:[gpt]`, `defaultExecutor:gpt`. Isso substitui a flag "por projeto" por algo mais fino e já alinhado à matriz.

**M-3. Quem assina o merge quando o Validator é o Claude.**
Cenário: Executor=GPT, Validator=Claude; Claude faz `Validation → Done` (a matriz permite).
Regra: matriz linha `Validation → Done`; `.env.example` restringe a chave Ed25519 ao processo do GPT.
O que quebra: Done persistido sem autorização de merge assinada (`merge_authorization_error`), e o Executor não consegue fazer o `task-done`.
Correção mínima: o **residente HTTP (A-9)** guarda a chave e assina para qualquer ator que a política autorizar naquela transição, sem nunca entregar a chave a um agente. Alternativa mais fraca: `Validation → Done` só para GPT/PO na v2.

**M-4. "Quando o MCP observar o movimento manual do PO" — não existe observador.**
Cenário: o PO arrasta um card de `Human Decision` para `In Progress` na UI do Taiga. A matriz manda reconciliar o assignee pelo destino e emitir handoff ao Claude.
Regra: matriz §2 último parágrafo, §7 itens 7-8, checklist 21-22.
O que quebra: hoje o MCP só age quando um agente o chama; com 3 processos stdio ninguém observa nada, e o card fica parado com o PO como assignee.
Correção mínima: o residente (A-9) roda o **reconcile periódico que o motor já prevê** (§6 item 5, intervalo configurável) sobre Tasks governadas de Sprints abertas: corrige `assigned_to` e emite o handoff uma única vez (chave de evento idempotente, no journal). Sem webhook novo na v1.

**M-5. Human Decision: a matriz simplifica o que o código e o CLAUDE.md têm hoje.**
Cenário: hoje `taiga_human_decision_resolve` (GPT/PO) registra a decisão e o PO move, e o retorno é sempre `GPT Validation`. A matriz diz que o PO decide e move para onde quiser, sem resolução registrada e sem variável de retorno.
O que quebra: `DECISION_RESUME_STATUS`, o template de resolução, as regras do CLAUDE.md/RULES e a mensagem do Bridge divergem.
Correção mínima: é uma mudança da v2 (a matriz é de 11/11, depois do fluxo de 02/11), então entra junto da migração de profile, com RULES/templates/CLAUDE.md no mesmo release, como a própria matriz exige (§6 item 9). Não mexer antes.

**M-6. Docs do upstream no release público.**
Cenário: o README público e a pasta `docs/` ainda ensinam `npx @illodev/taiga-mcp` e "~170 tools".
O que quebra: instruções que não funcionam e contagem errada; a atribuição MIT precisa continuar.
Correção mínima: reescrever `docs/` no gate de release (F5), mantendo `UPSTREAM.md`/licença; contagem e catálogo gerados de `tools/list`.

## 3A. Comparação medida com o código real (`dist/workflow/policy.js` e `notify.ts`, HEAD `03f41fe`)
Método: executei `resolveTransition("task", papel, origem, destino)` para os 7x7 pares x 3 papéis, e li `ownerRole` e `noticeForTransition`. Só compara os 7 estados que existem hoje; `External Blocked` não existe no código (todas as 15 linhas dele ficam sem implementação). Override do PO (`O`) é ignorado na tabela, igual à matriz.

**Iguais à matriz (14 pares):** To Do→In Progress (GPT), To Do→Human Decision (GPT), To Do→Cancelled (GPT), In Progress→To Do (Claude/GPT), In Progress→Request (só Claude), In Progress→Cancelled (GPT), Request→Human Decision (GPT), Validation→To Do/Human Decision/Cancelled (GPT), Validation→In Progress (GPT), Validation→Done (GPT), e as diagonais e proibições (To Do→Done, In Progress→Done, etc. exigem Validation).

**Diferentes (a matriz manda X, o código faz Y):**
| # | Par | Matriz | Código hoje | Efeito |
|---|---|---|---|---|
| D-1 | In Progress → Validation | Executor (GPT ou Claude) | **só Claude** | GPT como Executor não consegue entregar. É o bloqueio do GPT-only. |
| D-2 | In Progress → Human Decision | Executor ou GPT | **só Claude** | GPT executando não consegue escalar. |
| D-3 | Request → In Progress | **GPT** responde e move | **só Claude** (`request_resume`) | Quem retoma a execução é o oposto do desenho da matriz. |
| D-4 | Request → Cancelled | **GPT** | **só PO** | GPT não consegue cancelar uma Task em Request. |
| D-5 | Human Decision → Cancelled | "Não automático" (só PO) | **GPT pode** (curinga `* → cancelled`) | O código é mais permissivo. |
| D-6 | Done → Cancelled | "Não automático" (só PO) | **GPT pode** (curinga) | Idem. Permite cancelar Task já concluída. |
| D-7 | Validation → In Progress / Done | **Validator** (pode ser Claude) | **só GPT/PO** | Claude como Validator não existe no código. |
| D-8 | Dono de In Progress | `Executor` (campo da Task) | **fixo `claude`** (`ownerRole`) | Sem campo por Task. |
| D-9 | Dono de Validation | `Validator` (campo da Task) | **fixo `gpt`** | Idem. |
| D-10 | Assignee de Done/Cancelled | **GPT** | **ninguém** ("Done/Cancelled não são projetados") | A matriz atribui ao GPT. |
| D-11 | Campos `Executor`/`Validator`, regra `Claude/Claude` inválido | obrigatórios antes de iniciar | **não existem** | Nada valida isso. |
| D-12 | Notificação | silêncio GPT→GPT e Claude→Claude; Bridge para o novo assignee | `noticeForTransition` só conhece o **ator** (`from`), nunca o destinatário; Cancelar e `In Progress → To Do` **não emitem** nada | A matriz exige Bridge ao Claude no cancelamento e no bloqueio interno; hoje ficam mudos. A regra "mesma identidade = silêncio" não é implementável sem destinatário. |
| D-13 | Human Decision | PO decide e move, sem resolução registrada | `taiga_human_decision_resolve` + retorno fixo a `GPT Validation` | Fluxo antigo (02/11) x simplificado (11/11). |
| D-14 | Movimento manual do PO | MCP reconcilia assignee e emite handoff | **nenhum** reconcile (só `taiga_assignees_backfill` sob demanda por Sprint) | Card parado após o PO arrastar. |
| D-15 | Nome `GPT Validation` | `Validation` (rename) | `GPT Validation` em `project-profile.ts`, templates, RULES, mockup | Rename atravessa tudo. |
| D-16 | Curinga `* → Cancelled` | só estados reais da matriz | o curinga legado também casa um status que o workflow não conhece (`limbo`) e o GPT/PO cancelam | **Divergência intencional do seed:** o seed só tem estados reais, então `task limbo cancelled` (gpt, po) é negado. Documentada e coberta por `policy-parity.test.ts` (D-16); nada além dessas duas entradas pode divergir. |

**Leitura honesta:** a matriz **não é uma documentação do que existe**, e sim um contrato novo que difere do código em 15 pontos, e 7 deles (D-1..D-4, D-7, D-12, D-14) são exatamente os que o GPT-only exige que existam. Ou seja, **GPT-only não é "uma flag em cima do código atual": é implementar a parte da matriz que ainda falta**, com `Executor/Validator` como o mecanismo. Isso reforça M-2 e muda a recomendação: o motor deve nascer já com `owner` por campo e com `destinatário` explícito na notificação (D-12), e não só com o seed legado.

**Os 2 pontos em que o código é mais permissivo que a matriz (D-5, D-6)** são uma decisão de paridade: a v1 (legado) preserva e documenta como achado de segurança (conforme implementation.md §0.4 item 7), e a v2 (matriz) fecha. Não endurecer em silêncio.

## 4. O que já dá para deixar alinhado agora (só decisão, sem código)
1. Política com **chaves semânticas** de estado (M-1) e **owner por papel ou por campo** (M-2) já no schema v1 do motor, mesmo que a v1 só use papéis fixos. Evita migração de schema depois.
2. A F1 caracteriza o **legado (49 pares)** e **também** carrega a matriz como segundo oráculo de teste "alvo" (64 pares + checklist), sem ativá-la.
3. O residente HTTP (A-9) já nasce com **assinatura de merge centralizada** (M-3) e **loop de reconcile** (M-4) previstos na F2/F3, com o loop desligado até a v2.
4. A migração de profile (rename, `External Blocked`, `Executor`/`Validator`) é uma **Story separada**, depois de a paridade da v1 estar verde. Não entra no caminho crítico do GPT-only.
5. Ordem: F0..F5 do R2 continua; a **v2 (matriz)** entra entre F3 e F4, e a UI da F4 já mostra os campos `Executor/Validator` como dado do servidor.

## 5. Para o GPT confirmar (uma rodada, sem reabrir o resto)
- Aceita M-1/M-2 (chaves semânticas, owner papel-ou-campo, política com `executorAllowed`)?
- M-3: assinatura centralizada no residente ou `Validation → Done` só GPT/PO na v2?
- M-4: aceita o reconcile periódico como o "observar" da matriz?
- M-5: confirma que a simplificação do Human Decision da matriz prevalece sobre o fluxo de 02/11, e que entra só na v2?
