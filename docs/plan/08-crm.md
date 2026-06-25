## 08. CRM / Base de Customers

> Fonte de verdade: STANBASE.md §11 (CRM), §25.2 (modelo de dados Membros/CRM), §19 (IA), §13/§25.3 (billing → LTV), §17 (comunicação → consentimento), §21.2 (API), §26 (LGPD). Este plano detalha o domínio para execução.

O CRM é um **módulo de primeira classe** ("praticamente um CRM dedicado"). Ele transforma cada relação pessoa×org num **registro vivo** que combina cadastro + billing + engajamento + comunicação + eventos, enriquecido por IA. Tudo escopado por `org_id` com RLS, exposto pela mesma API pública `/v1` (dogfooding pelo admin).

**Distinção conceitual fundamental (glossário §4):**
- `members` = a relação pessoa×org (a "carteirinha"), dona do **Member ID** de 8 chars. É a entidade billing/identidade.
- **Customer (CRM)** = a **visão 360º** dessa mesma pessoa-membro. Decisão deste plano: **não criamos uma tabela `customers` separada**. O "Customer" é a composição de `members` + `member_profiles` + `member_metrics` + `interactions` + tags/segmentos. O CRM é a camada de leitura/operação sobre o membro. Isso evita um identity-graph duplicado (1 membro = 1 customer dentro da org). Pessoa em duas orgs = dois Member IDs = dois customers (correto, por isolamento de tenant).

---

### 1. Como funciona

#### 1.1 Perfil 360º (composição)
Tela/endpoint de detalhe agrega, num único payload, blocos vindos de vários domínios:
- **Identidade** (`members` + `member_profiles`): Member ID, nome, foto, e-mail, telefone/WhatsApp, redes sociais conectadas, `source` (como entrou: checkout, import, API, indicação, evento).
- **Membership** (`members` + `subscriptions` + histórico): tier atual, histórico de tiers, status, `joined_at` ("membro desde").
- **Financeiro** (`member_metrics` + `transactions`): LTV, MRR contribuído, total pago, método de pagamento, próxima cobrança, inadimplência.
- **Engajamento** (`member_metrics` + `interactions`): engagement_score, último acesso, presença em eventos, consumo de conteúdo.
- **Atributos custom** (`member_profiles.attributes` jsonb): definidos pela org via `custom_field_defs`.
- **Qualificação IA** (`member_metrics` + `ai_outputs`): perfil inferido, interesses, potencial.
- **CRM ops**: tags, segmentos a que pertence, notas, tarefas abertas, consentimentos por canal.

O perfil é **read-model agregado**: o endpoint `GET /v1/members/{id}` monta o DTO a partir de várias tabelas. Para performance em telas, usamos uma view materializada/denormalizada parcial (ver §2 e §8).

#### 1.2 Atributos customizados por org (schema flexível)
**Modelo híbrido:** definições estruturadas (`custom_field_defs`) + armazenamento em jsonb (`member_profiles.attributes`).

- A org define campos: `key`, `label`, `type` (text, number, boolean, date, select, multiselect, url, phone, email), `options` (para select), `required`, `default`, `pii` (bool — campo sensível), `searchable` (bool — indexa para busca), `position`, `vertical_template` (de onde veio).
- Valores ficam em `member_profiles.attributes` (jsonb): `{ "placa": "ABC1D23", "gamertag": "xpto", "time_coracao": "Corinthians", "tamanho_camiseta": "G" }`.
- **Validação na escrita**: Edge Function valida cada chave contra a definição (tipo, options, required) antes de persistir. Front gera form dinâmico das defs.
- **Templates por vertical**: ao criar a org (vertical: clube de carro / time / gamer / balada / creator / empresa), seedamos um conjunto de defs sugeridas (placa+modelo para carro; gamertag+plataforma para gamer; time do coração para torcida). Editáveis/removíveis.
- **Edge case — mudança de tipo**: se a org muda o `type` de um campo já preenchido (ex.: text → number), bloqueamos por padrão. Oferecemos "migrar e validar" (job que tenta cast; valores inválidos vão para `attributes_quarantine` com relatório). Nunca apagamos dado silenciosamente.
- **Edge case — remoção de def**: soft-delete da def (`archived`); os valores permanecem no jsonb mas somem dos forms/busca. "Purge" explícito remove os valores (auditado).
- **Edge case — privacidade de campo**: `pii=true` esconde o valor de operadores sem permissão `crm.pii.read`, mascara em export, e nunca aparece na rota pública de validação (§9 do doc).

#### 1.3 Timeline de interações (append-only)
- `interactions` é **append-only** (sem UPDATE/DELETE em produção; correções via evento de compensação). Cada linha: `member_id`, `type`, `payload` (jsonb), `occurred_at`, `source` (system/integration/manual), `actor`, `idempotency_key`.
- **Tipos** (enum extensível): `subscription.created`, `tier.changed`, `payment.succeeded`, `payment.failed`, `refund.issued`, `checkin`, `message.sent`, `message.opened`, `message.clicked`, `gift.sent`, `channel.joined`, `channel.left`, `content.viewed`, `achievement.earned`, `note.added`, `task.created`, `task.completed`, `consent.changed`, `profile.updated`, `tag.added`, `segment.entered`, `segment.left`, `import.created`, `merge.applied`.
- **Produção de eventos**: cada domínio (payments, events, comms, content, community) publica na timeline via uma função interna `crm_record_interaction()` (idealmente disparada por trigger no Postgres OU por consumo de pgmq, decisão em §8). Idempotência por `idempotency_key` (UNIQUE parcial) para não duplicar em retries de webhook.
- **Ordenação**: por `occurred_at` (real do fato), não `created_at` (quando registramos) — importante para eventos importados/atrasados.
- **Edge case — volume**: membros antigos podem ter milhares de interações. Timeline paginada por cursor (keyset em `(occurred_at, id)`), agrupável por tipo, filtrável. Particionamento por range de `occurred_at` em bases grandes (ver §8).

#### 1.4 Tags e listas
- **Tags** (`tags` + `member_tags`): livres por org, normalizadas (lowercase, trim, dedupe por `slug`), cor opcional. Aplicação manual (individual/massa) ou por automação. `member_tags` carrega `applied_by`, `applied_at`, `source` (manual/auto/import).
- **Listas**: uma **lista** é um conjunto **estático/manual** de membros (`lists` + `list_members`), distinto de segmento (dinâmico). Útil para "convidados do jantar", "beta testers". Pode ser semeada a partir de um segmento (snapshot → vira lista).
- **Diferença operacional**: tag = rótulo no membro; lista = coleção curada; segmento = query salva. Os três alimentam comunicação/automação.

#### 1.5 Segmentos por regra (engine de regras dinâmicas)
- `segments`: `name`, `type` (`rule` | `ai` | `manual_snapshot`), `rules` (jsonb), `materialization` (`dynamic` | `snapshot`), `refresh_cron`, `last_evaluated_at`, `estimated_count`.
- **DSL de regras (jsonb)** — árvore booleana de condições:
  ```json
  {
    "op": "AND",
    "conditions": [
      { "field": "tier_id", "operator": "in", "value": ["uuid-piloto","uuid-fundador"] },
      { "field": "metrics.ltv", "operator": "gte", "value": 1000 },
      { "field": "last_active_at", "operator": "older_than_days", "value": 30 },
      { "field": "attributes.time_coracao", "operator": "eq", "value": "Corinthians" },
      { "op": "OR", "conditions": [
        { "field": "event_attended", "operator": "any_of", "value": ["uuid-evento-x"] },
        { "field": "tag", "operator": "has", "value": "superfa" }
      ]}
    ]
  }
  ```
- **Campos suportados**: colunas de `members`/`member_metrics`/`subscriptions` (whitelist), `attributes.*` (custom), `tag`, `event_attended`, `content_viewed`, `consent.<canal>`, `lifecycle_stage`, `rfm.*`, `days_since_join`, `days_since_last_payment`.
- **Operadores**: eq, neq, in, not_in, gt, gte, lt, lte, between, contains, starts_with, is_null, is_not_null, older_than_days, newer_than_days, has (tag), any_of, all_of, none_of.
- **Compilação segura**: a DSL é compilada para SQL **parametrizado** com whitelist de campos→colunas (nunca string-concat de input → anti-SQL-injection). Cada campo tem um mapper (coluna direta, jsonb path, ou subquery EXISTS para event_attended/tag).
- **Dynamic vs Snapshot (edge case central)**:
  - **Dynamic**: avaliado on-demand na leitura (membership "ao vivo"). Bom para audiências de campanha que devem refletir o estado atual. Custo: query a cada uso.
  - **Snapshot**: materializado em `segment_members` por um job (cron ou on-demand). Bom para reprodutibilidade ("quem estava no segmento no momento X"), performance e para campanhas que não devem mudar a audiência depois de iniciadas.
  - **Regra de produto**: ao **disparar uma campanha**, o segmento dinâmico é **congelado em snapshot** no instante do envio (audiência reproduzível + idempotência). Segmentos para automação contínua (ex.: "entrou em risco") permanecem dynamic e disparam eventos `segment.entered`/`segment.left` na timeline quando a composição muda.
- **Detecção de entrada/saída**: job de avaliação compara composição atual vs. `segment_members` anterior → gera diffs → eventos de timeline + gatilhos de automação/webhook (`member.segment_entered`).

#### 1.6 Segmentos por IA (§19)
- `type='ai'`: o segmento é populado por scores/labels da camada de IA (superfã, recém-chegado, em risco, dormindo). Implementado como segmento por regra sobre `member_metrics` (ex.: `churn_score >= 0.7`) OU como label direto gravado pela IA em `member_metrics.ai_labels` (jsonb array).
- **Regra de produto**: segmentos de IA são **dynamic** por natureza (refletem o último recálculo). O job de IA (§19.1) recalcula scores e regrava labels; o segmento reflete imediatamente.
- IA também pode **sugerir** um segmento (gera a DSL de regras a partir de linguagem natural via copilot — "superfãs que não foram ao último evento") que o admin revisa e salva como `rule`.

#### 1.7 Notas e tarefas atribuíveis
- **Notas** (`notes`): texto livre por membro, `author`, `created_at`, `pinned`, `visibility` (team | private-to-author). Editáveis pelo autor; geram `note.added` na timeline (a nota em si não é a timeline). Suporta @menção de membro da equipe (notifica).
- **Tarefas** (`tasks`): `member_id` (opcional — pode ser tarefa solta), `title`, `description`, `assignee` (org_user), `due_at`, `status` (open/done/cancelled), `priority`, `created_by`. Aparecem no perfil do membro e numa "minha caixa de tarefas". Geram timeline em criação/conclusão. Tarefa atrasada → badge + opção de notificação.
- **Edge case**: ao anonimizar/excluir um membro (LGPD), notas e tarefas vinculadas são anonimizadas (PII removida do corpo via flag) ou arquivadas, conforme política.

#### 1.8 RFM e LTV
**LTV** (`member_metrics.ltv`):
- **Definição**: soma do líquido reconhecido para a org (ou bruto pago pelo membro — decidir, ver openQuestions) de **transações `paid`** do membro, **menos reembolsos/chargebacks**, **mais** ajustes. Inclui assinaturas, ingressos, drops, presentes pagos, upgrades.
- **Cálculo incremental**: cada `transaction` que muda de estado dispara `crm_recalc_ltv(member_id)`. Não recomputar a base inteira a cada transação.
- **Edge case — reembolso/chargeback**: ao processar `refund.issued`/`chargeback`, o valor é **subtraído** do LTV (gera transação negativa ou ajuste em `member_metrics`), gera evento de timeline `refund.issued`, e pode **rebaixar lifecycle/RFM**. LTV pode ficar menor que o histórico de "total pago" (que é bruto). Mantemos os dois campos separados: `ltv` (líquido/contributivo) e `total_paid` (bruto histórico).
- **Edge case — parcelamento**: plano parcelado (§13.3) é compra avulsa; o LTV reconhece **conforme recebimento** (a org recebe antecipado, mas o reconhecimento contributivo segue a política — recomendação: reconhecer no `paid` da transação inteira, já que org recebe antecipado). O **juros pago pelo cliente** (`customer_interest`) **não** entra no LTV contributivo da org (é receita de financiamento da Stanbase, não da org) — apenas em `total_paid` se quisermos mostrar "quanto o membro gastou".
- **Edge case — multi-moeda**: MVP BRL only; campo `currency` previsto.
- **Recálculo em massa**: job noturno reconcilia LTV de membros tocados no dia + recálculo total agendável (admin pode forçar "recalcular LTV da base") via job pgmq batelado.

**RFM** (`member_metrics.rfm` jsonb):
- **Recency**: dias desde última transação/atividade qualificante.
- **Frequency**: nº de transações/eventos num período.
- **Monetary**: ligado ao LTV/total no período.
- Cálculo por **quintis dentro da org** (R/F/M de 1–5) → score combinado e segmento (Champions, Loyal, At Risk, Hibernating...). Quintis são **relativos à base da org** (recalculados por job, pois a fronteira muda quando a base cresce).
- **Edge case — base pequena**: org com <20 membros não tem quintis estatisticamente úteis. Fallback para thresholds absolutos configuráveis ou ocultar RFM até massa mínima.

#### 1.9 Lifecycle stages (máquina de estados)
Estágios: `lead → member → active → at_risk → cancelled → reactivated`. Armazenado em `member_metrics.lifecycle_stage` + histórico em `interactions`.

```
        cadastro/lead capture
  ┌──────────────► lead ───────────────┐
  │                                     │ assina tier (paid)
  │                                     ▼
  │            ┌──────────────────► member ──────────► active
  │            │                                │  (uso/pagamento em dia)
  │   reativa  │ reassina                       │
  │   (paga)   │                     churn_score alto / inadimplência
  │            │                                ▼
reactivated ◄─┴──── cancelled ◄──── at_risk ───┘
                  (cancelou/        (recuperável)
                   grace expirou)
```

**Transições (regras concretas):**
- `lead → member`: primeira transação `paid` de assinatura/tier.
- `member → active`: critério de atividade (login recente OU consumo OU pagamento em dia) — configurável.
- `active → at_risk`: `churn_score >= threshold` OU inadimplência dentro do grace period OU inatividade > N dias.
- `at_risk → cancelled`: cancelamento explícito OU grace period (§13.4) expirou sem pagamento.
- `cancelled → reactivated`: nova transação `paid` após cancelamento. (depois de período, `reactivated` volta a `active`).
- Cada transição **gera evento de timeline** + dispara webhook (`member.churned` etc.) + reavalia segmentos.
- **Edge case**: transições devem ser **idempotentes** e baseadas em eventos de billing reais, não em jobs que adivinham. Quem manda no `cancelled` é o estado do `subscription`/grace, não o CRM. O CRM **reflete**, não decide o billing.

#### 1.10 Import/Export CSV e migração de base
**Import (fluxo passo a passo):**
1. Upload CSV (Storage) → cria `import_jobs` (status `uploaded`).
2. **Parse + detecção de colunas** (header sniffing) → preview de N linhas.
3. **Mapeamento**: usuário mapeia colunas → campos canônicos (name, email, phone, tier, joined_at, member_id?) e custom attributes. Salvável como template de mapeamento.
4. **Dry-run/validação**: valida tipos, e-mails, telefones (E.164), detecta duplicatas (ver dedupe §1.11) → relatório (linhas ok / com erro / potenciais dups).
5. **Decisões**: o que fazer com dups (skip / update / merge / create-anyway), se gera Member ID novo ou respeita um ID importado, se cria membership/subscription ou só perfil.
6. **Execução**: job batelado (pgmq) processa em chunks com progress; cada linha vira `member` + `member_profile` + tags + interactions. Idempotência por `import_jobs.id + row_hash`.
7. **Resultado**: relatório final (criados/atualizados/pulados/erros) + CSV de erros para correção + rollback parcial possível (cada import marca as rows que criou).

- **Edge case — Member ID**: import **não** deve reutilizar IDs de outra plataforma como Member ID (formato é específico §7). Por padrão geramos novos IDs; opcionalmente guardamos o ID externo em `attributes.external_id` para reconciliação.
- **Edge case — tier inexistente**: se CSV referencia tier que não existe, oferecer "criar tier" ou mapear para existente; nunca falhar a linha inteira por isso (vai para erro recuperável).
- **Edge case — base grande (100k+ linhas)**: streaming parse (não carregar tudo em memória na Edge Function — usar Storage + processamento em chunks via job). Limites de tamanho e rate.
- **Edge case — encoding/separador**: detectar UTF-8/Latin-1, `,`/`;`, aspas. Datas em múltiplos formatos.

**Export:**
- Export assíncrono (job) → gera CSV/JSON no Storage → link assinado temporário.
- Respeita **permissões de PII**: campos `pii` mascarados se sem permissão; export "completo" é ação auditada e pode exigir 2ª confirmação.
- Filtrável por segmento/filtro salvo. Export de LGPD (dados de **um** titular) é caso separado (§5/§26).

**Migração de base existente**: import é a porta; adicionalmente fornecer guia/CLI para migrar de planilha/Notion/outro CRM. Suporte a importar histórico de transações (para LTV correto) e timeline (interações passadas com `occurred_at` real).

#### 1.11 Dedupe e merge
- **Detecção de duplicatas**: por chaves fortes (e-mail normalizado, telefone E.164, external_id) e fracas (nome fuzzy + sobreposição de atributos). Score de similaridade; acima do threshold → candidato a merge.
- **Origem**: durante import, ou job periódico de dedupe, ou ação manual ("possível duplicata" no perfil).
- **Merge (fluxo)**:
  1. Escolhe **registro sobrevivente** (survivor) e **mesclado** (loser).
  2. **Resolução de conflitos campo-a-campo**: regra padrão (survivor vence; preencher nulos do survivor com valores do loser) + override manual por campo.
  3. **Reparenting**: subscriptions, transactions, interactions, tickets, notes, tasks, tags, entitlements, passes do loser → reapontam para o survivor.
  4. **LTV/RFM/metrics**: recalculados do zero para o survivor (não somar metrics — recomputar das transações).
  5. **Member ID**: survivor mantém seu Member ID. O Member ID do loser é **aposentado** (nunca reutilizado, §7.6) e registrado em `member_id_aliases` apontando para o survivor → validação pública e passes antigos do loser ainda resolvem (redirect) mas mostram o survivor.
  6. **Passes/Wallet**: passes do loser são invalidados/atualizados (push) ou re-emitidos sob o survivor.
  7. **Auditoria**: `merges` registra survivor, loser, snapshot pré-merge (para "undo" dentro de janela) e quem fez.
- **Edge case — merge entre membros com subscriptions ativas conflitantes**: bloquear/avisar (não pode ter dois memberships ativos do mesmo tier; consolidar). Decisão de negócio: ver openQuestions.
- **Edge case — merge cross-org**: **proibido** (orgs são isoladas; mesma pessoa em duas orgs são dois customers legítimos).
- **Undo**: janela de reversão usando o snapshot (best-effort; após reprocessamentos pode degradar).

#### 1.12 Busca avançada e filtros salvos
- **Busca rápida (global)**: por Member ID, nome, e-mail, telefone, tag — index trigram/`pg_trgm` + busca exata por ID. Latência <150ms em bases grandes.
- **Busca avançada**: usa a **mesma DSL de regras** dos segmentos (qualquer campo/atributo/operador) → "salvar como segmento" ou "salvar como filtro/visão".
- **Filtros salvos (`saved_views`)**: `name`, `rules` (jsonb), `columns` (quais colunas exibir), `sort`, `view_type` (table/kanban/cards), `shared` (org-wide vs. pessoal), `owner`.
- **Visões**: tabela (colunas configuráveis), kanban por lifecycle_stage, cards. Kanban permite drag para mudar stage (com restrições — nem toda transição é manual; mudar para `cancelled` requer fluxo de billing).
- **Edge case — atributos custom na busca**: só campos `searchable=true` são indexados (GIN em jsonb path específico); demais filtram com scan (avisar custo / limitar).

#### 1.13 Consentimentos e preferências por canal (LGPD §26)
- `consents`: `member_id`, `channel` (email | push | whatsapp | sms), `status` (granted | revoked | pending), `basis` (consent | legitimate_interest | contract), `source`, `text_version`, `updated_at`. Append-only de mudanças em `consent_history` + estado atual.
- **Regra de produto**: comunicação (§17) **respeita consentimento por canal** — campanha em canal sem consentimento **exclui** o membro automaticamente (e mostra quantos foram excluídos). Transacional (cobrança, recibo) segue base legal de contrato, independente de marketing opt-in.
- **Edge case — preferências granulares**: além de canal, preferência por **tipo** de mensagem (marketing, novidades, eventos) — opcional pós-MVP.
- **Double opt-in**: configurável por org/canal (WhatsApp exige; e-mail recomendável).
- Mudança de consentimento gera `consent.changed` na timeline.

---

### 2. Modelo de dados

> Baseado em §25.2. Marcações: **[novo]** = tabela/coluna nova; **[toca]** = existente do doc que ajustamos.

**Tabelas existentes do doc (§25.2) com ajustes:**

`members` **[toca]**
- `id` uuid PK, `member_id` text UNIQUE GLOBAL (8 chars, normalizado upper), `org_id` FK, `user_id` FK (nullable — membro pode existir sem login), `tier_id` FK nullable, `status`, `joined_at`, `source`.
- **[novo]** `created_at`, `updated_at`, `deleted_at` (soft-delete LGPD), `anonymized_at`.
- Índices: UNIQUE(`member_id`); INDEX(`org_id`, `status`); INDEX(`org_id`, `tier_id`); INDEX(`org_id`, `joined_at`).
- Constraint: `member_id ~ '^[A-Z2-9]{8}$'` (alfabeto sem ambíguos — letras sem I/O, dígitos sem 0/1).

`member_profiles` **[toca]**
- `member_id` PK/FK, `name`, `photo_url`, `email` (citext), `phone` (E.164), `social` jsonb, `attributes` jsonb.
- **[novo]** `email_normalized` (generated, lower), `phone_normalized`, `attributes_quarantine` jsonb (valores que falharam migração).
- Índices: INDEX(`org_id`, `email_normalized`); INDEX(`org_id`, `phone_normalized`); GIN(`attributes` jsonb_path_ops) para campos searchable; `gin_trgm_ops` em `name` para busca fuzzy.

`member_metrics` **[toca]**
- `member_id` PK/FK, `ltv` numeric, `engagement_score` numeric, `churn_score` numeric, `rfm` jsonb, `last_active_at`.
- **[novo]** `total_paid` numeric (bruto histórico, separado de ltv), `mrr_contribution` numeric, `lifecycle_stage` text, `lifecycle_changed_at`, `ai_labels` jsonb (array de labels da IA), `rfm_r`/`rfm_f`/`rfm_m` smallint (quintis), `recalc_dirty` bool (flag para job), `metrics_version` int.
- Índices: INDEX(`org_id`, `lifecycle_stage`); INDEX(`org_id`, `churn_score`); INDEX(`org_id`, `ltv`); INDEX(`recalc_dirty`) WHERE recalc_dirty.

`tags` / `member_tags` **[toca]**
- `tags`: `id`, `org_id`, `slug` (UNIQUE por org), `label`, `color`, `created_by`, `created_at`.
- `member_tags`: `member_id`, `tag_id`, `applied_by`, `applied_at`, `source`. PK(`member_id`,`tag_id`). INDEX(`tag_id`).

`segments` **[toca]**
- `id`, `org_id`, `name`, **[novo]** `type` (rule|ai|manual_snapshot), `rules` jsonb, `materialization` (dynamic|snapshot), `refresh_cron`, `last_evaluated_at`, `estimated_count`, `ai_generated` bool, `created_by`, `created_at`, `updated_at`.

`notes` **[toca]**
- `id`, `member_id`, `org_id`, `author`, `body`, **[novo]** `pinned`, `visibility`, `mentions` jsonb, `created_at`, `updated_at`, `deleted_at`.

`interactions` (timeline) **[toca]** — **append-only**
- `id` uuid PK, `member_id`, `org_id`, `type`, `payload` jsonb, `occurred_at`, **[novo]** `source`, `actor`, `idempotency_key`, `created_at`.
- Índices: INDEX(`member_id`, `occurred_at` DESC, `id`) (keyset); INDEX(`org_id`, `type`, `occurred_at`); UNIQUE(`idempotency_key`) WHERE idempotency_key IS NOT NULL.
- **Particionamento**: por RANGE de `occurred_at` (mensal) em escala. Sem UPDATE/DELETE (revogar via INSERT de evento de compensação).

`entitlements` — referenciado pelo CRM (read-only aqui; dono é tiers-perks).

**Tabelas novas [novo]:**

`custom_field_defs`
- `id`, `org_id`, `key` (UNIQUE por org), `label`, `type`, `options` jsonb, `required`, `default`, `pii` bool, `searchable` bool, `position`, `vertical_template`, `status` (active|archived), `created_at`.

`lists` / `list_members`
- `lists`: `id`, `org_id`, `name`, `description`, `created_by`, `created_at`.
- `list_members`: `list_id`, `member_id`, `added_by`, `added_at`. PK(`list_id`,`member_id`).

`segment_members` (materialização de snapshots)
- `segment_id`, `member_id`, `snapshot_at`, `snapshot_run_id`. PK(`segment_id`,`member_id`,`snapshot_run_id`). INDEX(`member_id`).

`tasks`
- `id`, `org_id`, `member_id` nullable, `title`, `description`, `assignee` (org_user), `created_by`, `due_at`, `status`, `priority`, `created_at`, `completed_at`. INDEX(`org_id`,`assignee`,`status`); INDEX(`member_id`).

`consents` (estado atual) + `consent_history` (append-only)
- `consents`: `member_id`, `channel`, `status`, `basis`, `source`, `text_version`, `updated_at`. PK(`member_id`,`channel`).
- `consent_history`: `id`, `member_id`, `channel`, `old_status`, `new_status`, `basis`, `source`, `at`, `actor`.

`saved_views`
- `id`, `org_id`, `name`, `rules` jsonb, `columns` jsonb, `sort` jsonb, `view_type`, `shared` bool, `owner` (org_user), `created_at`.

`import_jobs`
- `id`, `org_id`, `file_path`, `mapping` jsonb, `options` jsonb, `status` (uploaded|previewed|validating|running|done|failed|rolled_back), `stats` jsonb (created/updated/skipped/errors), `error_file_path`, `created_by`, `created_at`, `finished_at`.

`merges`
- `id`, `org_id`, `survivor_id`, `loser_id`, `pre_snapshot` jsonb, `field_resolution` jsonb, `status` (applied|reverted), `applied_by`, `applied_at`, `reverted_at`.

`member_id_aliases`
- `alias_member_id` (8 chars, aposentado), `target_member_id`, `reason` (merge|...), `created_at`. Resolve validação pública e passes antigos para o survivor.

`member_search_index` **[novo, materialized/denormalized]** (opcional para perf)
- View materializada ou tabela mantida por trigger: `member_id`, `org_id`, nome/email/phone tsvector, tier, lifecycle, ltv, churn, last_active, tags array, attributes searchable. Para listagens/busca rápidas sem N joins. Refresh incremental por evento.

**RLS**: todas as tabelas com `org_id` → policy por `org_id` derivado do JWT/credencial. `member_id_aliases` e busca global respeitam org. Campos `pii` filtrados em camada de aplicação (DTO), não RLS.

---

### 3. API & Edge Functions

**Endpoints REST `/v1` (do doc §21.2 + novos):**

Membros / CRM (do doc):
```
GET    /v1/members                      # listar/filtrar (DSL de regras via query) + cursor
POST   /v1/members                      # criar (gera Member ID), valida custom fields
GET    /v1/members/{memberId}           # perfil 360º (DTO agregado)
PATCH  /v1/members/{memberId}           # atualizar perfil/atributos (valida defs)
DELETE /v1/members/{memberId}           # cancelar/anonimizar (LGPD, soft + scrub)
GET    /v1/members/{memberId}/timeline  # cursor keyset, filtros por tipo
POST   /v1/members/{memberId}/notes     # criar nota
POST   /v1/members/{memberId}/tags      # aplicar tag(s)
DELETE /v1/members/{memberId}/tags/{tagId}
GET    /v1/members/{memberId}/entitlements
```

Novos (CRM):
```
# Custom fields
GET    /v1/custom-fields
POST   /v1/custom-fields
PATCH  /v1/custom-fields/{id}
DELETE /v1/custom-fields/{id}            # archive (+ purge opcional)

# Tags / Listas
GET    /v1/tags                          POST /v1/tags
GET    /v1/lists                         POST /v1/lists
POST   /v1/lists/{id}/members            DELETE /v1/lists/{id}/members/{memberId}
POST   /v1/lists/from-segment/{segmentId}   # snapshot segmento → lista

# Segmentos
GET    /v1/segments                      # do doc
POST   /v1/segments                      # regras OU IA (do doc)
GET    /v1/segments/{id}/members         # avalia (dynamic) ou lê snapshot
POST   /v1/segments/{id}/evaluate        # força avaliação/snapshot
POST   /v1/segments/{id}/preview         # conta/amostra sem salvar (para o builder)

# Tarefas
GET    /v1/tasks                         POST /v1/tasks
PATCH  /v1/tasks/{id}                    # status/assignee/due

# Consentimentos
GET    /v1/members/{memberId}/consents
PUT    /v1/members/{memberId}/consents/{channel}

# Busca / Views
POST   /v1/members/search                # DSL avançada no body
GET    /v1/saved-views                   POST /v1/saved-views   PATCH/DELETE

# Import / Export
POST   /v1/imports                       # cria job (após upload Storage)
POST   /v1/imports/{id}/preview
POST   /v1/imports/{id}/validate         # dry-run
POST   /v1/imports/{id}/run
GET    /v1/imports/{id}                   # status/relatório
POST   /v1/exports                       # cria export assíncrono (filtro/segmento)
GET    /v1/exports/{id}

# Dedupe / Merge
GET    /v1/members/duplicates            # candidatos
POST   /v1/members/merge                 # survivor + loser + resolução
POST   /v1/members/merge/{id}/revert     # undo na janela

# Métricas/LGPD
POST   /v1/members/{memberId}/recalc     # força LTV/RFM/lifecycle (admin)
GET    /v1/members/{memberId}/export-data    # portabilidade LGPD (titular)
POST   /v1/members/{memberId}/anonymize      # direito ao esquecimento
```

IA (do doc §21.2, consumido pelo CRM):
```
POST   /v1/ai/churn-scores      # recalcula churn (grava member_metrics)
POST   /v1/segments (ai)        # geração de segmento por NL
POST   /v1/ai/qualify           # gera perguntas / infere perfil
```

**Edge Functions / Jobs:**
- `crm_record_interaction` — função interna chamada por outros domínios / consumidor pgmq → grava timeline (idempotente).
- `crm_recalc_ltv` (job, on-event + nightly batch) — recalcula LTV/total_paid; trata reembolso/chargeback.
- `crm_recalc_rfm` (cron diário) — recomputa quintis por org + atribui segmento RFM.
- `crm_lifecycle_engine` (on-event) — aplica transições de estado a partir de eventos de billing/atividade.
- `crm_segment_evaluator` (cron + on-demand) — avalia segmentos dynamic, materializa snapshots, gera diffs entrada/saída → eventos + webhooks.
- `crm_import_processor` (worker pgmq) — processa import em chunks.
- `crm_export_builder` (worker) — gera CSV/JSON no Storage.
- `crm_dedupe_scanner` (cron) — gera candidatos a merge.
- `crm_merge_apply` (Edge Function) — executa merge transacional + reparenting + recálculo.
- `crm_search_index_refresh` (trigger/worker) — mantém `member_search_index`.
- `crm_anonymize` (Edge Function) — scrub LGPD preservando registros financeiros legais.
- IA: `ai_churn_job`, `ai_segment_from_nl`, `ai_qualify` (em ai-layer, gravam em member_metrics).

**Idempotência**: POSTs de escrita relevantes aceitam `Idempotency-Key` (§21.1). Interactions e imports são idempotentes por design.

---

### 4. Telas/Front (Admin)

Módulo "Membros / CRM" (admin §10.1 item 2). Telas:

1. **Lista de membros** — tabela densa com colunas configuráveis (Member ID, nome, tier, lifecycle, LTV, churn, último acesso, tags), busca global, filtros avançados (builder de regras), filtros salvos, seletor de visão (tabela/kanban/cards), **ações em massa** (aplicar tag, adicionar à lista, enviar p/ campanha, export, mudar lifecycle quando permitido). Paginação por cursor; virtualização para bases grandes.
2. **Perfil 360º** — header (foto, nome, Member ID, tier, status, lifecycle, LTV, churn badge IA), abas:
   - **Visão geral** (membership, financeiro, engajamento, atributos custom).
   - **Timeline** (append-only, filtro por tipo, agrupamento, cursor infinito).
   - **Notas** (criar/pin/menção).
   - **Tarefas** (criar/atribuir/concluir).
   - **Consentimentos** (toggle por canal, histórico).
   - **Atributos** (form dinâmico das defs, PII mascarada conforme permissão).
   - **Entitlements** (read, vindo de tiers-perks).
   - Ações: editar, mesclar, exportar dados do titular, anonimizar (LGPD), enviar mensagem.
3. **Segment builder** — UI visual da DSL (grupos AND/OR, condições com campo/operador/valor), preview de contagem ao vivo, escolha dynamic/snapshot, salvar como segmento ou view. "Gerar por IA" (input NL → DSL editável).
4. **Tags & Listas** — gestão de tags (cores, merge de tags), listas curadas.
5. **Custom fields** — CRUD de definições (tipo, options, required, pii, searchable, ordem), templates por vertical.
6. **Import wizard** — upload → mapeamento de colunas (com template) → dry-run/relatório → confirmação de dedupe → execução com progress → relatório final + download de erros.
7. **Export** — escolha de escopo (filtro/segmento), colunas, formato; aviso de PII; download assinado.
8. **Dedupe/Merge** — fila de candidatos, comparação lado-a-lado, resolução campo-a-campo, confirmar/reverter.
9. **Minhas tarefas** — caixa global de tarefas atribuídas ao operador.

**Componentes-chave**: `<RuleBuilder/>` (reutilizado em segmentos, busca avançada, views), `<MemberTable/>` virtualizada, `<Timeline/>`, `<DynamicAttributeForm/>`, `<ConsentToggles/>`, `<MergeCompare/>`, `<ImportWizard/>`, `<PiiGuard/>` (mascara campos sensíveis).

**Front de membro**: CRM é admin-facing; o membro vê apenas **suas próprias preferências/consentimentos** e seu perfil editável (subset) na área do membro (§24.2 "Perfil/preferências").

---

### 5. Integrações externas

- **Asaas (payments-billing)** — fonte de `transactions`/refunds/chargebacks que alimentam LTV/RFM/lifecycle (via webhooks de entrada §22). Não chamado direto pelo CRM; consome eventos.
- **Discord/Telegram/WhatsApp (community-channels)** — eventos de join/leave alimentam timeline; consentimento de WhatsApp afeta envio.
- **Comunicação (communication §17)** — campanhas consomem segmentos/listas; eventos de entrega/abertura/clique voltam para a timeline; consentimento por canal é gate de envio.
- **Eventos (events-tickets §14)** — check-ins e compras alimentam timeline + RFM/engajamento.
- **Conteúdo (content-gating §15)** — consumo (`content.viewed`) alimenta engajamento.
- **LLM (Claude, ai-layer §19)** — churn score, labels de segmento, geração de DSL por NL, qualificação. Saídas auditáveis e ligadas ao membro. **pgvector** para similaridade ("membros parecidos com X").
- **Storage (Supabase)** — arquivos de import/export, fotos de perfil.
- **Webhooks de saída (webhooks §22)** — `member.created`, `member.tier_changed`, `member.churned`, `member.segment_entered/left` etc.
- **MCP (§23)** — expõe operações CRM como tools (criar segmento, consultar 360º, aplicar tag, listar superfãs).
- **Zapier/Make** — via API pública.

---

### 6. Épicos & tarefas

**Épico A — Modelo de dados & RLS do CRM**
- A1. Migrations de tabelas novas (custom_field_defs, lists, segment_members, tasks, consents/history, saved_views, import_jobs, merges, member_id_aliases) — **M**
- A2. Ajustar members/member_profiles/member_metrics/interactions/segments com colunas novas + constraints + índices (GIN/trgm/keyset/partição interactions) — **M**
- A3. Políticas RLS por org_id em todas as tabelas + testes de isolamento — **M**
- A4. Particionamento de `interactions` por mês + rotina de criação de partição — **M**

**Épico B — Perfil 360º & atributos custom**
- B1. DTO agregado do 360º (`GET /v1/members/{id}`) compondo várias tabelas — **M**
- B2. CRUD `custom_field_defs` + validação dinâmica na escrita de `attributes` — **M**
- B3. Templates de campos por vertical (seed na criação da org) — **S**
- B4. Migração de tipo de campo + quarantine + relatório — **M**
- B5. `<DynamicAttributeForm/>` + `<PiiGuard/>` + permissão `crm.pii.read` — **M**

**Épico C — Timeline append-only**
- C1. `crm_record_interaction` (idempotente) + contrato de evento — **M**
- C2. Triggers/consumidores pgmq para produzir eventos de cada domínio (payments, events, content, comms, community) — **L**
- C3. `GET /timeline` com keyset cursor + filtros + `<Timeline/>` UI — **M**

**Épico D — Tags, listas, segmentos & rule engine**
- D1. CRUD tags + member_tags + ações em massa — **S**
- D2. CRUD lists + list_members + snapshot de segmento→lista — **S**
- D3. **Rule engine**: DSL jsonb → compilador SQL parametrizado (whitelist de campos + mappers jsonb/EXISTS) — **L**
- D4. `<RuleBuilder/>` UI com preview de contagem ao vivo — **L**
- D5. Segment evaluator (dynamic + snapshot) + diff entrada/saída + eventos/webhooks — **L**
- D6. Congelar segmento em snapshot ao disparar campanha (integra communication) — **M**
- D7. Segmentos por IA (labels member_metrics + geração de DSL por NL) — **M**

**Épico E — Notas & tarefas**
- E1. CRUD notas (pin, visibility, menção + notificação) — **S**
- E2. CRUD tarefas + assignee + due + "minhas tarefas" + badges de atraso — **M**

**Épico F — LTV, RFM & lifecycle**
- F1. `crm_recalc_ltv` incremental on-event (subscriptions/tickets/gifts) — **M**
- F2. Tratamento de reembolso/chargeback no LTV + total_paid separado + timeline — **M**
- F3. `crm_recalc_rfm` por quintis por org + fallback base pequena — **M**
- F4. `crm_lifecycle_engine` (máquina de estados orientada a eventos de billing/atividade) — **L**
- F5. Job noturno de reconciliação + recálculo em massa sob demanda (pgmq batch) — **M**

**Épico G — Busca avançada & views**
- G1. Busca global (trgm + ID exato) + `member_search_index` denormalizado — **M**
- G2. `POST /members/search` (reuso da DSL) + filtros salvos `saved_views` — **M**
- G3. Visões table/kanban/cards + kanban drag de lifecycle (com restrições) — **M**

**Épico H — Import/Export & migração**
- H1. Import wizard: upload, sniffing, preview, mapeamento + template — **M**
- H2. Dry-run/validação (tipos, e-mail, E.164, dups) + relatório — **M**
- H3. `crm_import_processor` em chunks (pgmq) + idempotência + rollback parcial — **L**
- H4. Import de histórico de transações/timeline (para LTV correto) — **M**
- H5. Export assíncrono filtrável + PII masking + link assinado — **M**

**Épico I — Dedupe & merge**
- I1. `crm_dedupe_scanner` (chaves fortes/fracas + score) + UI de candidatos — **M**
- I2. `crm_merge_apply` transacional (reparenting + recálculo + aliases + passes) — **L**
- I3. Undo de merge (snapshot) + auditoria — **M**

**Épico J — Consentimentos/LGPD**
- J1. consents/history + `PUT consents/{channel}` + gate de envio por canal — **M**
- J2. Export de dados do titular (portabilidade) — **S**
- J3. `crm_anonymize` (scrub PII preservando financeiro legal) + cascata em notas/tarefas — **M**

**Épico K — IA do CRM** (depende de ai-layer)
- K1. Integração churn-score → member_metrics + badge no perfil — **M**
- K2. Segmento por NL (copilot → DSL editável) — **M**
- K3. Qualificação automática (perguntas + perfil inferido em attributes/ai_labels) — **M**

---

### 7. Dependências

- **fundacao** — schema base, org/account, RLS multi-tenant, Member ID, pgmq/pg_cron/pgvector. (Bloqueante.)
- **auth-rbac** — papéis owner/admin/operator e permissão granular `crm.pii.read`, atribuição de notas/tarefas a org_users. (Bloqueante.)
- **member-identity** — `members`/`member_id`, `source`, geração de ID; CRM é a visão 360 sobre essa entidade. (Bloqueante.)
- **payments-billing** — `transactions`/refunds/subscriptions alimentam LTV/RFM/lifecycle. (Bloqueante para LTV/lifecycle; perfil/tags/notas funcionam sem.)
- **tiers-perks** — tier atual/histórico e entitlements exibidos no 360; campo `tier` em regras. (Forte.)
- **events-tickets**, **content-gating**, **community-channels** — eventos para timeline e engajamento/RFM. (Para timeline completa; degradável.)
- **communication** — consome segmentos/listas e consentimento; devolve eventos de entrega à timeline. (Bidirecional; segmentos podem nascer antes.)
- **ai-layer** — churn, labels, NL→DSL, qualificação. (Para segmentos IA/churn; CRM por regra funciona sem.)
- **webhooks** — emite `member.*` em mudanças. (Pós-MVP do core.)
- **security-lgpd** — consentimento, anonimização, masking de PII, DPA. (Bloqueante para go-live.)
- **observability-qa** — métricas de jobs (recalc, import, segment eval), DLQ. (Operacional.)
- **public-api / mcp** — expõem o CRM; o admin já consome a API (dogfooding).

---

### 8. Riscos & decisões técnicas

- **Dynamic vs snapshot (decisão central)**: campanhas congelam snapshot no envio (reprodutível/idempotente); automações/IA ficam dynamic. Risco: divergência de contagem entre preview e envio — mitigado deixando claro na UI ("audiência no momento do envio: N").
- **Performance em bases grandes (100k–1M membros)**: listagem/busca via `member_search_index` denormalizado + índices GIN/trgm + keyset pagination; avaliação de segmento via SQL parametrizado com índices apropriados; nunca avaliar segmento por loop em app. Timeline particionada. Risco: jobs de recálculo total (LTV/RFM) pesados → bateladas pgmq + `recalc_dirty` para tocar só o necessário.
- **Rule engine ↔ segurança**: DSL nunca vira SQL por concatenação — whitelist de campos→mappers + binds. Risco de injection e de campos não-indexados gerando full scan (limitar campos searchable; avisar custo).
- **Append-only timeline + idempotência**: webhooks/retries duplicam → `idempotency_key` UNIQUE. Correções via evento de compensação, nunca UPDATE. Eventos atrasados ordenam por `occurred_at`.
- **LTV e reembolso (edge case)**: LTV líquido contributivo é **separado** de total_paid bruto; refund subtrai e pode rebaixar lifecycle/RFM. Juros de parcelamento (`customer_interest`) não entram no LTV da org. Reconhecimento de parcelado: recomendação = no `paid` da compra (org recebe antecipado) — **confirmar com dono** (openQuestion).
- **Lifecycle: CRM reflete, billing decide**: `cancelled`/grace vêm do estado de subscription (§13.4), não de heurística do CRM. Evita estados divergentes.
- **Merge e Member ID**: ID nunca reutilizado (§7.6); loser vira alias → validação/passes antigos resolvem para survivor. Merge cross-org proibido. Undo best-effort.
- **Custom fields por vertical**: jsonb flexível, mas só campos `searchable` indexados; mudança de tipo controlada (quarantine), remoção é soft-delete.
- **Privacidade de campos (PII)**: masking na camada DTO + permissão `crm.pii.read`; export completo auditado; rota pública (§9) nunca expõe PII sem token. Anonimização preserva registros financeiros legais (§26).
- **Import de base grande**: streaming + chunks via job (Edge Function tem limites de tempo/memória); rollback parcial; idempotência por row_hash.
- **Consentimento como gate**: comunicação respeita consentimento por canal; transacional segue base legal de contrato. Risco regulatório se misturar.
- **Dedupe falso-positivo**: merge é destrutivo → exigir confirmação humana, snapshot e undo; não auto-mergear por similaridade fraca.

---

### 9. Escopo MVP vs. depois

**MVP (Fase 1 do core + Fase 2 §29 — "CRM 360º básico → completo"):**
- Perfil 360º (identidade, membership, financeiro básico, atributos custom).
- Custom field defs (CRUD + templates por vertical) + form dinâmico + PII masking básico.
- Timeline append-only com os eventos principais (subscription/payment/checkin/message/note).
- Tags + listas + ações em massa.
- Segmentos por regra (rule engine + builder) — dynamic; snapshot ao disparar campanha.
- Notas e tarefas atribuíveis.
- LTV (incremental + reembolso) e RFM básico; lifecycle stages orientado a eventos de billing.
- Busca global + busca avançada + filtros salvos + visões table/kanban.
- Import/Export CSV com mapeamento, dry-run e dedupe básico.
- Consentimentos por canal + gate de envio; export/anonimização LGPD (titular).

**Depois:**
- Segmentos por IA, churn score, qualificação automática, NL→DSL (Fase 3 §29 — depende de ai-layer).
- Dedupe automático periódico + merge avançado com undo robusto e similaridade fuzzy (MVP entrega dedupe no import + merge manual; o scanner contínuo é pós-MVP).
- Preferências granulares por **tipo** de mensagem (além de canal).
- `member_search_index` materializado e particionamento de timeline (ligados a escala — entram quando a base cresce).
- Similaridade por pgvector ("membros parecidos"), import de histórico completo de timeline de outros CRMs, undo de merge robusto.
- Multi-moeda no LTV.
