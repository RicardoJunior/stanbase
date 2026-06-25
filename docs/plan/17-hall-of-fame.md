## 17. Hall of Fame & Gamificação

> **Domínio:** reconhecimento e engajamento — rankings configuráveis, conquistas/badges, pontos/XP opcionais (que alimentam perks ou subida de tier) e destaque público opt-in na área do membro ("aos melhores, o destaque que merecem").
> **Fontes de verdade no STANBASE.md:** §18 (Hall of Fame e gamificação), §1.1 (pilar Proximidade/Reconhecimento), §10.1 item 9 (módulo "Hall of Fame"), §11.1/§11.2 (CRM: engagement_score, timeline, presença em eventos, conquistas), §12.2 (perk de tipo "Reconhecimento" → badge/posição no hall of fame), §12.3 (entitlements — XP pode conceder), §13 (gasto/LTV), §14 (presença/check-in alimenta Hall of Fame), §15 (consumo de conteúdo → engajamento), §24.2 (tela "Hall of Fame" do membro), §25.6 (`achievements`/`member_achievements`), §26 (LGPD/privacidade/opt-in).
> **Decisões imutáveis aplicáveis:** 1 membership por org (rankings/XP/badges são por org, nunca cross-org); Member ID por relação pessoa×org; PSP = Asaas (o "gasto" vem das `transactions`); destaque público é **opt-in** (LGPD §26). Tudo escopado por `org_id` sob RLS, exposto pela mesma API `/v1` (dogfooding).

Este domínio é **derivado e consumidor**: ele não produz fatos primários (compras, check-ins, consumo de conteúdo, entradas em canal) — ele **observa** os eventos que os outros domínios já emitem (timeline/`interactions`, `transactions`, `checkins`, `content.viewed`, `channel.joined`) e os transforma em **pontuação, ranking, XP e badges**. Princípio central: **o Hall of Fame nunca é a fonte da verdade de um fato** — ele agrega fatos existentes. Isso simplifica anti-gaming (regras vivem perto da fonte), reset sazonal (basta janelar) e auditoria (cada ponto rastreia o evento de origem).

---

### 1. Como funciona

#### 1.1 Quatro capacidades, desacopladas

São quatro features que compartilham a base de eventos mas têm ciclos de vida independentes — uma org pode ligar só badges, ou só ranking, ou tudo:

1. **Rankings (leaderboards)** — listas ordenadas de membros por uma **métrica configurável** (engajamento, antiguidade, presença, gasto) ou por **XP**. Podem ser all-time ou sazonais (janelados). Cada org define seus rankings.
2. **Conquistas/badges (achievements)** — marcos discretos que o membro **destrava** ao cumprir um critério ("Fundador", "10 eventos", "1 ano de casa"). Permanentes por padrão; podem ser revogáveis (badge "ativo enquanto for tier X").
3. **Pontos/XP** — moeda de gamificação **opcional** acumulada por ações. XP pode (a) alimentar um ranking, (b) destravar **perks** (via entitlement), (c) disparar **subida de tier** automática (gamified tier-up), ou (d) ser puramente cosmético. Ligável/desligável por org.
4. **Hall of Fame público (destaque opt-in)** — vitrine na área do membro mostrando os top-N de um ranking e/ou portadores de badges raros. **Aparição é opt-in do membro** (privacidade).

> Separação proposital: **badge** é um marco binário (tem/não tem). **XP** é uma quantidade contínua. **Ranking** é uma ordenação de uma métrica (que pode ser XP ou outra). **Hall of Fame** é a apresentação pública de rankings/badges. Confundir os quatro leva a um motor monolítico difícil de configurar.

#### 1.2 Modelo de pontuação — o "scoring engine" (coração do domínio)

Tudo gira em torno de **regras de pontuação** (`scoring_rules`) que mapeiam **um tipo de evento** → **pontos**. A org configura regras; um worker consome eventos e credita pontos numa **ledger append-only** (`xp_ledger`).

**Anatomia de uma regra:**
- `event_type` — o gatilho (ex.: `checkin`, `payment.succeeded`, `content.viewed`, `channel.joined`, `referral.completed`, `achievement.earned`, `tenure.day`).
- `points` — quantos pontos credita (pode ser fixo, ou função do payload: ex.: `payment.succeeded` credita `floor(valor_pago / fator)`).
- `metric_bucket` — em qual(is) métrica(s) o ponto cai: `xp` (genérico) e/ou `engagement` / `presence` / `spend` (métricas nomeadas que alimentam rankings específicos). Um mesmo evento pode creditar em vários buckets com pesos distintos.
- **Limites anti-gaming** (§1.10): `cap_per_period` (máx. pontos por dia/semana), `cooldown` (intervalo mínimo entre créditos do mesmo tipo), `max_count` (nº máx. de vezes que conta), `min_value` (ex.: só conta compra acima de R$ X), `dedupe_key` (evita crédito duplo do mesmo fato).
- `weight` — peso aplicado quando a métrica composta é calculada (engajamento = soma ponderada de sub-sinais).
- `active`, `valid_from`/`valid_to` (regra pode valer só numa temporada/campanha).

**Fluxo de crédito (passo a passo):**
1. Domínio de origem emite evento → vai para a timeline (`interactions`) **e** para uma fila pgmq `gamification_events` (ou o worker consome a própria timeline por trigger — ver §8).
2. Worker `gamification_scorer` consome o evento, com `dedupe_key = (member_id, event_type, source_event_id)`.
3. Para cada `scoring_rule` ativa que casa com `event_type`: avalia condições (`min_value`, janela de validade), aplica limites (`cap_per_period`, `cooldown`, `max_count` — consultando agregados já creditados), calcula `points`.
4. Insere linha em `xp_ledger` (append-only): `{member_id, rule_id, event_type, source_event_id, points, buckets, season_id, created_at}`. **UNIQUE(`dedupe_key`)** impede crédito duplo em retries.
5. Atualiza agregados materializados em `member_gamification` (XP total, por bucket, por temporada) — incremental, nunca recomputando tudo.
6. Reavalia **achievements** elegíveis (§1.5) e **tier-up por XP** (§1.7) para esse membro.
7. Atualiza posição em rankings dirty (§1.4) — marca `member_gamification.ranking_dirty=true` para o recalculador.

> **Por que ledger append-only:** dá auditoria (quem ganhou ponto por quê), permite **estorno** sem destruir histórico (estorno = linha negativa de compensação, ex.: reembolso devolve os pontos da compra), permite **reconstruir** qualquer agregado e suporta reset sazonal por janela (`season_id`). Nunca fazemos `UPDATE` de pontos; só `INSERT` (positivo ou negativo).

#### 1.3 As quatro métricas de ranking (do doc §18) — definição concreta

Cada métrica é computável de forma determinística a partir de fatos. O ranking referencia **qual** métrica usa.

| Métrica | Definição operacional | Fonte primária | Edge cases |
|---|---|---|---|
| **Antiguidade (tenure)** | `now() - members.joined_at` em dias. Não depende de eventos; é tempo puro. | `members.joined_at` | Membro que cancelou e voltou: contar tempo contínuo desde o **primeiro** join, ou só o período ativo atual? (Open Question). Por padrão: desde o primeiro `joined_at`, descontando gaps > N dias se configurado. |
| **Presença (presence)** | Soma de check-ins de evento (`checkins` com `result=granted`), eventualmente ponderada por tipo de evento. | `checkins` (events-tickets) | Reentrada/no-show; check-in por membership sem ticket (§12.8.4). Cada evento conta 1 por padrão; org pode pesar eventos "grandes". |
| **Gasto (spend)** | Soma de `transactions.gross` (ou líquido — Open Question) pagas pelo membro, dentro da janela do ranking. | `transactions` (payments-billing) | Reembolso/chargeback **subtrai** (linha negativa no ledger). Juros de parcelamento (`customer_interest`) **não** contam como gasto-mérito. Presentes recebidos não contam como gasto do membro. |
| **Engajamento (engagement)** | Soma ponderada de sinais: consumo de conteúdo, mensagens/atividade em canal, abertura/clique de campanha, check-ins, logins. Reusa o `engagement_score` do CRM (§11.1) **ou** recalcula via scoring rules. | `interactions` agregadas (CRM) | É composto e configurável (pesos). Risco de gaming maior — caps obrigatórios. |

> **Decisão de arquitetura:** `engagement` e `presence` e `spend` podem ser tratados como **buckets do mesmo ledger** (regras creditam em buckets nomeados), enquanto `tenure` é **calculado on-read** (tempo, não evento). Assim um único motor serve às quatro, e o ranking só escolhe a coluna/bucket de ordenação. Isso evita quatro pipelines paralelos.

#### 1.4 Rankings (leaderboards) — comportamento e atualização

**Configuração de um ranking (`rankings`):**
- `name`, `metric` (`xp` | `engagement` | `presence` | `spend` | `tenure` | `custom`), `scope` (`all_time` | `seasonal`), `season_config` (cadência: mensal/trimestral/anual/custom), `visibility` (`public_opt_in` | `members_only` | `admin_only`), `top_n` (quantos exibir publicamente), `tie_breaker` (regra de desempate, §1.9), `eligibility` (filtro: só tier X, só lifecycle ativo, excluir staff), `status`.

**Como o ranking é materializado (jobs):**
- Ranking **não** é calculado on-read para listas grandes (ordenar 100k membros a cada page-load é inviável). É **materializado** em `ranking_entries` por um job `gamification_ranking_builder`.
- **Cadência de atualização:** configurável por ranking — `realtime-ish` (recalcula incrementalmente quando um membro fica dirty), `hourly`, `daily`. Default: incremental + reconciliação diária completa.
- **Incremental:** quando um membro ganha pontos (`ranking_dirty`), o builder recomputa a posição **só desse membro e dos vizinhos afetados** (quem foi ultrapassado). Para métrica `tenure` (puro tempo), não há evento — recalcula por cron (a ordem por tempo só muda quando alguém entra/sai; mudança contínua de posição é lenta e previsível).
- **Snapshot por temporada:** ao virar a temporada (§1.8), o ranking final é **congelado** em `ranking_snapshots` (top-N + posição de cada membro) — vira histórico imutável (para "campeões da temporada", badges de pódio, e Hall of Fame histórico).
- **Posição exibida:** o ranking guarda `rank` (posição), `score` (valor da métrica), `delta` (subiu/desceu desde a última atualização, para UI), `member_id`. Posição é **densa ou padrão** conforme empate (§1.9).

**Edge cases de ranking:**
- **Empate** → §1.9 (regra de desempate determinística).
- **Membro inelegível depois de pontuar** (ex.: cancelou, virou staff): some do ranking ativo, mas snapshots passados o preservam (foi campeão de fato).
- **Privacidade** (§1.6): membro opt-out **some da vitrine pública** mas pode continuar contando para "posição privada" que só ele vê ("você está em 7º, mas não aparece publicamente").
- **Ranking vazio / base pequena:** org com < N membros mostra ranking mesmo curto, ou esconde até massa mínima (config). Evitar "Hall of Fame com 1 nome".
- **Score zero:** membros com 0 pontos não aparecem no ranking público (evita lista infinita de zeros); contam para "ainda não pontuou".

#### 1.5 Conquistas/badges (achievements) — máquina e tipos

**Definição (`achievements`):**
- `name`, `description`, `icon`/`art`, `rarity` (common/rare/epic/legendary — afeta destaque no Hall of Fame), `criteria` (jsonb — regra de elegibilidade), `trigger_type` (§abaixo), `revocable` (bool), `repeatable` (bool — pode ganhar várias vezes? ex.: "Top 3 da temporada" é repetível por temporada), `points_reward` (XP que concede ao destravar), `unlocks_perk` (perk concedido como entitlement), `visible` (aparece no perfil/Hall of Fame), `status`.

**Tipos de trigger (como um badge é concedido):**
1. **Por métrica/threshold** — "1 ano de casa" (`tenure >= 365`), "10 eventos" (`presence >= 10`), "R$ 1000 gastos" (`spend >= 1000`), "1000 XP". Avaliado pelo scorer quando o agregado cruza o limiar.
2. **Por evento específico** — "Fundador" (esteve no lote fundador / `joined_at` antes de data X), "Primeiro check-in", "Compareceu ao Evento Y".
3. **Por posição em ranking** — "Campeão da Temporada", "Top 3" (concedido no congelamento da temporada, §1.8).
4. **Manual / curado** — admin concede badge à mão ("MVP escolhido pela equipe", "Embaixador"). Sem critério automático.
5. **Por perk de tier** — tier concede badge de reconhecimento (§12.2 "Reconhecimento") enquanto o membro for daquele tier → badge revogável atrelado ao entitlement.

**Máquina de estados de um `member_achievement`:**
```
        critério satisfeito / concessão manual
                       │
                       ▼
   (none) ──────────► earned ───────────┐
                       │                 │ revoke (badge revogável:
            featured?  │                 │   perdeu tier X / admin)
                       ▼                 ▼
                  earned+featured     revoked  (terminal p/ não-repetível;
                  (no Hall of Fame)             repetível pode reearnar)
```
- `earned` — destravado; permanente por padrão (§12.2 "badges conquistados são permanentes").
- `revoked` — só para badges `revocable=true` (ex.: "ativo enquanto for tier Ouro"). Badge de conquista histórica ("10 eventos") **nunca** revoga, mesmo que o membro depois caia de tier ou a contagem "regrida" por reembolso — **uma vez conquistado, conquistado** (decisão de produto; ver Open Questions para spend/reembolso).
- `featured` — flag de destaque no Hall of Fame (badge raro em vitrine).

**Concessão (idempotente):** chave natural `(member_id, achievement_id)` para não-repetíveis; `(member_id, achievement_id, season_id|occurrence_n)` para repetíveis. Concessão dispara: `achievement.earned` na timeline CRM, `points_reward` no ledger (se houver), entitlement do perk (se `unlocks_perk`), push para passport (badge pode aparecer no passe), webhook `member.achievement_earned`, e notificação ao membro.

**Edge case — critério retroativo:** ao **criar** um achievement novo cujo critério muitos membros já cumprem (ex.: org cria "1 ano de casa" depois de 2 anos de operação), roda um **job de backfill** que concede a todos os elegíveis. Controlável: "conceder retroativo" vs. "valer só daqui pra frente" (config no momento da criação).

#### 1.6 Destaque público & privacidade/opt-in (LGPD §26)

**Regra dura:** aparecer publicamente no Hall of Fame é **opt-in explícito** do membro. Default = **não** aparece com PII pública.

Níveis de visibilidade do membro no Hall of Fame (`member_gamification.public_display`):
- `opted_out` (default) — não aparece em vitrines públicas. Pode aparecer **anônimo/agregado** ("posição #7") só para o próprio membro.
- `opted_in_handle` — aparece com **apelido/handle** e avatar, sem nome real nem Member ID.
- `opted_in_full` — aparece com nome + foto (o que a org permitir).

**Camadas de quem vê o quê:**
| Quem vê | O que aparece |
|---|---|
| **Público / outros membros** | Só membros `opted_in_*`, com o nível escolhido. Membros opted_out são omitidos (a lista "pula" eles — ver edge case abaixo). |
| **O próprio membro** | Sua posição real sempre (mesmo opted_out), seu XP, seus badges, "quanto falta pro próximo". |
| **Admin (org)** | Ranking completo real (todos), para operar/premiar. PII conforme permissão `crm.pii.read`. |

**Edge case — ranking com opt-outs (vazamento por dedução):** se o público vê "1º Ana, 3º Bruno" e some o 2º, deduz-se que existe um 2º opted-out. Para evitar dedução de PII, oferecemos dois modos: (a) **compactar** (renumera só os visíveis: 1,2,3...) ou (b) **mostrar gaps anônimos** ("2º — membro privado"). Recomendação: compactar na vitrine pública. O membro vê sua posição **real** na sua área.

**Edge case — opt-in mas membro é menor/sem consentimento válido:** respeitar base legal; menores nunca em vitrine pública sem consentimento do responsável (config da org / §26). 

**Edge case — direito ao esquecimento (LGPD):** anonimização de um membro (§26) remove-o de vitrines e snapshots públicos (substitui por "membro removido" ou apaga a linha do snapshot público), mas o **ledger pode preservar** agregados financeiros/legais anonimizados. O Hall of Fame **não** pode ser um vetor de re-identificação.

#### 1.7 Pontos/XP alimentando perks ou subida de tier (§18 + §12.3)

XP é **opcional** (org liga/desliga). Quando ligado, há três "saídas" configuráveis:

**(A) XP destrava perk (entitlement):**
- Regra `xp_perk_unlock`: ao atingir `xp >= threshold`, concede um **entitlement manual** do perk (source=`gamification`), com ou sem expiração.
- Reusa o motor de entitlements (tiers-perks §1.5): o Hall of Fame só **emite a concessão**; quem materializa/sincroniza com Discord/conteúdo é o tiers-perks.
- Edge case: XP que cai depois (estorno) **não** revoga o perk já destravado por padrão (XP é "marca de água alta") — a menos que o perk seja explicitamente "enquanto XP >= X".

**(B) XP sobe o tier (gamified tier-up):**
- **Decisão crítica de produto (Open Question):** subir de tier por XP **muda billing**. Há duas semânticas possíveis:
  - **Tier-up "de cortesia/sombra":** o membro ganha os **perks** do tier superior (entitlements) sem mudar a assinatura nem pagar — é reconhecimento, não upgrade comercial. O `subscriptions.tier_id` **não** muda; concedemos os entitlements do tier-alvo via `source=gamification`. Mais seguro (não mexe em cobrança).
  - **Tier-up comercial real:** muda o `tier` da assinatura → muda preço/proração. Conflita com "1 membership/billing por org" e com a engine de proração (§09). Não recomendado como automático.
- **Recomendação:** XP-tier-up = **perks do tier sem mudar a assinatura** (modo cortesia/sombra). Para "virar Founder de verdade" há o caminho comercial normal. Evita cobrar/prorratear sem ação do membro.
- Edge case: o que acontece quando o XP do membro cai abaixo do limiar (estorno/temporada nova)? Recomendação: perks de tier-up por XP são **revogáveis** se atrelados a XP corrente; perks por **marco** (badge) são permanentes. Configurável.

**(C) XP puramente cosmético** — só alimenta ranking/Hall of Fame, nenhum efeito em billing/perks.

#### 1.8 Reset sazonal (seasons)

Rankings/XP podem ser **all-time** ou **sazonais**. Sazonal evita "os veteranos dominam para sempre" e cria recorrência de engajamento.

**Modelo de temporada (`seasons`):**
- `org_id`, `name` ("Temporada 2026-Q3"), `starts_at`, `ends_at`, `status` (`upcoming` | `active` | `closing` | `archived`), `cadence` (manual | monthly | quarterly | yearly).
- Cada linha do `xp_ledger` carrega `season_id` (e também conta para o agregado all-time). Assim **um único ledger** serve all-time e sazonal: all-time = soma tudo; sazonal = soma onde `season_id = X`.

**Fluxo de virada de temporada (passo a passo, idempotente):**
1. Cron/`gamification_season_closer` detecta `ends_at <= now()` numa season `active` → muda para `closing`.
2. **Congela** o ranking sazonal: gera `ranking_snapshots` (top-N + posição de todos os elegíveis) — imutável.
3. Concede **badges de pódio** (achievements trigger por posição: campeão/top3) a partir do snapshot.
4. Dispara webhooks/notify ("temporada encerrada, veja os campeões").
5. Cria a **próxima** season (se cadence automática) com `status=active`; os agregados sazonais "zeram" (porque passam a filtrar por novo `season_id`) — o all-time **não** zera.
6. Marca a season fechada como `archived`.

**Edge cases de reset:**
- **Eventos in-flight na virada:** um check-in que chega atrasado (offline outbox sincronizando depois da virada) deve cair na season do `occurred_at` real, não na season de `created_at`. O ledger usa `occurred_at` para atribuir `season_id`.
- **O que persiste vs. zera:** badges são **permanentes** (não zeram). XP all-time persiste. XP sazonal e ranking sazonal zeram. Perks destravados por marco persistem; perks por "XP sazonal corrente" expiram com a temporada (config).
- **Temporada sem virada automática:** org com cadence `manual` precisa fechar à mão; avisar quando `ends_at` passou e ainda está `active`.
- **Mudar regras no meio da temporada:** alterar pesos/regras durante uma season ativa cria injustiça retroativa. Recomendação: novas regras valem **a partir da próxima season** ou de `valid_from`; mudanças mid-season são marcadas no audit log e avisadas.

#### 1.9 Empate (tie-breaking) — determinístico

Empate é inevitável (dois membros com mesmo XP/presença). A posição **precisa ser determinística e estável** (não "pular" entre page-loads).

**Cadeia de desempate (configurável por ranking, com default):**
1. Métrica principal (XP/presença/gasto/tenure) — maior vence.
2. **Tie-breaker secundário** (default): quem atingiu o score **primeiro** (`first_reached_at` — timestamp em que o membro alcançou aquele valor). Premia consistência/antiguidade no feito.
3. Terceiro: `joined_at` mais antigo (veterano vence).
4. Último (estabilidade absoluta): `member_id` lexicográfico — garante ordem total determinística mesmo em empate completo.

**Modos de exibição de empate:**
- **Ranking padrão (com gaps):** 1, 2, 2, 4 (dois em 2º, ninguém em 3º).
- **Ranking denso:** 1, 2, 2, 3.
- **Sem empate visível (desempate forçado):** usa a cadeia acima para dar posição única a cada um (1, 2, 3, 4) — recomendado para Hall of Fame público (evita "dois campeões").
- Para **prêmios** (badge de pódio, perk de top-3): a cadeia de desempate **sempre** resolve para evitar conceder prêmio a mais gente que o previsto (3 vagas = exatamente 3 ganhadores). Edge case: se a org quiser "todos empatados no 1º ganham", isso é config explícita (`tie_award_policy = share | resolve`).

#### 1.10 Anti-gaming (integridade da pontuação)

Gamificação convida à manipulação. Defesas em camadas:

**No nível da regra (preventivo):**
- `cap_per_period` — máx. de pontos por dia/semana por regra (ex.: "logar dá XP, mas só 1×/dia").
- `cooldown` — intervalo mínimo entre dois créditos do mesmo tipo (anti-spam: abrir o mesmo conteúdo 100× não dá 100×).
- `max_count` — nº máximo de vezes que um tipo conta na vida/temporada.
- `min_value` — limiar (ex.: compra só conta acima de R$ X; mensagem só conta se > N chars / não-duplicada).
- `dedupe_key` — UNIQUE no ledger por `(member_id, event_type, source_event_id)` → o **mesmo fato nunca credita duas vezes** (idempotência contra retries de webhook e replays).
- **Eventos reversíveis:** reembolso/chargeback de uma compra **estorna** os pontos de gasto daquela compra (linha negativa). No-show de evento não gera presença. Sair e reentrar em canal não acumula `channel.joined` repetido (cooldown + dedupe).

**No nível de detecção (reativo):**
- Job `gamification_anomaly_scan` flag de padrões suspeitos: spike anômalo de XP, muitos eventos do mesmo tipo em rajada, múltiplas contas com mesmo dispositivo/IP convergindo (sinal de farm), referral circular (A indica B indica A).
- Membros flagrados → revisão admin (`gamification_flags`); admin pode **estornar** pontos (linha negativa auditada), **excluir** do ranking, ou **isentar** (falso positivo).
- **Referral anti-fraude:** crédito de indicação só conta quando o indicado vira **membro pagante** (não no cadastro), com cooldown e cap. Self-referral (mesmo e-mail/telefone/dispositivo) bloqueado.

**No nível de design:**
- Métricas baseadas em **gasto** e **presença** (eventos com custo real) são intrinsecamente menos gameáveis que "logins" e "cliques". Engajamento (mais gameável) deve ter caps agressivos.
- Pesos configuráveis permitem à org reduzir o valor de sinais baratos.
- **Transparência calibrada:** mostrar "como pontuar" engaja, mas revelar caps/cooldowns exatos facilita gaming. Mostrar regras gerais, esconder números de defesa.

#### 1.11 Pesos configuráveis das métricas (§18 "configuráveis")

O ranking de **engajamento** é uma **soma ponderada** de sub-sinais. A org configura pesos (`scoring_rules.weight` por bucket) sem código:
- Ex.: `engagement = 5×(check-in) + 3×(conteúdo assistido) + 2×(mensagem em canal) + 1×(login) + 4×(abriu campanha)`.
- UI de "calibração de engajamento": sliders por sinal; preview de como o top-10 mudaria com os novos pesos (simulação sobre o ledger, sem persistir).
- **Edge case — recalibração:** mudar pesos **muda o passado** se aplicado retroativamente. Decisão: pesos afetam **agregação on-read do ranking** (rápido de recalcular) OU exigem rebuild do ranking. Recomendação: guardar pontos por bucket **brutos** no ledger e aplicar pesos **na materialização do ranking** → trocar pesos = rebuild do ranking (job), sem reescrever o ledger. Assim a recalibração é reversível e não corrompe histórico.

---

### 2. Modelo de dados

> Baseado em §25.6 (`achievements`/`member_achievements` já previstos). Marcações: **[novo]** = tabela/coluna nova; **[toca]** = existente do doc que expandimos. Toda tabela carrega `org_id` e RLS por `org_id`.

**Tabelas do doc (§25.6) expandidas:**

`achievements` **[toca]**
- `id` uuid PK, `org_id` FK, `name`, `description`, `icon_url`/`art_url`, `rarity` (common|rare|epic|legendary), `trigger_type` (metric_threshold|event|ranking_position|manual|tier_perk), `criteria` jsonb (`{metric, operator, value}` ou `{event_type, ...}` ou `{ranking_id, max_position}`), `revocable` bool default false, `repeatable` bool default false, `points_reward` int default 0, `unlocks_perk_id` FK nullable, `visible` bool default true, `backfill_on_create` bool, `status` (draft|active|archived), `created_at`, `updated_at`.
- Índices: INDEX(`org_id`, `status`); INDEX(`org_id`, `trigger_type`).

`member_achievements` **[toca]**
- `id` uuid PK, `org_id`, `member_id` FK, `achievement_id` FK, `status` (earned|revoked), `earned_at`, `revoked_at`, `revoke_reason`, `season_id` FK nullable (para repetíveis por temporada), `occurrence_n` int default 1, `source` (auto|manual|backfill|ranking), `featured` bool default false, `source_event_id` (para auditoria), `granted_by` (org_user, se manual).
- Constraints: UNIQUE(`member_id`,`achievement_id`) WHERE `repeatable=false`; UNIQUE(`member_id`,`achievement_id`,`season_id`) para repetíveis sazonais; UNIQUE(`member_id`,`achievement_id`,`occurrence_n`) para repetíveis simples.
- Índices: INDEX(`org_id`,`achievement_id`); INDEX(`member_id`,`status`).

**Tabelas novas [novo]:**

`scoring_rules`
- `id`, `org_id`, `name`, `event_type`, `points` (int ou expressão), `points_expr` jsonb nullable (ex.: `{op:"floor", of:"payload.gross", div: 10}`), `buckets` jsonb (`{"xp": 1.0, "spend": 1.0}` — pesos por bucket), `cap_per_period` jsonb (`{period:"day", max:50}`), `cooldown_seconds` int, `max_count` int nullable, `min_value` numeric nullable, `conditions` jsonb (filtros extras sobre o payload), `season_scope` (all_time|seasonal|both), `status` (active|paused), `valid_from`, `valid_to`, `created_at`, `updated_at`.
- Índice: INDEX(`org_id`,`event_type`,`status`).

`xp_ledger` **(append-only — coração do domínio)**
- `id` uuid PK, `org_id`, `member_id`, `rule_id` FK nullable (nulo p/ crédito manual/badge), `event_type`, `source_event_id` (FK lógico para `interactions`/`transactions`/`checkins`), `points` int (pode ser negativo = estorno), `buckets` jsonb (pontos por bucket creditados), `season_id` FK nullable, `dedupe_key` text, `reason` (event|manual|reversal|backfill|anomaly_adjustment), `actor` (nullable, p/ ajustes manuais), `occurred_at` (tempo do fato real — usado para season e desempate), `created_at`.
- Constraints: UNIQUE(`dedupe_key`) WHERE `dedupe_key IS NOT NULL`. CHECK(`points <> 0`).
- Índices: INDEX(`org_id`,`member_id`,`occurred_at`); INDEX(`season_id`,`member_id`); INDEX(`member_id`,`event_type`,`occurred_at`) (para cap/cooldown/max_count lookups). Particionável por RANGE de `occurred_at` (mensal) em escala.

`member_gamification` **(agregados materializados — 1 linha por membro)**
- `member_id` PK/FK, `org_id`, `xp_total` int, `xp_by_bucket` jsonb (`{engagement, presence, spend}` all-time), `xp_current_season` int, `season_by_bucket` jsonb, `current_season_id`, `level` int (derivado de XP, se houver curva de níveis), `public_display` (opted_out|opted_in_handle|opted_in_full) default opted_out, `handle` text nullable, `featured_badges` int (contagem), `first_reached_at` jsonb (por métrica, p/ tie-break), `ranking_dirty` bool, `updated_at`.
- Índices: INDEX(`org_id`,`xp_total` DESC); INDEX(`org_id`,`current_season_id`,`xp_current_season` DESC); INDEX(`ranking_dirty`) WHERE ranking_dirty; INDEX(`org_id`,`public_display`).

`rankings`
- `id`, `org_id`, `name`, `metric` (xp|engagement|presence|spend|tenure|custom), `bucket` text nullable (qual bucket do ledger usar), `scope` (all_time|seasonal), `season_config` jsonb, `visibility` (public_opt_in|members_only|admin_only), `top_n` int, `tie_breaker` jsonb (cadeia de desempate), `tie_award_policy` (share|resolve), `display_mode` (standard|dense|unique), `eligibility` jsonb (filtro: tier/lifecycle/excluir staff), `min_members_to_show` int, `update_cadence` (incremental|hourly|daily), `status`, `created_at`.

`ranking_entries` **(materialização atual de cada ranking)**
- `ranking_id`, `member_id`, `rank` int, `score` numeric, `score_breakdown` jsonb, `delta` int, `season_id` nullable, `updated_at`. PK(`ranking_id`,`member_id`,`season_id`). INDEX(`ranking_id`,`season_id`,`rank`).

`ranking_snapshots` **(histórico imutável por temporada)**
- `id`, `ranking_id`, `season_id`, `member_id`, `final_rank`, `final_score`, `snapshot_at`. Imutável (sem UPDATE/DELETE). INDEX(`ranking_id`,`season_id`,`final_rank`).

`seasons`
- `id`, `org_id`, `name`, `starts_at`, `ends_at`, `status` (upcoming|active|closing|archived), `cadence` (manual|monthly|quarterly|yearly), `created_at`. INDEX(`org_id`,`status`); UNIQUE(`org_id`,`status`) WHERE status='active' (só uma season ativa por org por trilha — ou por `track` se houver múltiplas).

`gamification_flags` **(anti-gaming / revisão)**
- `id`, `org_id`, `member_id`, `reason` (anomaly|self_referral|velocity|manual), `details` jsonb, `status` (open|confirmed|dismissed), `action_taken` (none|points_reversed|excluded|exempted), `reviewed_by`, `created_at`, `resolved_at`.

`gamification_settings` **(config global por org)**
- `org_id` PK, `xp_enabled` bool, `tier_up_mode` (off|shadow_perks|commercial), `level_curve` jsonb (XP→nível), `hall_of_fame_enabled` bool, `default_public_display` (opted_out), `engagement_weights` jsonb, `transparency_level` (full|partial|hidden).

**Relações-chave:**
- `xp_ledger.source_event_id` → rastreia o fato em `interactions`/`transactions`/`checkins` (auditoria + estorno).
- `member_achievements.unlocks` → entitlement em **tiers-perks** (`entitlements.source='gamification'`).
- `scoring_rules` → consome `event_type` que casam com a timeline do CRM (§11.2) — vocabulário compartilhado de tipos de evento.

**RLS:** todas com `org_id` sob RLS. A **vitrine pública** do Hall of Fame **não** passa por RLS de usuário — Edge Function com role de serviço monta o DTO público aplicando `public_display` e `compactação de opt-outs` em código (espelha o padrão da rota pública de validação §12). `member_gamification.public_display` é a chave do que vaza.

---

### 3. API & Edge Functions

**Endpoints REST `/v1` (admin + dogfooding):**

Rankings:
```
GET    /v1/rankings                       # listar rankings da org
POST   /v1/rankings                       # criar ranking (métrica, scope, visibilidade...)
PATCH  /v1/rankings/{id}                  # editar (pesos/tie-break/visibilidade)
DELETE /v1/rankings/{id}                  # arquivar
GET    /v1/rankings/{id}/entries          # leaderboard materializado (cursor, top-N)
POST   /v1/rankings/{id}/rebuild          # força rematerialização (após recalibrar pesos)
GET    /v1/rankings/{id}/snapshots        # históricos por temporada
```

Achievements/badges:
```
GET    /v1/achievements                   # catálogo da org
POST   /v1/achievements                   # criar badge (+opção backfill retroativo)
PATCH  /v1/achievements/{id}
DELETE /v1/achievements/{id}              # archive
POST   /v1/achievements/{id}/grant        # concessão manual a membro(s)
POST   /v1/achievements/{id}/revoke       # revoga (se revocable)
GET    /v1/members/{memberId}/achievements
```

XP / scoring:
```
GET    /v1/scoring-rules                  POST /v1/scoring-rules   PATCH/DELETE
GET    /v1/members/{memberId}/xp          # XP total/por bucket/temporada + nível
GET    /v1/members/{memberId}/xp/ledger   # extrato (auditoria) — cursor keyset
POST   /v1/members/{memberId}/xp/adjust   # crédito/estorno manual (admin, auditado)
POST   /v1/scoring/simulate               # preview: recalcula top-N com pesos hipotéticos (não persiste)
```

Seasons:
```
GET    /v1/seasons                        POST /v1/seasons
POST   /v1/seasons/{id}/close             # fecha temporada (congela+badges de pódio)
GET    /v1/seasons/{id}/results           # ranking final da temporada
```

Hall of Fame público / membro:
```
GET    /v1/public/hall-of-fame/{org}      # vitrine pública (aplica opt-in/compactação, sem PII de opt-out)
GET    /v1/me/gamification                # área do membro: meu XP, badges, posição real, "quanto falta"
PUT    /v1/me/gamification/display        # membro escolhe opt-in/opt-out e nível (opted_out|handle|full)
```

Anti-gaming:
```
GET    /v1/gamification/flags             # fila de revisão
POST   /v1/gamification/flags/{id}/resolve # confirma/descarta + ação (estorno/exclusão/isenção)
```

Settings:
```
GET    /v1/gamification/settings          PUT /v1/gamification/settings
```

**Edge Functions / Jobs:**
- `gamification_scorer` (worker pgmq, on-event) — consome `gamification_events`/timeline, aplica `scoring_rules` (caps/cooldown/dedupe), grava `xp_ledger`, atualiza `member_gamification`, reavalia achievements + tier-up, marca `ranking_dirty`. **Idempotente por `dedupe_key`.**
- `gamification_ranking_builder` (worker + cron) — materializa `ranking_entries`: incremental p/ membros dirty, reconciliação completa diária, aplica pesos/tie-break/eligibility/compactação.
- `gamification_achievement_evaluator` (on-event + backfill) — checa critérios de threshold/evento/posição; concede `member_achievements` idempotente; dispara perks/XP/push/webhook. Modo backfill ao criar achievement retroativo.
- `gamification_season_closer` (cron) — detecta `ends_at`, congela snapshot, concede badges de pódio, abre próxima season, notifica.
- `gamification_tenure_recalc` (cron diário) — recomputa ranking de antiguidade (puro tempo, sem evento).
- `gamification_anomaly_scan` (cron) — detecta velocity/farm/referral fraud → `gamification_flags`.
- `gamification_reversal` (on-event) — consome `refund.issued`/`chargeback`/no-show → estorna pontos de gasto/presença (linha negativa) + reavalia.
- `gamification_perk_unlock` (on-threshold) — emite entitlement (`source=gamification`) ao cruzar XP/badge → delega materialização ao tiers-perks.

**Idempotência:** scorer e evaluator são idempotentes por chave natural. `xp/adjust` aceita `Idempotency-Key`. Estornos são compensações (nunca delete).

---

### 4. Telas/Front

**Admin (módulo "Hall of Fame" — §10.1 item 9):**
1. **Dashboard de gamificação** — visão geral: rankings ativos, badges mais raros, top membros, temporada atual (tempo restante), flags de anti-gaming pendentes.
2. **Rankings** — CRUD de rankings: escolher métrica, scope (all-time/sazonal), visibilidade, top-N, cadência, eligibility, modo de empate. Preview ao vivo do leaderboard.
3. **Calibração de engajamento** — sliders de pesos por sinal (`<WeightSliders/>`) + **simulação** ("como ficaria o top-10") antes de aplicar (`POST /scoring/simulate`).
4. **Achievements/badges** — CRUD de badges (arte, raridade, critério, repetível, revogável, recompensa XP/perk), toggle "conceder retroativo", **concessão manual** em massa (escolher membros).
5. **Scoring rules** — tabela de regras evento→pontos com caps/cooldown/min_value; editor por tipo de evento.
6. **Seasons** — linha do tempo de temporadas; criar/fechar; ver campeões e snapshots.
7. **Anti-gaming / Flags** — fila de revisão: membro flagrado, evidência, ações (estornar/excluir/isentar).
8. **Extrato de XP do membro** — drill-down de auditoria (acessível também do perfil 360º do CRM).

**Membro (área do membro / Hall of Fame — §24.2):**
1. **Meu progresso** — XP total e da temporada, nível, barra "quanto falta pro próximo nível/badge", badges conquistados (grid com raridade), badges bloqueados ("como destravar").
2. **Hall of Fame (vitrine)** — leaderboard público (só opt-ins), pódio destacado, badges raros em exposição, "campeões da temporada".
3. **Minha posição** — sempre visível ao próprio membro (mesmo opted-out): "Você está em #7 (privado)".
4. **Configuração de privacidade** — toggle de aparição pública (`<PublicDisplayToggle/>`): não aparecer / aparecer com apelido / aparecer com nome+foto.

**Componentes-chave:** `<Leaderboard/>` (virtualizado, com delta/posição/empate), `<BadgeGrid/>`, `<BadgeCard/>` (com raridade/estado earned/locked), `<XPProgress/>`, `<WeightSliders/>`, `<PublicDisplayToggle/>`, `<SeasonTimeline/>`, `<FlagReviewCard/>`, `<HallOfFameShowcase/>` (público temável white-label). Badge pode também aparecer no **passport** (passe Apple/Google reflete badge/tier via push — integra passport).

---

### 5. Integrações externas

O Hall of Fame **não chama serviços externos diretamente**; consome eventos internos e delega efeitos a outros domínios:
- **payments-billing (Asaas)** — `transactions` (gasto), `refund.issued`/`chargeback` (estorno de pontos). Via timeline/eventos, não chamada direta.
- **events-tickets / verification-checkin** — `checkins` alimentam presença; no-show/reentrada tratados na fonte.
- **content-gating** — `content.viewed` alimenta engajamento.
- **community-channels (Discord/Telegram/WhatsApp)** — atividade em canal alimenta engajamento; **badge/role**: um badge pode conceder cargo Discord via perk (delegado ao tiers-perks/integrations).
- **tiers-perks** — saída de XP/badge que destrava perk vira **entitlement** (`source=gamification`); o tiers-perks materializa e sincroniza.
- **passport** — badge/nível pode aparecer no passe (push Apple/Google).
- **communication (§17)** — notificações de badge/temporada/subida de ranking ("você é top 3!"); respeita consentimento por canal.
- **webhooks (§22)** — emite `member.achievement_earned`, `member.ranked_up`, `season.closed`, `member.tier_up_xp`.
- **ai-layer (§19)** — IA pode sugerir badges/regras ("crie um badge para quem foi a 5 eventos"), detectar anomalias de gaming, e usar superfã/Hall of Fame para retenção.
- **MCP (§23)** — expõe "quem são os top-10 do ranking de presença?", "conceda o badge X ao membro B7K2M9X4".
- **Storage** — arte de badges, ícones, avatares de Hall of Fame.

---

### 6. Épicos & tarefas

**Épico A — Modelo de dados & RLS**
- A1. Migrations: `scoring_rules`, `xp_ledger` (append-only + dedupe UNIQUE), `member_gamification`, `rankings`, `ranking_entries`, `ranking_snapshots`, `seasons`, `gamification_flags`, `gamification_settings` — **L**
- A2. Expandir `achievements`/`member_achievements` (§25.6) com colunas/constraints/índices + máquina de estados — **M**
- A3. Políticas RLS por org_id + testes de isolamento; DTO público com role de serviço (sem RLS de usuário) — **M**
- A4. Particionamento de `xp_ledger` por mês + rotina de partição — **S**

**Épico B — Scoring engine (núcleo)**
- B1. Worker `gamification_scorer`: consumo de eventos, dedupe, ledger, agregados incrementais — **L**
- B2. Avaliação de regras: `points_expr`, `min_value`, `conditions`, buckets ponderados — **M**
- B3. Limites anti-gaming: `cap_per_period`, `cooldown`, `max_count` (lookups eficientes no ledger) — **M**
- B4. Estornos reversíveis: consumir refund/chargeback/no-show → linha negativa + reavaliação — **M**
- B5. CRUD `scoring_rules` + UI editor por tipo de evento — **M**

**Épico C — Rankings**
- C1. CRUD `rankings` (métrica, scope, visibilidade, eligibility, cadência) — **M**
- C2. `gamification_ranking_builder`: materialização incremental (dirty) + reconciliação diária — **L**
- C3. Tie-breaking determinístico (cadeia + `first_reached_at`) + modos de exibição (standard/dense/unique) — **M**
- C4. Compactação de opt-outs na vitrine pública (anti-dedução de PII) — **M**
- C5. `tenure_recalc` (ranking por tempo puro) — **S**
- C6. Recalibração de pesos = rebuild + `POST /scoring/simulate` (preview top-N) — **M**
- C7. `<Leaderboard/>` virtualizado + UI de calibração com sliders — **L**

**Épico D — Achievements/badges**
- D1. CRUD `achievements` (arte, raridade, repetível, revogável, recompensa) — **M**
- D2. `gamification_achievement_evaluator`: threshold/evento/posição, concessão idempotente — **L**
- D3. Backfill retroativo ao criar badge ("vale pra trás vs. pra frente") — **M**
- D4. Concessão/revogação manual em massa (admin) + auditoria — **M**
- D5. Badge → perk (entitlement source=gamification) + push passport — **M**
- D6. `<BadgeGrid/>`/`<BadgeCard/>` (earned/locked/raridade) — **M**

**Épico E — XP → perks & tier-up**
- E1. XP destrava perk (entitlement) ao cruzar threshold — **M**
- E2. Tier-up por XP no modo **shadow_perks** (perks sem mudar assinatura) — **M**
- E3. Política de revogação de perks de tier-up por XP ao cair abaixo do limiar — **S**
- E4. Curva de níveis (XP→level) + `<XPProgress/>` — **S**

**Épico F — Seasons & reset sazonal**
- F1. CRUD `seasons` + máquina de estados (upcoming/active/closing/archived) — **M**
- F2. `gamification_season_closer`: congelar snapshot, badges de pódio, abrir próxima, notificar — **L**
- F3. Atribuição de evento por `occurred_at` à season correta (eventos atrasados/offline) — **M**
- F4. `<SeasonTimeline/>` + tela de campeões/snapshots — **M**

**Épico G — Hall of Fame público & privacidade**
- G1. `member_gamification.public_display` + `PUT /me/gamification/display` + `<PublicDisplayToggle/>` — **M**
- G2. `GET /public/hall-of-fame/{org}` (DTO sem PII de opt-out, compactação, white-label) — **M**
- G3. `<HallOfFameShowcase/>` temável + posição privada para o próprio membro — **M**
- G4. Anonimização LGPD remove de vitrines/snapshots públicos — **S**

**Épico H — Anti-gaming**
- H1. `gamification_anomaly_scan` (velocity/farm/referral fraud) → flags — **L**
- H2. Fila de revisão `gamification_flags` + ações (estorno/exclusão/isenção) — **M**
- H3. Referral anti-fraude (conta só pagante, self-referral bloqueado, cap/cooldown) — **M**
- H4. Transparência calibrada (mostrar regras gerais, esconder números de defesa) — **S**

**Épico I — Integrações & eventos**
- I1. Vocabulário compartilhado de `event_type` com a timeline do CRM + produção de eventos — **M**
- I2. Webhooks `member.achievement_earned`/`ranked_up`/`season.closed`/`tier_up_xp` — **S**
- I3. MCP tools (top-N, conceder badge, XP de membro) — **S**
- I4. Notificações (badge/temporada/ranking) via communication respeitando consentimento — **M**

---

### 7. Dependências

- **fundacao** — schema base, org/account, RLS multi-tenant, pgmq/pg_cron (jobs de scoring/ranking/season), Storage (arte de badges). **(Bloqueante.)**
- **member-identity** — `members`/`joined_at` (antiguidade), Member ID por org. **(Bloqueante.)**
- **crm** — timeline `interactions` é o **barramento de eventos** que o scoring engine consome; `engagement_score`/RFM coexistem; perfil 360º exibe XP/badges; vocabulário de `event_type` é compartilhado. **(Bloqueante — sem timeline não há o que pontuar.)**
- **payments-billing** — `transactions` (gasto), refund/chargeback (estorno). **(Forte — necessário p/ ranking de gasto e estornos.)**
- **events-tickets / verification-checkin** — `checkins` (presença). **(Forte p/ ranking de presença; degradável.)**
- **tiers-perks** — saída de XP/badge → entitlement; perk de "Reconhecimento" (§12.2) emite badge; tier-up shadow concede perks do tier. **(Forte — toda "saída" de gamificação vira entitlement aqui.)**
- **content-gating / community-channels** — `content.viewed`/atividade em canal alimentam engajamento. **(Para engajamento completo; degradável.)**
- **communication** — notificações de badge/ranking/temporada, respeitando consentimento. **(Para notificar; não bloqueia o cálculo.)**
- **passport** — badge/nível no passe (push). **(Cosmético; pós-MVP.)**
- **ai-layer** — sugestão de badges/regras, detecção de gaming. **(Pós-MVP; gamificação por regra funciona sem.)**
- **webhooks / public-api / mcp** — expõem rankings/badges. **(Dogfooding; o admin já consome a API.)**
- **security-lgpd** — opt-in público, anonimização, minimização de PII na vitrine. **(Bloqueante para o destaque público ir ao ar.)**
- **observability-qa** — métricas dos jobs (scorer/ranking/season), DLQ, custo de recálculo. **(Operacional.)**
- **design-system / member-app / admin-app** — telas e componentes temáveis. **(Para UI.)**

---

### 8. Riscos & decisões técnicas

- **Ledger append-only é a decisão central**: pontos nunca sofrem UPDATE; estorno = linha negativa. Dá auditoria, reset sazonal por janela (`season_id`/`occurred_at`), reconstrução de agregados e reversibilidade de recalibração. Risco: volume alto → particionar `xp_ledger` por mês; agregar em `member_gamification` (não somar o ledger inteiro on-read).
- **Fonte da verdade é dos outros domínios**: o Hall of Fame **não cria fatos**; observa `interactions`/`transactions`/`checkins`. Evita lógica de presença/gasto duplicada e mantém anti-gaming perto da fonte. Risco: acoplamento ao vocabulário de `event_type` da timeline — mitigar com contrato versionado.
- **Idempotência obrigatória**: retries de webhook/replays não podem creditar duas vezes → `dedupe_key` UNIQUE `(member_id, event_type, source_event_id)`. Scorer e evaluator convergem ao mesmo estado.
- **Ranking não é on-read**: ordenar 100k+ membros a cada page-load é inviável → materializar (`ranking_entries`), incremental por `ranking_dirty` + reconciliação diária. Tenure recalcula por cron (tempo, sem evento).
- **Empate determinístico**: cadeia (métrica → first_reached_at → joined_at → member_id) garante ordem total estável e justa para prêmios (3 vagas = 3 ganhadores). Política `share|resolve` para "empate ganha junto".
- **Privacidade/opt-in (LGPD §26)**: vitrine pública é opt-in default-off; compactação de opt-outs evita re-identificação por dedução; anonimização remove de snapshots públicos; DTO público montado por role de serviço (não RLS). **Bloqueante p/ go-live do destaque público.**
- **Anti-gaming**: caps/cooldown/min_value/dedupe na regra (preventivo) + anomaly scan + flags (reativo) + design (gasto/presença > cliques). Reembolso estorna gasto; no-show não dá presença; referral só pagante. Transparência calibrada (esconder números de defesa).
- **Reset sazonal**: all-time persiste, sazonal zera por `season_id`; eventos atrasados (offline) atribuídos por `occurred_at`; badges sempre permanentes; mudar regras mid-season é injusto → valer a partir da próxima/`valid_from`.
- **XP → tier-up é o ponto mais perigoso**: tier-up comercial real mexe em billing/proração/"1 membership por org" → **recomendação = shadow perks** (perks do tier-alvo via entitlement, sem mudar a assinatura). Confirmar com dono (Open Question, **blocking** se XP-tier-up entrar no MVP).
- **Recalibração de pesos**: pesos aplicados na materialização do ranking (não no ledger) → trocar pesos = rebuild reversível, sem corromper histórico. `simulate` antes de aplicar.
- **Badge retroativo**: criar badge depois de anos exige backfill controlado ("vale pra trás vs. pra frente"); job batelado, não bloquear a criação.
- **Estorno vs. badge permanente (edge case sutil)**: se "R$ 1000 gastos" foi conquistado e depois há reembolso que derruba o gasto abaixo de R$ 1000, o **badge permanece** (uma vez conquistado), mas o **ranking de gasto** reflete o estorno. Manter as duas semânticas separadas (marco permanente vs. métrica viva).

---

### 9. Escopo MVP vs. depois

> Pelo §29, Hall of Fame está na **Fase 5** ("Hall of Fame, gamificação, refinamentos") — **fora do corte do MVP** (Fases 1–2). Os dados que ele consome (timeline, transactions, checkins, joined_at) já existem no MVP, então o domínio é construível assim que priorizado, sem retrabalho de fundação.

**MVP do domínio (quando entrar — fatia mínima de valor):**
- Badges por marco simples (antiguidade, nº de eventos, fundador) — o reconhecimento mais barato e impactante; sem XP, sem temporada.
- 1–2 rankings all-time configuráveis (presença e antiguidade são os menos gameáveis).
- Hall of Fame público opt-in (default-off) com compactação de opt-outs.
- Concessão manual de badge pelo admin (curadoria).
- Estorno básico de pontos no reembolso (se ranking de gasto entrar).
- Materialização de ranking incremental + reconciliação diária; tie-break determinístico.

**Depois:**
- XP/pontos completos com buckets ponderados e calibração de engajamento (sliders + simulate).
- XP → perk (entitlement) e tier-up shadow.
- Reset sazonal (seasons) + badges de pódio + snapshots históricos.
- Anti-gaming avançado (anomaly scan, referral fraud, flags com revisão).
- Badge/nível no passport (push Apple/Google).
- IA sugerindo badges/regras e detectando gaming.
- Curva de níveis e recompensas escalonadas; ranking custom; múltiplas trilhas de temporada.

> **Princípio de faseamento:** começar por **badges + ranking** (reconhecimento puro, baixo risco) e só depois ligar **XP com efeito em perks/tier** (alto valor mas exige anti-gaming e decisão de billing). O destaque público opt-in deve sair junto dos primeiros badges — é o que entrega o "lugar de honra" do §18.
