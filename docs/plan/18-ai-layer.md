## 18. Camada de IA (IA-first)

> Fonte de verdade: STANBASE.md §19 (Camada de IA — capacidades e implementação), §1.1 (pilar "IA-first"), §11.3/§11.1 (segmentos por IA, qualificação no CRM), §17 (copy assistida na voz da marca), §10.2 (alertas/ações sugeridas no dashboard), §23 (copilot via MCP), §6.1/§6.3 (stack: Claude, pgvector, pgmq, pg_cron, Edge Functions), §26 (LGPD/DPA com sub-processadores LLM). Este plano detalha o domínio para execução.
>
> **Decisões de plataforma já tomadas e imutáveis neste domínio:** provedor LLM = **Claude** (modelo padrão `claude-opus-4-8`; `claude-sonnet-4-6` e `claude-haiku-4-5` como tiers de custo); a IA **sugere/rascunha**, ações sensíveis exigem **confirmação humana**; toda saída de IA é **auditável** e ligada ao registro do membro; embeddings via **pgvector**.
>
> **Princípio reitor (do doc §19):** *"A IA não é um módulo isolado — permeia o produto."* Tecnicamente isso vira uma **camada de serviços** (Edge Functions + jobs + tabelas próprias) que outros domínios (CRM, comunicação, tiers-perks, dashboard) **consomem**. O CRM (`08-crm.md`) já declarou os contratos que esta camada **possui e preenche**: `member_metrics.churn_score`, `member_metrics.ai_labels`, a tabela `ai_outputs`, e os jobs `ai_churn_job` / `ai_segment_from_nl` / `ai_qualify`. Este plano é o **dono canônico** desses contratos.

---

### 1. Como funciona

#### 1.1 Arquitetura conceitual — três planos

A camada de IA se divide em três planos distintos, com SLAs e guardrails diferentes:

1. **Plano analítico (batch/assíncrono)** — jobs agendados que recalculam scores e labels sobre a base inteira: churn score, segmentação automática (superfã/recém-chegado/em risco/dormindo), embeddings de membros, RFM-assistido. **Não bloqueia UI**, roda em `pgmq`/`pg_cron`, escreve em `member_metrics`/`member_embeddings`/`segments`. É **determinístico no agendamento**, idempotente, e a maior parte **nem chama o LLM** (scores de churn são um modelo estatístico; o LLM só entra para *explicar* e *recomendar ação*).
2. **Plano generativo (assíncrono sob demanda)** — o admin pede um rascunho (copy de campanha, próximo perk, perguntas de qualificação). Gera-se um **draft** que vive em `ai_outputs` com status `draft`, **nunca** é enviado/aplicado sozinho. Latência tolerável (segundos), streaming opcional.
3. **Plano agêntico (copilot)** — linguagem natural → consulta + ação. O LLM tem acesso a **tools** (MCP/function-calling) que mapeiam para a API `/v1` com o **mesmo escopo de org e permissões** do usuário. Leitura executa direto; **escrita/ação sensível** gera uma **proposta de ação** que exige confirmação humana antes de efetivar.

> **Regra de ouro de segredos (fundação §1.1):** toda chamada ao LLM passa por **Edge Function** (a `ANTHROPIC_API_KEY` é secret do projeto, **nunca** chega ao browser). O front nunca fala com a Anthropic direto. Mesmo o copilot do admin manda a pergunta para uma Edge Function que orquestra o loop de tools.

#### 1.2 Máquina de estados — saída de IA (`ai_outputs`)

Toda produção do LLM (e propostas de ação do copilot) é um registro em `ai_outputs` com um ciclo de vida explícito. Isso é o que torna a IA **auditável** e o que materializa o guardrail "sugere/rascunha; ação sensível exige confirmação".

```
                      generate
                         │
                         ▼
        ┌──────────► generating ──error──► failed (terminal, auditável)
        │                │
        │           completed (draft pronto)
        │                │
   regenerate            ├── edit (humano edita o texto) ──► edited
        │                │
        └────────────────┤
                         ▼
            ┌── approved ──apply──► applied (efetivado: copy enviada / perk concedido / segmento salvo / ação executada)
            │
            └── discarded (terminal — humano descartou)
```

- `generating` → registro criado, request enviado ao Claude (pode ser síncrono curto ou job pgmq).
- `completed` → resposta recebida, parseada, validada (schema/guardrails). É um **draft**; nada acontece no mundo real.
- `edited` → o humano alterou o conteúdo no editor antes de aprovar. Guardamos o `original` e o `edited` (para medir taxa de edição — sinal de qualidade da voz da marca).
- `approved` → humano aprovou; pronto para aplicar.
- `applied` → a ação real aconteceu **por outro domínio** (comunicação enviou a campanha; tiers-perks concedeu o perk; CRM salvou o segmento). `ai_outputs` registra o link para o objeto criado (`applied_ref`).
- `discarded`/`failed` → terminais.

**Regra dura:** nenhuma transição `completed → applied` é automática. Sempre passa por um ator humano (`approved_by`) **exceto** leituras puras do copilot (que não criam efeito colateral). Isso vale inclusive para o MCP (§23 do doc: "ações de escrita/financeiras podem exigir confirmação").

#### 1.3 Capacidade 1 — Segmentação automática (superfã / recém-chegado / em risco / dormindo)

**Definição dos labels** (calculados pelo `ai_segment_job`, não pelo LLM — é classificação determinística sobre `member_metrics`, com o LLM opcional só para *nomear/explicar*):

| Label | Heurística base (configurável por org) | Sinais |
|---|---|---|
| `superfa` | RFM alto (R≥4, F≥4, M≥4) **ou** top N% por `engagement_score` + presença em eventos + LTV alto | engajamento + gasto + recência |
| `recem_chegado` | `days_since_join <= 30` **e** ainda sem sinal de risco | tenure curto |
| `em_risco` | `churn_score >= threshold_risco` (default 0.7) **e** membership ativo | churn score |
| `dormindo` | `last_active_at` > N dias (default 60) **e** sem churn formal ainda (não cancelou) | inatividade prolongada |

- Labels gravados em `member_metrics.ai_labels` (jsonb array — contrato já existente do CRM). Um membro pode ter **0..N** labels (ex.: `recem_chegado` + `em_risco` é possível e relevante).
- Cada label vira um **segmento dinâmico de IA** (`segments.type='ai'`) que o CRM lê (contrato do `08-crm.md §1.6`): o segmento é uma regra sobre `member_metrics.ai_labels` OU sobre o score bruto. Refletem o **último recálculo**.
- **Edge case — cold start (base pequena):** com poucos membros não há quintis nem distribuição estatística confiável. Fallback para **thresholds absolutos configuráveis** (mesma decisão do CRM §1.8 para RFM). Abaixo de `min_base_for_ml` (default 50 membros ativos), `churn_score` e `superfa` por percentil ficam **desligados** e exibimos "base pequena demais para segmentação por IA — usando regras simples". Recém-chegado e dormindo funcionam sempre (são puramente temporais, não precisam de massa).
- **Histerese (anti-flapping):** um membro não entra/sai de `em_risco` a cada job. Aplicamos banda morta: entra em `em_risco` com `churn_score >= 0.70`, só sai com `< 0.55`. Evita spam de `member.segment_entered`/`left` na timeline e alertas duplicados.

#### 1.4 Capacidade 2 — Churn score + alertas

- `churn_score` ∈ [0,1] por membro, gravado em `member_metrics.churn_score` (contrato CRM). **Modelo:** no MVP, **score heurístico explicável** (regressão logística leve / soma ponderada de features), **não** o LLM — porque (a) precisa rodar barato sobre toda a base diariamente, (b) precisa ser determinístico e auditável, (c) o LLM alucina em números (ver Riscos). O LLM entra **só** para gerar a **explicação em linguagem natural** e a **sugestão de retenção** quando o admin abre o caso.
- **Features (do que o CRM/billing já produz):** dias desde último pagamento, falhas de cobrança recentes (dunning), queda de `engagement_score` (delta nas últimas N semanas), inatividade (`last_active_at`), não-comparecimento a eventos, downgrade recente, proximidade de `current_period_end` sem auto-renew, tickets/notas negativas. **Nenhuma feature é PII enviada ao LLM no cálculo do score** (o score é local; só a *explicação* opcionalmente recebe um resumo anonimizado).
- **Saída por membro:** `churn_score`, `churn_band` (low/medium/high derivado por threshold), `churn_reasons` (top features que puxaram o score — jsonb, geradas pelo próprio modelo via contribuição de cada feature, não pelo LLM).
- **Alertas (do doc §10.2 — "3 membros prestes a cancelar — enviar perk?"):** o job gera registros em `ai_alerts` quando um membro **cruza** para `high` (transição, não estado — usa histerese). O dashboard e a "Caixa de IA" mostram o alerta com **ação sugerida** ("enviar perk X", "oferecer pausa", "mensagem de retenção"). A ação é um **rascunho/atalho**, não execução automática.
- **Edge case — churn em plano parcelado:** plano parcelado (§13.3) é compra avulsa **sem auto-renovação**; "churn" ali não é cancelamento de assinatura recorrente e sim **não-recompra ao fim do acesso**. O score trata isso como uma feature distinta (`is_installment_expiring`) e a sugestão de retenção muda (oferecer renovar/nova compra, não "evitar cancelamento"). O acesso seguir mesmo com parcela atrasada (decisão de `10-payments-billing`) **não** deve marcar `em_risco` por inadimplência da parcela — só por sinais de engajamento.
- **Edge case — recém-chegado nunca é "em risco" no dia 1:** suprimimos `em_risco` enquanto `days_since_join < grace_onboarding` (default 14) salvo sinal forte (falha de pagamento). Evita alarme falso no onboarding.

#### 1.5 Capacidade 3 — Sugestão do próximo perk

- Dado um membro (ou um tier), recomenda **qual perk concederia/destacaria** para converter (upgrade) ou reter. Combina:
  - **Sinais colaborativos (pgvector):** "membros parecidos com este" (por `member_embedding`) que **subiram de tier** depois de receber/usar o perk X → recomendar X. Filtragem colaborativa simples via similaridade de embedding + co-ocorrência de entitlements.
  - **Catálogo da org (tiers-perks):** só recomenda perks que **existem** na org e que o membro **ainda não tem** (lê `perks`/`entitlements` — read-only).
  - **LLM (opcional):** redige a justificativa em linguagem natural ("este membro foi a 4 eventos mas nunca usou o desconto na loja — ofereça o brinde de fundador").
- Saída: lista ranqueada de `{perk_id, score, rationale}` em `ai_outputs` (`kind='perk_suggestion'`). **Aplicar** = conceder entitlement manual (cortesia) OU criar uma campanha de oferta → ambos passam por confirmação humana e são executados por **tiers-perks**/**communication**, não pela IA.
- **Edge case — cold start de catálogo:** org nova com 1 perk e 0 histórico → sem sinal colaborativo. Fallback para regra simples ("o perk do próximo tier acima") + aviso. Não inventar perk que não existe.

#### 1.6 Capacidade 4 — Copywriting na voz da marca

- Gera rascunhos de **mensagens, drops e campanhas** (do doc §17: "Copy assistida por IA na voz da marca"). Saída sempre **draft** em `ai_outputs` (`kind='copy'`), revisável e editável antes de ir para `communication`.
- **Captura da voz da marca (`brand_voice`):** cada org tem um perfil de voz que alimenta o **system prompt** (via prompt caching — ver §1.9). Montado de:
  - **Configuração explícita:** tom (formal/casual/provocador), pronome de tratamento (você/tu/vocês), emojis (sim/não/moderado), termos proibidos, termos preferidos, idioma(s) (pt-BR/en-US/es — decisão de i18n do doc §30), assinatura, exemplos do-and-don't.
  - **Exemplos de treino (few-shot):** a org cola 3–10 mensagens reais que já enviou ("assim que a gente fala"). Viram exemplos no prompt. **Não há fine-tuning** — é in-context (few-shot + system prompt), barato e auditável.
  - **Aprendizado implícito (pós-MVP):** o `edit_delta` (diferença entre draft e versão aprovada) é coletado; orgs com muitos edits ganham sugestão de atualizar o `brand_voice`. Não auto-aplica.
- **Variáveis de personalização:** o copy pode referenciar tokens (`{{nome}}`, `{{tier}}`, `{{member_since}}`) que **communication** resolve no envio — a IA gera o template, não dispara para membros reais. Evita o LLM ver PII de toda a base.
- **Edge case — sem voz definida:** org sem `brand_voice` configurado → usamos um default neutro + banner "configure a voz da marca para resultados melhores". Não bloqueia.
- **Edge case — claims regulados:** o copy pode prometer coisas (descontos, brindes). Guardrail: o prompt instrui a **não inventar números/preços/datas**; a UI marca tokens financeiros para revisão humana obrigatória. Nunca aplicar copy com valor financeiro sem confirmação.

#### 1.7 Capacidade 5 — Qualificação automática (gera perguntas, infere perfil)

Dois sub-fluxos (contrato CRM `08-crm.md §1.6/K3` — grava em `member_profiles.attributes` e `member_metrics.ai_labels`):

1. **Gerar perguntas:** dado o vertical da org (clube de carro/torcida/gamer/...) e os `custom_field_defs` existentes, a IA propõe **perguntas certas** para descobrir interesses/potencial (ex.: "qual seu modelo de carro?", "vai a jogos fora de casa?"). Saída = `ai_outputs` (`kind='qualify_questions'`) → o admin aprova → vira um **formulário de qualificação** que o membro responde na área de membro (ou import). A IA **gera as perguntas**, não as respostas.
2. **Inferir perfil:** dado o histórico do membro (atributos, eventos, consumo de conteúdo, respostas), a IA infere **interesses/perfil/potencial** e grava como `ai_labels` + atributos inferidos (marcados `source='ai_inferred'`, com `confidence`). **Nunca** sobrescreve dado declarado pelo membro; preenche só o que está vazio e sempre marcado como inferência (auditável e reversível).
- **Edge case — privacidade:** a inferência só roda sobre dados que o membro **forneceu/consentiu**; respeita o opt-out de IA (§1.10). Atributos inferidos não aparecem na rota pública de validação (§9 do doc) e não são tratados como verdade — são hipóteses ranqueadas por `confidence`.
- **Edge case — alucinação de atributo:** inferências de baixa `confidence` (< threshold) não são gravadas, só sugeridas para revisão. Nunca inferir `pii` sensível (CPF, endereço) — bloqueado por allowlist de campos inferíveis.

#### 1.8 Capacidade 6 — Copilot do admin (linguagem natural → consulta + ação)

O fluxo agêntico (do doc §10.2 e §23). Exemplo canônico: *"quem são meus 20 maiores fãs que não vão ao evento?"* / *"crie um segmento dos superfãs que não foram ao último evento e rascunhe um convite"*.

**Fluxo passo a passo:**
1. Admin digita a pergunta na "Caixa de IA" (componente reutilizado no dashboard e no CRM).
2. Edge Function `ai_copilot` monta a request ao Claude com: system prompt (papel + org context + permissões do usuário), o **conjunto de tools** disponíveis (derivadas da API `/v1` — ver §3), e a pergunta. Usa **tool use / function-calling** com o loop padrão.
3. O modelo decide chamar tools. **Tools de leitura** (listar membros, filtrar por segmento, contar, ver métricas, buscar membros similares por embedding) executam **direto** contra a API `/v1` com o **JWT/escopo do usuário** (RLS garante isolamento por org; a IA **não pode** ver dados de outra org nem além das permissões do operador).
4. **Tools de escrita/ação sensível** (criar segmento, enviar campanha, conceder perk, anonimizar membro, mudar tier) **não executam** — retornam uma **proposta** (`ai_outputs` `kind='action_proposal'`, status `completed`) que vira um **card de confirmação** na UI ("Vou criar o segmento X com 23 membros e rascunhar um convite — confirmar?"). Só após o clique humano a ação roda (via a API real, auditada em `audit_logs`).
5. Resposta final em linguagem natural + tabela/preview + ações propostas.

**Guardrails do copilot:**
- **Escopo por org e permissão:** a credencial usada nas tools é a do usuário; um operador sem `crm.pii.read` não vê PII via copilot (mesma regra do CRM). Cross-org é impossível (RLS).
- **Sem ação destrutiva silenciosa:** deletar/anonimizar/cobrar/enviar em massa **sempre** exige confirmação explícita, mesmo via MCP (§23 do doc).
- **Limites de blast radius:** uma proposta que afeta > N membros (default 100) ou movimenta dinheiro mostra aviso reforçado e exige segunda confirmação.
- **Idempotência:** ações propostas carregam `Idempotency-Key`; reenviar a confirmação não duplica.
- **Auditoria:** toda chamada de tool (leitura e escrita) é logada com a pergunta original, as tools chamadas, os argumentos e o resultado, ligada ao `ai_outputs` e ao `audit_logs`.

#### 1.9 Orquestração de LLM, custo e qualidade

- **Provider/SDK:** Claude via `@anthropic-ai/sdk` em Edge Functions (Deno). Default `claude-opus-4-8`; **roteamento por tarefa**: copy/qualificação/copilot → `claude-opus-4-8` (qualidade); classificação/explicações curtas de alto volume → `claude-haiku-4-5` (custo); tarefas intermediárias → `claude-sonnet-4-6`. Modelo configurável por tipo de tarefa em `ai_settings` (não por org — é parâmetro de plataforma, com override só para super-admin).
- **Adaptive thinking + effort:** `thinking: {type: "adaptive"}` para tarefas de raciocínio (copilot, sugestão de perk); `output_config.effort` ajustado por tarefa (`low` para classificação, `high` para copy/copilot). Sem `budget_tokens` (removido nos modelos atuais).
- **Prompt caching (controle de custo central):** o **system prompt + `brand_voice` + definição de tools** são estáveis por org e marcados com `cache_control: {type:"ephemeral"}` → leituras de cache custam ~0.1×. A pergunta/contexto volátil vai **depois** do breakpoint. Verificamos `usage.cache_read_input_tokens` para garantir hit. Isso derruba o custo do copilot e da geração em massa de copy.
- **Structured outputs:** geração que precisa de formato (lista de perks ranqueados, perguntas de qualificação, proposta de ação) usa `output_config.format` (json_schema) **ou** strict tool use (`strict:true`) → parsing garantido, sem regex frágil.
- **Batches API:** recálculos generativos em massa (ex.: gerar `churn_reasons` em linguagem natural para 5.000 membros, ou embeddings de descrições) usam a **Batch API** (50% mais barata, assíncrona) quando não há urgência.
- **Token counting:** `count_tokens` antes de jobs grandes para estimar custo e cortar contexto; nunca usar tiktoken.
- **Budget guard:** `ai_usage` registra tokens/custo por org e por tarefa. Limite mensal configurável (`ai_budget_cap`) — ao atingir, tarefas generativas opt-in pausam (não bloqueia churn/segmentação que são baratas) e o super-admin é notificado. Evita "estouro de custo de tokens".

#### 1.10 Embeddings (pgvector)

- **`member_embedding`** (vetor por membro) alimenta similaridade ("membros parecidos com X", base da sugestão de perk e de buscas semânticas). Montado de um **documento textual derivado** do membro (tier, atributos não-sensíveis, tags, padrão de eventos/consumo) — **não** PII sensível.
- **`content_embedding`/`message_embedding`** (pós-MVP) para busca semântica de conteúdo gated e de mensagens.
- **Provedor de embeddings — DECISÃO PENDENTE (openQuestion):** a Anthropic **não** oferece endpoint de embeddings. A recomendação histórica da Anthropic é um provedor terceiro (ex.: **Voyage AI**) ou um modelo open-source self-hosted. Isso adiciona um **segundo sub-processador** (impacto LGPD/DPA, §26). Recomendação: Voyage AI gerenciado no MVP por qualidade/baixa fricção, com a camada de embedding atrás de uma interface (adapter) para troca futura. **Trava parcial:** sem decisão, a sugestão de perk colaborativa e a busca semântica ficam fora do MVP (degradam para regras).
- **Reprocessamento:** `member_embedding` recalcula quando o documento-fonte muda materialmente (mudança de tier, novos eventos) via flag `embedding_dirty` + job batelado (mesmo padrão `recalc_dirty` do CRM). Índice `ivfflat`/`hnsw` em pgvector.

#### 1.11 Opt-out do membro de uso de IA (LGPD)

- O membro pode **recusar o uso de seus dados pela IA** (preferência na área de membro, `ai_opt_out` em `consents` ou flag dedicada `member_ai_preferences`).
- **Efeito quando opt-out:** o membro **não** é enviado a embedding, **não** entra em inferência de perfil, **não** tem dados enviados ao LLM em prompts (nem como exemplo). Ele **ainda** pode receber score de churn/segmentação **local** (cálculo estatístico sobre dados próprios para fins de relação contratual/legítimo interesse — sem LLM), salvo se a org configurar opt-out total. Decisão de até onde o opt-out vai é **openQuestion**.
- **Default:** opt-in por base legal de legítimo interesse para a parte analítica local; opt-in **explícito** para envio ao LLM e inferência (mais conservador — recomendação). Configurável por org conforme política da org.
- O opt-out é respeitado em **todos** os planos (analítico, generativo, copilot): tools do copilot filtram membros com opt-out de envio ao LLM antes de qualquer texto sair para a Anthropic.

---

### 2. Modelo de dados

> Convenção: **[novo]** = tabela/coluna nova deste domínio; **[toca]** = ajuste em tabela de outro domínio. Toda tabela com `org_id` carrega RLS por `org_id` (fundação). Tabelas globais de plataforma não têm `org_id`.

**`ai_outputs`** **[novo]** — registro auditável de toda saída de IA (referenciada pelo CRM §1.1).
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `kind` | text | `copy` / `perk_suggestion` / `qualify_questions` / `profile_inference` / `churn_explanation` / `action_proposal` / `segment_from_nl` |
| `status` | text | `generating`/`completed`/`edited`/`approved`/`applied`/`discarded`/`failed` |
| `subject_type` | text | `member`/`segment`/`tier`/`campaign`/`org` (a que se refere) |
| `subject_id` | uuid nullable | |
| `input` | jsonb | parâmetros da request (prompt vars, contexto — **sem PII bruta** quando opt-out) |
| `output` | jsonb | conteúdo gerado (estruturado) |
| `output_edited` | jsonb nullable | versão editada pelo humano |
| `edit_delta` | jsonb nullable | diff draft↔aprovado (sinal de qualidade da voz) |
| `model` | text | `claude-opus-4-8` etc. |
| `prompt_version` | text | versão do template usado |
| `usage` | jsonb | `{input_tokens, output_tokens, cache_read_input_tokens, cost_usd}` |
| `applied_ref` | jsonb nullable | link p/ objeto efetivado (campaign_id, entitlement_id, segment_id...) |
| `created_by` / `approved_by` | uuid nullable | actor humano |
| `created_at`/`completed_at`/`applied_at` | timestamptz | |
| | | INDEX(`org_id`,`kind`,`status`); INDEX(`subject_type`,`subject_id`) |

**`ai_alerts`** **[novo]** — alertas acionáveis (churn high, oportunidade de upgrade) para dashboard/Caixa de IA.
| `id` uuid PK · `org_id` · `member_id` FK · `type` (`churn_high`/`upsell_opportunity`/`dormant_reactivation`) · `severity` · `payload` jsonb (score, reasons, suggested_action) · `suggested_output_id` (FK ai_outputs nullable — o rascunho de ação) · `status` (`open`/`acted`/`dismissed`/`expired`) · `created_at`/`resolved_at`. INDEX(`org_id`,`status`,`severity`); UNIQUE(`org_id`,`member_id`,`type`) WHERE status='open' (não duplica alerta aberto pro mesmo membro). |

**`brand_voice`** **[novo]** — perfil de voz por org (1:1 com org).
| `org_id` PK/FK · `tone` jsonb (formal/casual/...) · `pronoun` · `emoji_policy` · `forbidden_terms` jsonb · `preferred_terms` jsonb · `signature` · `languages` jsonb (`["pt-BR"]`) · `examples` jsonb (few-shot) · `system_prompt_cache` text (render cacheável) · `version` int · `updated_at`. |

**`member_embeddings`** **[novo]** — vetores pgvector por membro.
| `member_id` PK/FK · `org_id` · `embedding` vector(N) · `source_doc_hash` text (detecta mudança) · `model` · `embedding_dirty` bool · `updated_at`. Índice `hnsw`/`ivfflat` em `embedding` (por org via partial/filtro); INDEX(`embedding_dirty`) WHERE embedding_dirty. |

**`ai_tasks`** **[novo]** — fila/registro de jobs de IA (orquestração via pgmq, este é o espelho durável p/ status/retry).
| `id` uuid PK · `org_id` nullable (jobs globais) · `type` (`churn_recalc`/`segment_label`/`embedding_refresh`/`copy_generate`/`qualify`/`perk_suggest`/`copilot_turn`) · `status` (`queued`/`running`/`done`/`failed`/`dead`) · `params` jsonb · `result_ref` · `attempts` · `error` · `scheduled_at`/`started_at`/`finished_at`. INDEX(`status`,`type`); DLQ via `status='dead'`. |

**`ai_usage`** **[novo]** — telemetria de custo por org/tarefa/dia (budget guard).
| `id` · `org_id` · `day` date · `task_type` · `model` · `requests` · `input_tokens` · `output_tokens` · `cache_read_tokens` · `cost_usd` numeric. UNIQUE(`org_id`,`day`,`task_type`,`model`). |

**`ai_settings`** **[novo, global]** — roteamento de modelo e parâmetros de plataforma.
| `id`=1 singleton · `model_by_task` jsonb (`{copy:"claude-opus-4-8", classify:"claude-haiku-4-5", ...}`) · `effort_by_task` jsonb · `default_thresholds` jsonb (churn risco, dormant days, min_base_for_ml) · `embedding_provider` · `embedding_model`. Override por org só p/ thresholds em `ai_org_settings` (opcional). |

**`member_ai_preferences`** **[novo]** — opt-out de IA por membro (ou estende `consents`).
| `member_id` PK/FK · `org_id` · `llm_send_opt_out` bool · `inference_opt_out` bool · `embedding_opt_out` bool · `updated_at`/`source`. (Espelhado em `consent_history` para auditoria.) |

**Tabelas tocadas (contratos do CRM — este domínio é o produtor):**
- `member_metrics` **[toca]** — produz `churn_score`, `churn_band`, `churn_reasons` (jsonb), `ai_labels` (jsonb array), `ai_inferred_at`. (Colunas já previstas/estendidas no `08-crm.md §2`.)
- `member_profiles.attributes` **[toca]** — recebe atributos inferidos com `source='ai_inferred'` + `confidence` (no jsonb).
- `segments` **[toca]** — segmentos `type='ai'` populados/atualizados por este domínio (contrato CRM §1.6).
- `consents`/`consent_history` **[toca]** — canal/flag de IA (alternativa a `member_ai_preferences`).

**RLS:** tudo com `org_id` isolado. `ai_settings` é global (só super-admin). `member_embeddings` respeita RLS e o filtro de opt-out na geração.

---

### 3. API & Edge Functions

**Endpoints REST `/v1` (do doc §21.2 — Segmentos & IA — + novos):**
```
# do doc §21.2
POST   /v1/ai/churn-scores            # recalcula churn (grava member_metrics) — admin/job
POST   /v1/ai/copy                    # rascunho de copy na voz da marca → ai_outputs(draft)
POST   /v1/ai/qualify                 # gera perguntas / infere perfil
POST   /v1/segments  (type=ai|nl)     # geração de segmento por regra OU por linguagem natural

# novos deste domínio
POST   /v1/ai/copilot                 # turno do copilot (NL → consulta + propostas) [stream opcional]
POST   /v1/ai/copilot/{id}/confirm    # confirma uma action_proposal → executa via API real
POST   /v1/ai/perk-suggestions        # sugere próximo perk (member ou tier)
GET    /v1/ai/outputs                 # lista ai_outputs (filtro por kind/status/subject)
GET    /v1/ai/outputs/{id}            # detalhe de uma saída
POST   /v1/ai/outputs/{id}/approve    # aprova draft
POST   /v1/ai/outputs/{id}/edit       # salva edição humana (edit_delta)
POST   /v1/ai/outputs/{id}/apply      # efetiva (roteia p/ communication/tiers-perks/crm)
POST   /v1/ai/outputs/{id}/discard
GET    /v1/ai/alerts                  # alertas abertos (dashboard/Caixa de IA)
POST   /v1/ai/alerts/{id}/act|dismiss
GET    /v1/ai/members/{memberId}/similar   # membros parecidos (pgvector)
GET/PUT /v1/brand-voice               # ler/configurar voz da marca
GET/PUT /v1/members/{memberId}/ai-preferences  # opt-out do membro (também na member API)
GET    /v1/ai/usage                   # telemetria de custo (admin) / por org (super-admin)
```

**Edge Functions / Jobs:**
- `ai_churn_job` (cron diário + on-demand) — recalcula `churn_score`/`band`/`reasons` sobre a base; aplica histerese; gera `ai_alerts` em transições para `high`. **Sem LLM** no cálculo.
- `ai_segment_job` (cron diário + on-demand) — recalcula `ai_labels` (superfã/recém/risco/dormindo), respeita cold-start/thresholds, atualiza segmentos `type='ai'`, emite diffs de entrada/saída (contrato CRM).
- `ai_embedding_job` (worker pgmq) — gera/atualiza `member_embeddings` para `embedding_dirty`; chama o provedor de embeddings (adapter); respeita `embedding_opt_out`.
- `ai_copy_generate` (Edge Function sob demanda) — monta prompt com `brand_voice` (cacheado), chama Claude (structured output), grava `ai_outputs` draft.
- `ai_qualify` (Edge Function) — gera perguntas (vertical + custom fields) ou infere perfil (com confidence); grava draft/atributos inferidos.
- `ai_perk_suggest` (Edge Function) — similaridade pgvector + catálogo + LLM p/ rationale.
- `ai_copilot` (Edge Function, loop agêntico) — orquestra tool use; leitura executa, escrita vira proposta; loga tudo; respeita escopo/permissão/opt-out.
- `ai_apply` (Edge Function) — efetiva uma saída aprovada roteando para o domínio dono (communication/tiers-perks/crm) com Idempotency-Key e auditoria.
- `ai_usage_meter` (interno) — soma tokens/custo em `ai_usage`; aplica `ai_budget_cap`.
- `ai_churn_explain` (worker, Batch API) — gera explicações NL em massa quando solicitado (opcional/assíncrono).

**MCP (do doc §23):** as tools do copilot são **as mesmas** expostas pelo MCP server (derivado do OpenAPI). O copilot do admin é um **cliente** dessas tools; o guardrail de confirmação para ações de escrita vale igual no MCP. Isso evita duas implementações de "IA que age na base".

**Idempotência:** `POST /v1/ai/copilot/{id}/confirm` e `apply` exigem `Idempotency-Key`. Jobs são idempotentes por `ai_tasks.id`.

---

### 4. Telas/Front

**Admin (módulo "IA" — §10.1 item 10 + integrações nas outras telas):**
1. **Caixa de IA (copilot)** — campo de linguagem natural reutilizável; renderiza resposta NL + preview tabular + **cards de ação proposta** (confirmar/editar/descartar). Aparece como página própria e como widget no dashboard e no CRM. Componente `<AiCopilot/>` com streaming.
2. **Painel de Churn & Alertas** — lista de membros `em_risco` ordenada por score, com `churn_reasons` legíveis, badge de banda, e **ação sugerida** (botão "rascunhar retenção" → abre draft). Filtros por banda/tier. (Também alimenta o card do dashboard §10.2.)
3. **Segmentos de IA** — os 4 segmentos vivos (superfã/recém/risco/dormindo) com contagem, tendência e atalho "criar campanha". Integra com o Segment Builder do CRM (gerar regra por NL → `<RuleBuilder/>` preenchido para revisão).
4. **Studio de Copy** — gerar/editar/aprovar copy na voz da marca; preview com tokens de personalização; histórico de drafts (`ai_outputs`); botão "enviar para Comunicação". Componente `<CopyStudio/>` com editor diff.
5. **Sugestão de Perk** — no perfil 360 do membro (aba IA) e por tier: lista ranqueada com rationale; "conceder cortesia" (→ tiers-perks, confirmação) ou "criar oferta" (→ communication).
6. **Qualificação** — gerar perguntas → revisar → publicar formulário; ver perfil inferido por membro (com confidence, marcado como inferência, reversível).
7. **Voz da Marca** — editor de `brand_voice`: tom, termos, idiomas, e **colar exemplos** ("assim que a gente fala"); preview de um draft de teste.
8. **Uso & Custo de IA** — telemetria de tokens/custo por tarefa, budget cap (admin vê o da org; super-admin vê global).
9. **Auditoria de IA** — feed de `ai_outputs` (quem gerou, editou, aprovou, aplicou) — transparência/LGPD.

**Componentes-chave:** `<AiCopilot/>`, `<ActionProposalCard/>` (confirmação humana), `<CopyStudio/>` (editor + diff + tokens), `<ChurnPanel/>`, `<BrandVoiceEditor/>`, `<AiOutputAudit/>`, `<PiiGuard/>` (reutilizado — IA respeita permissões de PII).

**Membro (área do membro):** **opt-out de IA** nas preferências/privacidade (`<AiPreferencesToggle/>`); responder o **formulário de qualificação** quando publicado. O membro **não** vê scores nem inferências (são admin-facing).

---

### 5. Integrações externas

- **Claude (Anthropic) via `@anthropic-ai/sdk`** — todas as chamadas de geração/raciocínio (copy, qualificação, copilot, explicações, rationale de perk). Em Edge Functions com `ANTHROPIC_API_KEY` secret. Prompt caching, structured outputs, tool use, Batch API para volume. **Sub-processador LGPD** → exige DPA (§26 do doc) e respeita opt-out/ZDR conforme política.
- **Provedor de embeddings (ex.: Voyage AI ou self-hosted) — DECISÃO PENDENTE** — gera vetores para pgvector. Atrás de um adapter (`EmbeddingProvider`) para troca. **Segundo sub-processador** (impacto DPA) se gerenciado.
- **pgvector (Supabase Postgres)** — armazenamento e busca de similaridade (interno, não externo).
- **pgmq / pg_cron (Supabase)** — fila e agendamento dos jobs analíticos e generativos em massa.
- **CRM (`08-crm.md`)** — consome `churn_score`/`ai_labels`/segmentos IA/atributos inferidos; este domínio é o produtor. Bidirecional (CRM fornece features; IA grava de volta).
- **Communication (§17)** — recebe copy aprovada para virar campanha/mensagem; devolve métricas que viram features de engajamento.
- **Tiers-Perks (§12)** — fonte do catálogo de perks e dos entitlements; destino de concessões sugeridas (cortesia).
- **MCP server (§23)** — expõe as mesmas tools que o copilot usa; agentes externos do dono também agem com os mesmos guardrails.
- **Webhooks (§22)** — `member.segment_entered`/`left` (de labels IA) e potencial `ai.alert.created` para o stack do dono.
- **Observability (§27)** — métricas de jobs de IA (latência, custo, DLQ, taxa de edição de drafts).

---

### 6. Épicos & tarefas

**Épico A — Fundação da camada de IA**
- A1. Migrations: `ai_outputs`, `ai_alerts`, `ai_tasks`, `ai_usage`, `ai_settings`, `member_ai_preferences` + RLS + índices — **M**
- A2. Cliente Claude em Edge Function (wrapper com retry, timeout, prompt caching, structured outputs, count_tokens, roteamento de modelo por tarefa) — **M**
- A3. `ai_usage_meter` + budget cap + alerta de estouro — **S**
- A4. Máquina de estados de `ai_outputs` (generate→...→applied/discarded) + endpoints approve/edit/apply/discard — **M**
- A5. DPA/segredos: `ANTHROPIC_API_KEY` secret, política de retenção, sub-processador documentado — **S**

**Épico B — Churn score & alertas**
- B1. Modelo heurístico explicável de churn (features de billing/engajamento) + `churn_reasons` — **L**
- B2. `ai_churn_job` (cron + on-demand) + histerese + cold-start (min_base_for_ml) — **M**
- B3. Geração de `ai_alerts` em transições + dedupe (unique aberto por membro/tipo) — **M**
- B4. `ai_churn_explain` (Batch API, explicação NL) — **M**
- B5. `<ChurnPanel/>` + card do dashboard + ação sugerida — **M**

**Épico C — Segmentação automática**
- C1. `ai_segment_job` (labels superfã/recém/risco/dormindo) + thresholds configuráveis + cold-start — **M**
- C2. Sincronização com `segments(type=ai)` + diffs de entrada/saída + webhooks (contrato CRM) — **M**
- C3. Tela "Segmentos de IA" + atalho criar campanha — **S**

**Épico D — Embeddings & similaridade**
- D1. Adapter `EmbeddingProvider` + decisão de provedor (Voyage/self-hosted) — **M**
- D2. `member_embeddings` + documento-fonte (sem PII) + `embedding_dirty` + índice hnsw — **M**
- D3. `ai_embedding_job` (worker pgmq) + respeito a opt-out — **M**
- D4. `GET /v1/ai/members/{id}/similar` + uso na sugestão de perk — **S**

**Épico E — Sugestão de próximo perk**
- E1. `ai_perk_suggest` (similaridade + catálogo + filtro de já-possui + LLM rationale) — **L**
- E2. Cold-start de catálogo (fallback "próximo tier") — **S**
- E3. UI na aba IA do perfil + por tier; aplicar via cortesia/oferta (confirmação) — **M**

**Épico F — Copywriting na voz da marca**
- F1. `brand_voice` (modelo + editor + colar exemplos few-shot + render cacheável) — **M**
- F2. `ai_copy_generate` (structured output + tokens de personalização + guardrail de claims financeiros) — **M**
- F3. `<CopyStudio/>` (editor + diff + aprovar) + `edit_delta` — **M**
- F4. Integração "enviar para Comunicação" (apply → communication) — **S**

**Épico G — Qualificação automática**
- G1. Geração de perguntas (vertical + custom fields) → formulário publicável — **M**
- G2. Inferência de perfil (confidence, allowlist de campos, source=ai_inferred, não sobrescreve declarado) — **L**
- G3. UI: gerar/revisar/publicar + ver inferências (reversível) — **M**
- G4. Formulário de qualificação na área do membro — **M**

**Épico H — Copilot do admin (agêntico)**
- H1. Tools de leitura (membros/segmentos/métricas/similaridade) com escopo/permissão do usuário — **L**
- H2. Loop agêntico `ai_copilot` (tool use, streaming, auditoria de chamadas) — **L**
- H3. Tools de escrita → `action_proposal` + `confirm` + blast-radius guard + idempotência — **L**
- H4. `<AiCopilot/>` + `<ActionProposalCard/>` (dashboard + CRM) — **L**
- H5. Reuso das tools no MCP server (mesmos guardrails) — **M**

**Épico I — Opt-out & LGPD da IA**
- I1. `member_ai_preferences` + `<AiPreferencesToggle/>` na área do membro — **S**
- I2. Enforcement do opt-out em todos os planos (embedding/inferência/prompt) — **M**
- I3. `<AiOutputAudit/>` + retenção/scrub coordenado com anonimização (CRM/security) — **M**

**Épico J — Custo & qualidade**
- J1. Telemetria de uso/custo + tela "Uso & Custo de IA" — **S**
- J2. Versionamento de prompts (`prompt_version`) + métrica de taxa de edição de drafts — **S**
- J3. Avaliação/golden-set de qualidade (copy, segmentação, churn) p/ regressão — **M**

---

### 7. Dependências

- **fundacao** — Edge Functions com secrets (LLM/embedding keys), RLS multi-tenant, pgmq/pg_cron/pgvector, geração de tipos. (Bloqueante.)
- **auth-rbac** — escopo/permissões do copilot e do MCP (ex.: `crm.pii.read`); ator humano em approve/apply. (Bloqueante para copilot/guardrails.)
- **member-identity** — `members`/`member_id` como sujeito de scores/labels/embeddings. (Bloqueante.)
- **crm** — **forte e bidirecional**: o CRM fornece features (LTV/RFM/engajamento/timeline) e consome saídas (churn_score, ai_labels, segmentos IA, atributos inferidos, NL→DSL). Os contratos de coluna vivem no CRM; a produção vive aqui. (Bloqueante para segmentação/churn/qualificação.)
- **payments-billing** — features de churn (falhas de cobrança, dunning, proximidade de fim de período, parcelado expirando). (Forte para churn; degrada sem.)
- **tiers-perks** — catálogo de perks e entitlements para sugestão; destino de concessões. (Forte para sugestão de perk.)
- **communication** — destino do copy aprovado; fonte de métricas de engajamento. (Forte para copy.)
- **events-tickets / content-gating** — sinais de engajamento (presença, consumo) que alimentam segmentação/churn/embeddings. (Para qualidade; degradável.)
- **public-api** — as tools do copilot são a própria API `/v1` (dogfooding). (Bloqueante para copilot.)
- **mcp** — expõe as mesmas tools; copilot e agentes externos compartilham guardrails. (Forte; copilot pode nascer antes do MCP público.)
- **webhooks** — emite `member.segment_entered/left` e `ai.alert.created`. (Pós-MVP do core.)
- **security-lgpd** — opt-out de IA, DPA com sub-processadores (Claude + embeddings), anonimização coordenada, minimização do que vai ao LLM. (Bloqueante para go-live.)
- **observability-qa** — métricas de jobs, custo, DLQ, golden-set de qualidade. (Operacional/qualidade.)
- **design-system / admin-app / member-app** — telas e componentes. (Para UI.)

---

### 8. Riscos & decisões técnicas

- **Alucinação em dados financeiros (crítico):** o LLM **nunca** calcula churn_score, LTV, preços, valores de parcela ou comissão. Números vêm sempre do banco/billing; o LLM só **redige texto** sobre números já calculados, e o copy com tokens financeiros exige revisão humana. Score de churn é modelo estatístico determinístico e explicável, não LLM. Mitiga "IA inventa número".
- **Privacidade dos dados enviados ao LLM:** minimização — só o necessário vai no prompt; PII sensível e membros com opt-out **nunca** são enviados; personalização por tokens (a IA gera template, não vê a base inteira). Sub-processador com DPA (§26). Considerar ZDR/retenção curta com a Anthropic conforme política da org. Risco regulatório se vazar — RLS + filtro de opt-out + masking de PII na camada de tool.
- **Opt-out do membro — escopo ambíguo (openQuestion):** até onde o opt-out vai (só LLM? também score local?). Decisão de produto; default conservador recomendado (opt-in explícito para LLM/inferência; legítimo interesse para analítico local).
- **Cold start / base pequena:** segmentação por percentil e churn por ML não funcionam com <50 membros ativos; fallback para thresholds absolutos + aviso. Recém/dormindo (temporais) sempre funcionam. Evita resultados sem sentido em orgs novas.
- **Captura da voz da marca:** few-shot + system prompt (sem fine-tuning) é barato e auditável, mas a qualidade depende dos exemplos. Sinal de qualidade = taxa de edição dos drafts (`edit_delta`). Risco: org cola exemplos ruins → copy ruim. Mitigar com defaults e preview.
- **Custo de tokens:** prompt caching (system+brand_voice+tools), roteamento por modelo (Haiku para volume), Batch API para massa, budget cap por org, count_tokens antes de jobs grandes. Sem isso, copilot e geração em massa explodem custo. Telemetria em `ai_usage`.
- **Guardrails do copilot (ação sensível):** toda escrita vira proposta com confirmação humana; blast-radius guard; idempotência; escopo por permissão/org (RLS); auditoria total. Mesmo no MCP. Risco de "IA apaga/cobra sozinha" — eliminado por design.
- **Embeddings sem provider Anthropic:** Anthropic não tem endpoint de embeddings → segundo sub-processador (Voyage/self-hosted), impacto DPA. Decisão pendente trava a parte colaborativa (sugestão de perk/busca semântica), que degrada para regras no MVP.
- **Determinismo & auditoria:** outputs de LLM não são reproduzíveis bit a bit; guardamos input/output/model/prompt_version/usage em `ai_outputs` para rastreabilidade, não para reprodução exata.
- **Drift de modelo:** modelos evoluem; `prompt_version` + golden-set de qualidade permite detectar regressão ao trocar modelo.
- **Latência do copilot:** loop agêntico com múltiplas tools pode demorar; usar streaming + adaptive thinking + effort calibrado; tools de leitura rápidas (índices). Propostas de escrita são preview, não esperam execução.
- **Histerese vs. responsividade:** banda morta evita flapping de `em_risco` mas atrasa entrada/saída; thresholds configuráveis por org.

---

### 9. Escopo MVP vs. depois

**MVP (Fase 3 §29 — "IA-first"; depende de CRM/billing da Fase 1–2):**
- Camada base: cliente Claude (caching/structured outputs/roteamento), `ai_outputs` + máquina de estados + approve/edit/apply, `ai_usage` + budget cap.
- **Churn score** heurístico explicável + `ai_alerts` + painel + card no dashboard.
- **Segmentação automática** (4 labels) com cold-start, integrada aos segmentos IA do CRM.
- **Copywriting na voz da marca**: `brand_voice` (config + exemplos), CopyStudio (gerar/editar/aprovar), envio para Comunicação.
- **Qualificação**: gerar perguntas + inferir perfil (com confidence/reversível).
- **Copilot do admin**: leitura por NL + propostas de ação com confirmação humana (tools de leitura + as ações de escrita já existentes via API), reusando guardrails.
- **Opt-out do membro** + auditoria de IA + DPA com Anthropic.

**Depois:**
- **Embeddings/pgvector + sugestão de perk colaborativa + busca semântica** (depende da decisão de provedor de embeddings; degrada para regras no MVP).
- **Churn por ML treinado** (substituir heurística por modelo aprendido com mais dados/feedback).
- **Aprendizado implícito da voz da marca** (sugerir atualização do brand_voice a partir de `edit_delta`).
- **Copilot mais autônomo** (mais tools de escrita, multi-step, agendamento de ações), embeddings de conteúdo/mensagem para busca semântica.
- **i18n completo** da geração (en-US/es além de pt-BR) e A/B de copy por performance.
- **Golden-set de avaliação contínua** e fine-tuning/eval automatizado de prompts.
