## 24. Admin App (padronizado da org)

> O **app React do operador**: o painel de controle que **todo dono de membership recebe, idêntico em estrutura** — muda só marca, tema e dados (§10 do doc). Não é "um admin por cliente": é **um produto único**, sólido, rápido, com os **14 módulos** de navegação (§10.1), um **dashboard de métricas** (MRR, churn, distribuição por tier, superfãs/risco, eventos, check-in — §10.2), o **onboarding/wizard "monte seu membership em um dia"**, **ações em massa, busca global, filtros salvos, atalhos de teclado e audit log** (§10.3). Vive em `apps/admin/` (§28.1).
>
> **Princípio que governa este domínio (§10.3, §5, §6.2):** o admin é, em primeiro lugar, um **cliente da plataforma**. Para os **próprios dados da org**, ele usa **`supabase-js` + RLS** (caminho rápido, decisão da fundação §05) — **não** consome `/v1` para tudo. O "dogfooding" (§10.3 "tudo que o admin faz é uma chamada à mesma API pública") se materializa onde **expor uma capacidade pública faz sentido** e onde a Edge detém um segredo (ex.: `POST /v1/passport/issue` precisa do certificado; `POST /v1/subscriptions` precisa do split Asaas). A regra de ouro do `public-api` (§20 1.1) vale aqui: **paridade de capacidades, não chamada 1:1**.
>
> **Fronteira deste documento.** Este domínio é a **casca e o tecido conjuntivo** do operador: shell de navegação, layout, dashboard, onboarding, primitivas transversais de UX (ação em massa, busca global, filtros salvos, atalhos, empty states, gating de UI por permissão, seletor de org). As **telas de detalhe de cada módulo** (a tabela de membros, o editor de tiers, o checkout, o scanner de portaria, o estúdio de campanha…) **pertencem aos respectivos domínios** (`crm`, `tiers-perks`, `payments-billing`, `verification-checkin`, `communication`…). Aqui definimos **onde elas encaixam, como herdam as primitivas comuns, e o que o shell garante** (rota, permissão, contexto de org, telemetria). Quando este doc diz "a tabela de membros", o **conteúdo** é do `crm`; o **comportamento de tabela** (densidade, seleção em massa, filtros salvos, virtualização) é a **primitiva deste domínio** que o `crm` reusa.
>
> **Fronteira com `design-system` e `auth-rbac`.** O `design-system` entrega os **componentes-base e tokens** (botão, input, tabela, modal, toast, `<OrgSwitcher/>`, `<ContextBadge/>`, `<PermissionMatrix/>`, `<StepUpAuthModal/>`). O `auth-rbac` entrega o **modelo de permissão** (`role`, `permissions` jsonb por módulo×ação), o **claim `active_org_id`/`perms`**, o **`POST /v1/context/switch`** e o **hook de permissão**. Este domínio **compõe** essas peças num **app coeso** — ele **consome** o hook de permissão para esconder UI, **consome** o `<OrgSwitcher/>` para trocar contexto, mas **não reimplementa** RBAC nem o design system.

---

### 1. Como funciona

#### 1.1 Anatomia do app — shell, contexto e o ciclo de uma sessão

O admin é uma **SPA React 18 + Vite + React Router + TanStack Query** (stack §6.1). A árvore de alto nível:

```
<AppRoot>                       (providers globais)
 ├─ <SupabaseProvider>          sessão/JWT, refresh, listener de auth
 ├─ <QueryClientProvider>       TanStack Query (cache, retries, devtools)
 ├─ <OrgContextProvider>        active_org_id + brand + perms da org ativa
 ├─ <ThemeProvider>             tokens do design-system + override de marca da org
 ├─ <CommandPaletteProvider>    busca global + atalhos (⌘K)
 ├─ <ToastProvider> / <ConfirmProvider>
 └─ <RouterProvider>
      └─ <AdminShell>           topbar + sidebar + área de conteúdo
           ├─ <Topbar>          OrgSwitcher · ContextBadge · busca global · IA · perfil
           ├─ <Sidebar>         os 14 módulos, filtrados por permissão (§1.5)
           └─ <Outlet>          rota do módulo ativo (lazy-loaded)
```

**Ciclo de uma sessão (fim a fim):**

```
[1] login (auth-rbac: OTP/OAuth) → sessão Supabase com JWT
   ↓
[2] resolve contexto: claim active_org_id presente?
      • 0 orgs        → /onboarding (criar primeira base) — §1.3
      • 1 org         → entra direto nela
      • N orgs        → seletor de org (§1.4) OU última usada (user_preferences.active_org_id)
   ↓
[3] carrega "bootstrap da org": brand (logo/cores/fonts), perms da org ativa,
      flags de onboarding, contadores leves p/ badges da sidebar
   ↓
[4] aplica tema da marca (override de tokens) → pinta o ContextBadge (cor/nome)
   ↓
[5] monta a sidebar FILTRADA por permissão (§1.5) → primeira rota permitida
   ↓
[6] Dashboard (ou wizard se onboarding incompleto) — §1.2 / §1.3
   ↓
[7] navegação: cada rota é um módulo lazy; cada ação registra telemetria + (se mutação) audit
```

> **Regra dura de contexto (edge case mais perigoso do produto — §06 1.5):** **toda** query/mutação carrega o `org_id` ativo. O `OrgContextProvider` é a **única** fonte do contexto no front; nenhum componente lê `org_id` de outro lugar. Trocar de org **invalida todo o cache** do TanStack Query (`queryClient.clear()` ou invalidação por prefixo de `org_id`) para impedir que dados da org A pisquem na org B. Um **`<ContextBadge/>` permanente e colorido** no topbar (cor/nome da org) é **obrigatório** — operar na org errada é o erro mais caro (cancelar membro errado, enviar campanha à base errada).

#### 1.2 Dashboard — máquina de estados e composição de métricas

O Dashboard (§10.2) é a home do operador. **Não é um relatório estático**: é um painel de **cards de métrica + alertas/ações sugeridas pela IA + atalhos**. Estados:

```
        bootstrap
  ┌───────────────────┐
  │ ONBOARDING_INCOMPLETE → mostra o WIZARD embutido (progresso) em vez do dash cheio
  │ EMPTY (org nova, 0 membros) → "estado vazio rico": CTA p/ criar tier, importar base, publicar
  │ LOADING (skeletons por card; cada card carrega independente)
  │ READY (métricas reais; cards interativos)
  │ PARTIAL (alguns cards falharam → card mostra erro/retry, resto funciona)
  └───────────────────┘
```

**Cards do dashboard (cada um é um widget independente, com loading/erro próprios):**

| Card | Métrica (fonte) | Interação |
|---|---|---|
| **MRR / receita recorrente** | `payments-billing` (soma de assinaturas ativas normalizadas a mês) | clique → módulo Receita filtrado |
| **Receita do mês / ticket médio** | `transactions` agregadas no período | toggle de período (mês/trim/ano) |
| **Membros ativos / novos / cancelados / net adds** | `crm`/`member_metrics` | clique → CRM filtrado por lifecycle |
| **Churn** (de membros e de receita) | `crm` + `payments-billing` | série temporal; tooltip por coorte |
| **Distribuição por tier** | `tiers-perks` + contagem de `members` | barra/donut; clique no tier → CRM filtrado |
| **Superfãs / em risco** | `ai-layer` (segmentos vivos churn/engajamento) | clique → segmento aberto no CRM; ação rápida "enviar perk" |
| **Funil** (visitante → membro → upgrade) | `payments-billing` + `crm` | conversões por etapa |
| **Eventos próximos / ingressos vendidos / taxa de check-in** | `events-tickets` + `verification-checkin` | clique → evento |
| **Alertas & ações sugeridas pela IA** | `ai-layer` ("3 membros prestes a cancelar — enviar perk?") | cada alerta tem **CTA acionável** (abre fluxo pré-preenchido) |

> **Decisão de performance (§8):** os números do dashboard **não** são computados a cada load varrendo as tabelas — isso degrada com base grande. Há uma **tabela de snapshot agregado** `org_dashboard_metrics` (uma linha por org, atualizada por `pg_cron`) que o dashboard lê em **1 query**, com fallback de cálculo ao vivo só para o card pedido com "atualizar agora". Séries temporais leem de uma tabela de **rollup diário** `org_metric_daily`. Ver §2.

> **Edge case — período e fuso:** todo agregado respeita o **fuso da org** (`organizations.timezone`) e a **moeda da org**. "Mês" começa no fuso da org, não em UTC. Valores monetários em **centavos inteiros** (alinhado ao contrato do `public-api`).

> **Edge case — gating do próprio dashboard:** o operador só vê os cards dos **módulos que tem permissão de ler**. Um operator de porta (só `validation_checkin`) **não** vê MRR nem churn — vê um dashboard mínimo (eventos/check-in) ou é levado direto à portaria (§1.5).

#### 1.3 Onboarding / Wizard — "monte seu membership em um dia"

O diferencial de UX do produto (§1.1, §10.3). É um **wizard guiado, retomável, com progresso persistido por org** (não no localStorage — se o dono troca de device, retoma de onde parou). Máquina de estados do onboarding:

```
NOT_STARTED → IN_PROGRESS(step k) → COMPLETED   (e/ou DISMISSED — pode pular e voltar depois)
```

**Passos (cada um marca um flag em `org_onboarding`):**

1. **Marca** — logo, cor primária/realce, nome público. (toca `tiers-perks`? não — toca `organizations.brand`, design-system theming.)
2. **Primeiro tier** — cria pelo menos 1 tier (nome, preço, período). (handoff `tiers-perks`.)
3. **Pagamento** — conecta/abre subconta **Asaas** (KYC) para poder receber. (handoff `payments-billing`.) — **passo bloqueante para vender**, mas o wizard deixa avançar e marca "pendente".
4. **Perks/canais** (opcional) — vincula um perk ou um canal (ex.: cargo Discord). (handoff `tiers-perks`/`community-channels`.)
5. **Publicar** — domínio/subdomínio + publicar a página de tiers (handoff `member-app`).
6. **Convidar equipe / primeiro membro** (opcional) — importar base (CSV) ou criar membro manual. (handoff `crm`.)

**Regras concretas do wizard:**
- **Progresso por flag derivado de fatos reais**, não de "clicou em avançar": o passo "primeiro tier" fica ✅ quando existe ≥1 tier publicado, não quando o usuário clicou next. Assim o progresso é **verdadeiro** mesmo se o dono criou o tier por fora do wizard. → o wizard **lê o estado real** (existe tier? existe subconta Asaas? domínio publicado?) e reflete.
- **Retomável e não-bloqueante:** o dono pode fechar e o card "continue seu setup" aparece no dashboard (com % e próximo passo) até `COMPLETED` ou `DISMISSED`.
- **Gating:** o wizard só pede o que o usuário tem permissão de fazer (um admin sem `revenue_billing` não vê o passo de pagamento; o owner sim).
- **IA opcional no wizard:** "descreva sua comunidade" → a IA (`ai-layer`) **sugere** tiers/preços/nomes do vertical (clube de carro, time, creator…) que o dono **revisa e aceita**. Sugere, não cria sozinha (guardrail §19).
- **Estado "pronto para vender":** badge global que só acende quando tier + Asaas + página publicada estão ok. Enquanto não, a área de checkout do membro mostra "em breve".

#### 1.4 Seletor de org (multi-base) — comportamento

Uma **Conta possui N orgs** (decisão imutável §2/§4 do doc); o seletor troca contexto. O **modelo e o endpoint** são do `auth-rbac` (`POST /v1/context/switch`, `user_preferences.active_org_id`); aqui é o **comportamento de UX**:

- **`<OrgSwitcher/>`** no topbar (dropdown) + tela de seleção pós-login se N orgs. Cada item: **logo + cor + nome + papel do usuário naquela org** (evita operar na org errada — §06 1.5).
- **Busca** no switcher (dono com 30 bases não rola lista).
- **"Criar nova base"** no rodapé do switcher → leva ao onboarding de nova org.
- **Troca de org** → chama `context/switch` → **refresh do token** (novo `active_org_id`/`perms`) → **`queryClient.clear()`** → reaplica tema da nova org → recalcula sidebar por permissão → navega para a **rota equivalente** se permitida na nova org, senão para o dashboard (edge: estava em `/eventos` na org A, mas não tem permissão de eventos na org B → cai no dashboard).
- **Indicador de contexto permanente** (`<ContextBadge/>`): cor + nome da org no topbar, sempre visível, inclusive em telas de ação destrutiva (confirmar exclusão mostra "na base **FURIA**").
- **Edge case — papéis diferentes por org:** a mesma pessoa pode ser **owner** na org A e **operator** na org B (§06 1.9). A sidebar e as permissões **recomputam** a cada troca a partir do `perms` do token re-emitido.

#### 1.5 Gating de UI por permissão (esconder módulos e ações)

O RBAC (`auth-rbac` §06 1.7) define `permissions` por **módulo × ação** (`read/write/delete/manage` + ações especiais). Os 14 módulos do menu espelham as chaves: `members, tiers_perks, revenue_billing, events_tickets, content, community_channels, communication, hall_of_fame, ai, integrations, validation_checkin, developers, settings, team` (+ Dashboard, sempre visível para quem tem ≥1 read). **Regras de gating:**

- **Sidebar filtrada:** um módulo só aparece se o usuário tem **`read`** nele. Owner vê tudo (curto-circuito §06 1.7). Operator de porta vê **só** Validação/Portaria (e talvez Dashboard mínimo).
- **Ações escondidas vs. desabilitadas:** botões de **mutação** (criar, editar, excluir, reembolsar, exportar, anonimizar) ficam **escondidos** se falta a ação (não apenas desabilitados — desabilitado vaza a existência da capacidade e gera tickets). Exceção: quando esconder confunde o fluxo, mostra-se **desabilitado com tooltip "sem permissão"**. Decisão por caso, default = esconder.
- **Hook único:** `useCan(module, action, scope?)` lê o `perms` do contexto (claim) — **mesma função** que o `auth-rbac` expõe; o front **nunca** decide permissão por conta própria. UI gating é **conveniência**; a **autorização real** é no backend (RLS + Edge revalidam — §06 1.6). Esconder o botão **não** é segurança; é UX.
- **Escopo de operator a evento** (§06 1.10): um operator escopado a `event_ids` só vê/age naqueles eventos no módulo de check-in. O `useCan` aceita `scope`.
- **Rota protegida:** acessar `/comunicacao` por URL sem `communication:read` → **403 amigável** ("você não tem acesso a este módulo · falar com o owner"), não tela em branco.
- **Edge case — permissão revogada durante a sessão:** se o owner remove uma permissão enquanto o admin está logado, o token só reflete no **próximo refresh** (TTL). O backend já barra (RLS/Edge). O front trata o `403` da API **revalidando o token** (force refresh) e, se persistir, esconde a UI e avisa. (Origem do gap: claim cacheado — §06 1.6.)

#### 1.6 Primitivas transversais de UX (o que este domínio "dá" a todos os módulos)

Estas são **bibliotecas de comportamento** reusadas por todas as telas de módulo. Definidas aqui, consumidas pelos domínios de negócio.

**(a) Busca global / Command palette (⌘K):**
- Abre com `⌘K`/`Ctrl+K`. **Dois modos:** (i) **busca de dados** (membros por nome/email/Member ID, eventos, tiers, transações) e (ii) **navegação/comandos** ("ir para Receita", "criar tier", "nova campanha").
- **Busca de dados é federada e debounced:** dispara para os endpoints de busca dos domínios (`crm` é o mais pesado). Resultados agrupados por tipo, com **deep-link** direto ao registro.
- **Member ID:** digitar `B7K2M9X4` (ou `b7k2-m9x4`) resolve direto ao membro (normaliza upper/sem separador — §7.5). Atalho de ouro do porteiro/suporte.
- **Edge case — escopo de org:** a busca **só** retorna registros da **org ativa** (nunca cross-org, mesmo para quem tem N bases). Performance: cada provider de busca tem seu índice (ver `crm` para `pg_trgm`/full-text de membros).
- **Permissão:** a palette só lista comandos/resultados de módulos que o usuário pode ver.

**(b) Ações em massa (bulk):**
- Em qualquer lista (membros, transações, eventos…): seleção múltipla (checkbox, shift-click range, "selecionar todos os N que casam o filtro" — **não só a página visível**).
- **Ações:** mudar tag, mover de segmento, mudar tier (com proração — `payments-billing`), enviar mensagem ao conjunto (`communication`), exportar (CSV), cancelar/anonimizar (LGPD, com step-up). Cada domínio registra **quais** ações em massa expõe; o **mecanismo** (seleção, confirmação, execução assíncrona, progresso, undo) é desta camada.
- **Execução assíncrona para conjuntos grandes:** "aplicar a 12.430 membros" **não** roda no browser nem numa request síncrona — vira um **job** (`pgmq`/Edge) com **barra de progresso**, **resultado parcial** (X ok, Y falharam, baixar relatório de erros) e **idempotência** (não duplica se reenviar). Conjuntos pequenos (<N, ex. 200) podem rodar síncrono.
- **Confirmação proporcional ao risco:** ação destrutiva em massa (cancelar 500 memberships) exige **digitar o número** ou step-up; ação leve (taggear) confirma simples.
- **Audit:** toda ação em massa gera **um** `audit_log` com o critério (filtro/ids) + contagem + resultado.
- **Edge case — "selecionar todos os que casam o filtro" muda entre seleção e execução:** congela-se o **critério** (o filtro), não a lista de ids no momento do clique; o job reavalia no momento de executar e **registra** o snapshot de quem foi afetado.

**(c) Filtros salvos & visões:**
- Qualquer lista permite **salvar um conjunto de filtros** com nome ("Camarote inadimplentes"), **compartilhar com a equipe** (escopo: pessoal/org) e **fixar** como aba. Persistido server-side (`saved_views`) para seguir o usuário entre devices.
- **Filtros como estado de URL** (querystring) — compartilhável por link, com botão "salvar esta visão".
- **Edge case:** uma visão salva referenciando um **tier/segmento deletado** degrada graciosamente (mostra "filtro inválido, ajustar"), não quebra a tela.

**(d) Atalhos de teclado:**
- Globais: `⌘K` (palette), `g d` (dashboard), `g m` (membros), `g r` (receita), `?` (cheatsheet de atalhos), `c` (criar — contextual ao módulo), `/` (focar busca), `esc` (fechar modal/limpar seleção).
- Em listas: `j/k` navega linhas, `x` seleciona, `enter` abre.
- **Conflito com inputs:** atalhos de letra única desativados quando o foco está em campo de texto.
- Discoverable: `?` abre cheatsheet; cada ação no menu mostra seu atalho.

**(e) Listas grandes (performance):**
- **Virtualização** (TanStack Virtual) para tabelas de dezenas de milhares de linhas — DOM só renderiza o viewport.
- **Paginação por cursor** ao buscar (espelha o contrato do `public-api` quando via API; via `supabase-js`, keyset por `(created_at,id)`).
- **Colunas configuráveis** (mostrar/ocultar/reordenar, densidade) persistidas por usuário.
- **Skeletons** por linha; **carregamento incremental** (infinite scroll ou "carregar mais"); **contagem total** é **opt-in** (count é caro em multi-tenant — alinhado ao `public-api` §1.5).
- **Edge case — filtro que retorna 200k linhas:** nunca materializa tudo; export vira **job** com arquivo gerado e link, não download síncrono.

**(f) Empty states ricos:** toda lista/módulo tem um estado vazio **acionável** (ilustração + 1-2 CTAs + link de doc), distinto de "carregando" e de "filtro sem resultado" (este oferece "limpar filtro").

**(g) Audit log (visualização):** o **registro** de auditoria é gerado por cada domínio (`audit_logs` §25.6, escrita no backend). Este domínio entrega a **tela de visualização** (Configurações → Auditoria): timeline filtrável por ator/ação/módulo/período, com diff quando aplicável, e **deep-link ao recurso**. (Ver §06 também grava auditoria de equipe/permissão.)

#### 1.7 Responsividade e formfactor

- **Desktop-first** (o operador trabalha em tela grande), mas **responsivo até tablet/celular** para 3 fluxos críticos que acontecem em movimento: **portaria/check-in** (já há app/rota dedicada — `verification-checkin`), **consultar um membro** (suporte no telefone) e **aprovar/disparar** alertas da IA. Em telas estreitas: sidebar vira drawer, tabelas viram cards, ações em massa simplificam.
- **Portaria** especialmente: a rota de validação/check-in é **mobile-first** (one-hand, scanner) — é um subset do admin com login que cai **direto** na portaria se o usuário só tem escopo operator (§06 1.5, §1.5 acima).

#### 1.8 Dogfooding — o que o admin consome via `/v1` vs. `supabase-js`

Materializando o princípio (§10.3):

| Caminho | Quando | Exemplos |
|---|---|---|
| **`supabase-js` + RLS** (rápido, padrão) | Leitura/escrita dos **próprios dados** da org, listas, filtros, dashboard | listar membros, editar perfil, ler métricas, salvar visão, ler audit |
| **`/v1` (Edge Function)** | Quando há **segredo no servidor** ou **lógica financeira/transacional** que não pode rodar no client | `POST /v1/passport/issue` (certificado), `POST /v1/subscriptions` (split Asaas + idempotência), `POST /v1/checkin`, `POST /v1/ai/*` (LLM key), emitir/rotacionar API key |

> O resultado: **paridade de capacidades garantida** (toda capacidade do admin existe na API — gate de paridade do `public-api` §20 A5), **sem** pagar o custo de latência de roteirizar leitura trivial pela Edge. O admin é o **primeiro cliente** da API onde isso importa, não um proxy cego.

---

### 2. Modelo de dados

> A maior parte dos dados do admin **pertence aos outros domínios**. Este domínio adiciona o que é **específico da experiência do operador**: preferências de UI, visões salvas, estado de onboarding, e os **agregados pré-computados** que o dashboard lê para não varrer tabelas grandes a cada load. Tudo com `org_id` + RLS (exceto preferências que são por usuário).

#### 2.1 Tabelas novas

**`org_onboarding`** (estado do wizard por org)
| Coluna | Tipo | Notas |
|---|---|---|
| `org_id` | uuid PK FK→organizations | 1:1 com a org |
| `status` | text | `not_started`/`in_progress`/`completed`/`dismissed` (CHECK) |
| `steps` | jsonb | `{ brand:bool, first_tier:bool, payments:bool, perks:bool, publish:bool, team:bool }` — **derivado de fatos reais** (§1.3) |
| `dismissed_at` | timestamptz null | |
| `completed_at` | timestamptz null | |
| `updated_at` | timestamptz | |

> Os flags são **recalculados** por triggers/checagem (existe tier? subconta Asaas ativa? domínio publicado?) — não confiam só no clique. RLS por `org_id`.

**`saved_views`** (filtros salvos / visões por módulo)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK NOT NULL | RLS |
| `module` | text | `members`/`transactions`/`events`/… |
| `name` | text | "Camarote inadimplentes" |
| `filters` | jsonb | critério serializado (mesmo schema dos filtros da lista) |
| `columns` | jsonb null | colunas/ordem/densidade preferidas p/ esta visão |
| `scope` | text | `personal`/`org` (compartilhada com a equipe) |
| `created_by` | uuid FK→auth.users | |
| `is_pinned` | bool | aparece como aba |
| `created_at`/`updated_at` | timestamptz | INDEX(`org_id`,`module`,`scope`) |

**`user_preferences`** (existe/expandida — `auth-rbac` já cria com `active_org_id`/`last_org_id`)
| Coluna | Tipo | Notas |
|---|---|---|
| `user_id` | uuid PK | |
| `active_org_id`/`last_org_id` | uuid | (de auth-rbac) |
| `ui` | jsonb | densidade de tabela, colunas por módulo, tema claro/escuro do admin, idioma (pt-BR/en-US/es), atalhos custom |
| `dismissed_hints` | jsonb | tooltips/coachmarks já vistos (não repetir) |

> Por **usuário**, não por org (segue a pessoa entre bases). Sem RLS por org; RLS por `user_id`.

**`org_dashboard_metrics`** (snapshot agregado p/ o dashboard ler em 1 query — §1.2)
| Coluna | Tipo | Notas |
|---|---|---|
| `org_id` | uuid PK | 1 linha por org |
| `mrr` | bigint | centavos |
| `revenue_mtd` | bigint | receita no mês corrente |
| `avg_ticket` | bigint | |
| `members_active`/`members_new_mtd`/`members_churned_mtd`/`net_adds_mtd` | int | |
| `churn_rate` / `revenue_churn_rate` | numeric | |
| `tier_distribution` | jsonb | `{ tier_id: count }` |
| `superfans_count`/`at_risk_count` | int | (de ai-layer) |
| `upcoming_events` | jsonb | resumo dos próximos eventos |
| `tickets_sold_mtd`/`checkin_rate` | int/numeric | |
| `computed_at` | timestamptz | "atualizado há X" na UI |

> Atualizada por `pg_cron` (ex.: a cada 15min, ou disparada por evento crítico). O dashboard lê **esta** linha; "atualizar agora" recomputa o card pedido ao vivo. RLS por `org_id`.

**`org_metric_daily`** (rollup diário p/ séries temporais do dashboard)
| Coluna | Tipo | Notas |
|---|---|---|
| `org_id` | uuid | |
| `day` | date | |
| `mrr`/`revenue`/`new_members`/`churned`/`active`/`tickets`/`checkins` | numeric/int | |
| | | PK(`org_id`,`day`); INDEX(`org_id`,`day desc`) |

> `audit_logs` (§25.6) é **lido** aqui (tela de auditoria) — não criado por este domínio.

#### 2.2 Constraints / invariantes
- `org_onboarding`: 1:1 com org (PK = `org_id`). Triggers de "fato real" mantêm `steps` em dia.
- `saved_views`: visão `scope='org'` exige ator com permissão de gerir visões compartilhadas; `personal` é livre. UNIQUE(`org_id`,`module`,`name`,`created_by`) p/ `personal`.
- `org_dashboard_metrics`/`org_metric_daily`: nunca fonte de verdade financeira (são **cache**); relatórios fiscais leem `transactions` direto (`payments-billing`).
- RLS em tudo com `org_id`; `user_preferences` por `user_id`.

#### 2.3 Índices quentes
- `saved_views(org_id, module, scope)` — carregar visões da lista atual.
- `org_metric_daily(org_id, day desc)` — séries do dashboard.
- `org_dashboard_metrics(org_id)` PK — leitura única do dashboard.

---

### 3. API & Edge Functions

> O admin **consome** sobretudo os endpoints dos **outros domínios** (CRM, tiers, billing, etc.) e o `supabase-js`. Os endpoints/functions **próprios** deste domínio são os da **experiência do operador**: bootstrap, dashboard agregado, onboarding, visões salvas, busca global, jobs de ação em massa.

#### 3.1 Endpoints próprios (`/v1`)

```
# Bootstrap / contexto do admin (1 chamada que hidrata o shell)
GET    /v1/admin/bootstrap            # brand + perms + onboarding status + flags + badges de sidebar
GET    /v1/admin/dashboard            # lê org_dashboard_metrics (1 query) + alertas IA
GET    /v1/admin/dashboard/series     # séries de org_metric_daily (período, métrica)
POST   /v1/admin/dashboard/refresh    # recomputa um card ao vivo (sob demanda)

# Onboarding / wizard
GET    /v1/admin/onboarding           # estado dos passos (derivado de fatos reais)
POST   /v1/admin/onboarding/dismiss   # esconder o wizard (continua retomável)
POST   /v1/admin/onboarding/suggest   # IA sugere tiers/preços do vertical (rascunho)

# Visões salvas / preferências
GET    /v1/admin/views?module=        # visões salvas do módulo (pessoais + da org)
POST   /v1/admin/views                # criar visão (filtros+colunas)
PATCH  /v1/admin/views/{id}           # editar/renomear/fixar
DELETE /v1/admin/views/{id}
PATCH  /v1/admin/preferences          # ui prefs (densidade, colunas, idioma, tema)

# Busca global federada
GET    /v1/admin/search?q=&types=     # busca multi-recurso escopada à org ativa

# Ações em massa (assíncronas)
POST   /v1/admin/bulk                 # cria job (action, criterio/filtro OU ids, params) → job_id
GET    /v1/admin/bulk/{jobId}         # progresso/resultado parcial (X ok, Y erro)
GET    /v1/admin/bulk/{jobId}/errors  # relatório de erros (CSV/JSON)
```

> O **conteúdo** de `search` e `bulk` para cada tipo de recurso é delegado ao domínio dono (CRM resolve `members`, events-tickets resolve `events`…). Este domínio orquestra (fan-out, agregação, job runner). A maioria das **leituras** do admin **não** passa por `/v1` (usa `supabase-js`+RLS); estes endpoints existem onde há agregação/segredo/job.

#### 3.2 Edge Functions / Jobs

| Function / Job | Tipo | Descrição |
|---|---|---|
| `admin-bootstrap` | Edge | hidrata o shell numa chamada (brand, perms, onboarding, contadores de badge) — evita N requests no load |
| `admin-search` | Edge | fan-out federado aos providers de busca dos domínios; agrega; escopa à org; respeita permissão |
| `bulk-runner` | Edge + pgmq | enfileira ação em massa; processa em lotes idempotentes; reporta progresso; escreve 1 audit |
| `dashboard-refresh` | Edge | recomputa um card ao vivo (quando o dono clica "atualizar") |
| `metrics-rollup` | **pg_cron** | recalcula `org_dashboard_metrics` (15min) e fecha `org_metric_daily` (diário, no fuso da org) |
| `onboarding-recompute` | trigger/Edge | reavalia `org_onboarding.steps` a partir de fatos (tier criado, Asaas ativo, domínio publicado) |
| `onboarding-suggest` | Edge | chama LLM (`ai-layer`) → rascunho de tiers/preços do vertical (sugere, não cria) |

---

### 4. Telas/Front

> Telas do **operador**. As de **detalhe de módulo** pertencem aos domínios; aqui ficam o **shell**, o **dashboard**, o **onboarding** e as **telas de configuração de UX** próprias do admin.

**Shell (`apps/admin`):**
- **`<AdminShell>`** — topbar (`<OrgSwitcher/>` + `<ContextBadge/>` + busca global + ícone IA/copilot + menu de perfil/conta) · `<Sidebar>` (14 módulos filtrados por permissão, com badges de contagem) · área de conteúdo com breadcrumbs.
- **`<CommandPalette>`** (⌘K) — busca de dados + comandos de navegação/criação.
- **`<KeyboardShortcutsSheet>`** (`?`) — cheatsheet.
- **`<NotFound/>`** e **`<ModuleForbidden/>`** (403 amigável por falta de permissão).

**Dashboard:**
- **`<DashboardGrid>`** com cards independentes: `<MrrCard/>`, `<RevenueCard/>`, `<MembersCard/>`, `<ChurnCard/>`, `<TierDistributionCard/>`, `<SuperfansAtRiskCard/>`, `<FunnelCard/>`, `<EventsCheckinCard/>`, `<AiAlertsCard/>` (cada alerta com CTA acionável).
- `<MetricCardSkeleton/>` / `<MetricCardError/>` (retry por card) / `<DashboardEmptyState/>` (org nova).

**Onboarding:**
- **`<OnboardingWizard/>`** (stepper retomável) + `<OnboardingChecklistCard/>` no dashboard (% + próximo passo) + `<ReadyToSellBadge/>`.
- `<AiTierSuggestion/>` (descreve a comunidade → sugestões revisáveis).

**Primitivas reusadas pelos módulos (entregues por este domínio, sobre o design-system):**
- **`<DataTable/>`** (virtualizada, colunas configuráveis, densidade, seleção em massa, filtros, paginação cursor).
- **`<BulkActionBar/>`** (aparece ao selecionar; "selecionar todos que casam o filtro"; ações registradas por módulo).
- **`<BulkJobProgress/>`** (modal/toast com barra, parcial, relatório de erro).
- **`<SavedViewsBar/>`** (abas de visões + salvar/compartilhar/fixar).
- **`<FilterBuilder/>`** (filtros por campo/atributo; estado em URL).
- **`<EmptyState/>`** (acionável) e **`<FilterEmptyState/>`** ("limpar filtro").
- **`<ConfirmDestructive/>`** (proporcional ao risco; digitar nº / step-up).
- **`<ExportButton/>`** (síncrono p/ pequeno, job p/ grande).
- **`<AuditLogTimeline/>`** (Configurações → Auditoria; filtros, diff, deep-link).

**Ações principais do operador:** trocar de org · completar onboarding · ler/atualizar dashboard · buscar globalmente · aplicar/salvar filtros · executar ação em massa · navegar pelos 14 módulos · ver auditoria · ajustar preferências (idioma, densidade, tema).

---

### 5. Integrações externas

| Serviço | Como integra (neste domínio) |
|---|---|
| **Supabase (Auth/Postgres/RLS/Realtime)** | Sessão/JWT, leitura/escrita direta com RLS (caminho rápido), **Realtime** para badges/contadores do dashboard e progresso de jobs em massa ao vivo. |
| **Supabase Edge Functions** | `/v1/admin/*` (bootstrap, dashboard agregado, busca federada, bulk runner) e os endpoints com segredo (passport/subscriptions) que o admin dispara. |
| **pg_cron / pgmq** | `metrics-rollup` (agregados do dashboard) e `bulk-runner` (ações em massa assíncronas). |
| **LLM (Claude, via ai-layer)** | Alertas/ações sugeridas no dashboard e sugestão de tiers no onboarding — **sugere, humano confirma** (§19). |
| **Asaas (via payments-billing)** | O passo de onboarding "pagamento" abre/checa a subconta/KYC; o badge "pronto para vender" depende disso. |
| **Provedor de e-mail (communication)** | Convites de equipe e avisos disparados do admin reusam o transacional. |

> Este domínio **não** integra direto com PSP/Wallet/Discord — ele **orquestra** os domínios que o fazem. As únicas integrações "próprias" são Supabase (dados/Realtime) e os jobs.

---

### 6. Épicos & tarefas

#### Épico A — Shell do admin, contexto de org e tema
- A1. Esqueleto `apps/admin` (Vite + Router + TanStack Query + providers) + `<AdminShell>` (topbar/sidebar/outlet) + roteamento lazy por módulo. **(L)**
- A2. `OrgContextProvider` (única fonte de `org_id`/brand/perms) + integração `<OrgSwitcher/>`/`<ContextBadge/>` do design-system + `context/switch` (auth-rbac). **(M)**
- A3. **Invalidação total de cache na troca de org** (`queryClient.clear()` por contexto) + reaplicar tema da marca + recomputar sidebar/rota equivalente. **(M)**
- A4. `admin-bootstrap` (Edge) + `<AdminShell>` hidratado em 1 chamada (brand, perms, onboarding, badges). **(M)**
- A5. Estados globais: `<NotFound/>`, `<ModuleForbidden/>` (403 amigável), boundary de erro por rota. **(S)**

#### Épico B — Gating de UI por permissão
- B1. Hook `useCan(module, action, scope?)` lendo `perms`/scope do claim (consome o modelo de `auth-rbac`). **(S)**
- B2. **Sidebar filtrada por permissão** (módulo some sem `read`) + rotas protegidas (403 amigável). **(M)**
- B3. **Esconder vs. desabilitar** ações de mutação (default esconder; tooltip "sem permissão" por exceção) — padrão reusável `<Gated/>`. **(M)**
- B4. Tratamento de **403 da API com permissão revogada em sessão** (force refresh de token → reesconde UI). **(S)**
- B5. Escopo de **operator a evento** refletido no gating de check-in. **(S)**

#### Épico C — Dashboard & métricas
- C1. Migrations `org_dashboard_metrics` + `org_metric_daily` + RLS. **(M)**
- C2. `metrics-rollup` (pg_cron): MRR, churn, net adds, distribuição por tier, tickets/check-in, no **fuso/moeda da org**. **(L)**
- C3. `GET /v1/admin/dashboard` + `/series` + `/refresh` (lê snapshot, série, recomputa card). **(M)**
- C4. `<DashboardGrid>` + cards independentes (loading/erro/retry por card) + estados EMPTY/ONBOARDING/PARTIAL. **(L)**
- C5. `<AiAlertsCard/>` com **CTAs acionáveis** (abre fluxo pré-preenchido — handoff ai-layer/communication). **(M)**
- C6. Gating do dashboard por permissão (operator vê dashboard mínimo). **(S)**

#### Épico D — Onboarding / Wizard "monte em um dia"
- D1. Migration `org_onboarding` + `onboarding-recompute` (flags por **fato real**). **(M)**
- D2. `<OnboardingWizard/>` (stepper retomável, não-bloqueante) + `<OnboardingChecklistCard/>` no dashboard. **(L)**
- D3. Passos integrados: marca, primeiro tier, pagamento (Asaas/KYC), perks/canais, publicar, equipe/import — handoffs aos domínios. **(L)**
- D4. `<ReadyToSellBadge/>` (tier + Asaas + página publicada) + estado "em breve" no checkout enquanto não. **(M)**
- D5. `onboarding-suggest` (IA sugere tiers/preços do vertical) + `<AiTierSuggestion/>` (revisável). **(M)**

#### Épico E — Primitivas transversais de UX (reusadas por todos os módulos)
- E1. `<DataTable/>` virtualizada (TanStack Virtual): colunas configuráveis/densidade persistidas, skeletons, paginação cursor/keyset, contagem opt-in. **(L)**
- E2. Seleção em massa + `<BulkActionBar/>` ("selecionar todos que casam o filtro", congela **critério** não ids). **(M)**
- E3. `bulk-runner` (pgmq/Edge): lotes idempotentes, progresso, parcial, relatório de erros, **1 audit** + `<BulkJobProgress/>` (Realtime). **(L)**
- E4. **Filtros salvos**: `saved_views` + `<SavedViewsBar/>` + `<FilterBuilder/>` (estado em URL, pessoal/org, fixar). **(L)**
- E5. **Confirmação destrutiva proporcional** (`<ConfirmDestructive/>` com digitar-nº / step-up) + export síncrono vs. job. **(M)**
- E6. Empty states ricos (`<EmptyState/>` acionável + `<FilterEmptyState/>`). **(S)**

#### Épico F — Busca global & atalhos
- F1. `admin-search` (Edge): fan-out federado aos providers dos domínios, agregação, **escopo à org**, respeita permissão. **(L)**
- F2. `<CommandPalette>` (⌘K): busca de dados (inclui resolução por Member ID) + comandos de navegação/criação. **(M)**
- F3. Sistema de **atalhos de teclado** global + por lista (j/k/x/enter) + cheatsheet `?` + anti-conflito com inputs. **(M)**

#### Épico G — Audit log (visualização) & preferências
- G1. `<AuditLogTimeline/>` (Configurações → Auditoria): filtros por ator/ação/módulo/período, diff, deep-link (lê `audit_logs`). **(M)**
- G2. `user_preferences.ui` + `PATCH /v1/admin/preferences` (densidade, colunas, idioma pt-BR/en-US/es, tema) + i18n do shell. **(M)**

#### Épico H — Responsividade & portaria
- H1. Layout responsivo do shell (sidebar→drawer, tabelas→cards) para tablet/celular nos fluxos críticos. **(M)**
- H2. **Entrada direta na portaria** para usuário só-operator (sem seletor completo) — costura com `verification-checkin`. **(S)**

**Esforço agregado do domínio: XL** — é um app inteiro (shell, dashboard, onboarding, 14 módulos costurados, e as primitivas de UX que todos os outros domínios reusam). Grande parte do **valor** está nas primitivas transversais (E, F) que aceleram todos os domínios de tela.

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **design-system** | Componentes-base, tokens, theming, e os já-especificados `<OrgSwitcher/>`/`<ContextBadge/>`/`<PermissionMatrix/>`/`<StepUpAuthModal/>`. O admin **compõe**, não recria. **Bloqueante.** |
| **auth-rbac** | Modelo de permissão (módulo×ação), claims `active_org_id`/`perms`/`org_ids`, `context/switch`, `user_preferences`, step-up auth, seletor de org. O gating de UI e o seletor **dependem** disso. **Bloqueante.** |
| **fundacao** | Infra de Edge `_shared` (auth/erros/idempotência/rate-limit/logger), `v1-router`, pgmq/pg_cron, RLS multi-tenant, monorepo `apps/admin`. **Bloqueante.** |
| **public-api** | Disciplina de contrato (envelope, cursor, idempotência, DTO) que os endpoints `/v1/admin/*` e o dogfooding seguem; gate de paridade. |
| **crm** | Maior consumidor: tabela de membros, busca, segmentos, lifecycle, ações em massa de membro, perfil 360º (conteúdo das telas). |
| **tiers-perks** | Onboarding (primeiro tier), distribuição por tier no dashboard, ação em massa "mudar tier". |
| **payments-billing** | MRR/churn de receita/ticket no dashboard, passo "pagamento" do onboarding (Asaas/KYC), badge "pronto para vender", ações financeiras em massa. |
| **events-tickets** + **verification-checkin** | Cards de eventos/ingressos/check-in no dashboard; entrada direta na portaria para operator; busca de eventos. |
| **ai-layer** | Alertas/ações sugeridas no dashboard, segmentos superfã/em-risco, sugestão de tiers no onboarding, copilot no topbar. |
| **communication** | CTAs do dashboard ("enviar perk"), ação em massa "enviar mensagem ao conjunto", convites de equipe. |
| **content-gating, community-channels, hall-of-fame, integrations-framework, webhooks, mcp** | Cada um fornece o **conteúdo** do seu módulo na navegação; o admin fornece o shell, as primitivas e a posição na sidebar. |
| **observability-qa** | Telemetria de uso do admin, alertas de erro de carga de card, logs estruturados. |

**É dependência de:** praticamente todos os domínios **de tela do operador** consomem as primitivas (`<DataTable/>`, bulk, filtros salvos, busca, empty states) e a casca (shell/sidebar/gating). O **member-app** é irmão (mesmo design-system/contrato), não dependente.

> **Posição no cronograma:** o **shell mínimo + gating + dashboard básico** nascem na **Fase 1** (§29 — "Admin padronizado: org, tiers & perks, membros/CRM"), porque sem casca não há onde plugar os módulos. As **primitivas ricas** (bulk assíncrono, filtros salvos, busca federada, virtualização) e o **onboarding completo** maturam ao longo das Fases 1–2 conforme os módulos chegam. O **dashboard com IA** depende da Fase 3.

---

### 8. Riscos & decisões técnicas

**Decisões técnicas tomadas:**
1. **`OrgContextProvider` é a única fonte de `org_id`** no front; troca de org **limpa o cache** inteiro e re-emite token. `<ContextBadge/>` permanente.
2. **Gating de UI ≠ segurança:** esconder botão é UX; a autorização real é RLS + Edge. `useCan` é conveniência.
3. **Default = esconder** ação sem permissão (não desabilitar), salvo onde confunde o fluxo (então desabilita com tooltip).
4. **Dashboard lê snapshot agregado** (`org_dashboard_metrics`) em 1 query, não varre tabelas; séries de `org_metric_daily`; "atualizar agora" recomputa sob demanda.
5. **Ação em massa grande = job assíncrono** (pgmq) com progresso/parcial/idempotência/1 audit; congela o **critério**, não a lista de ids.
6. **Onboarding por fato real:** os passos refletem o estado verdadeiro (existe tier? Asaas ativo? publicado?), não o clique.
7. **Listas grandes = virtualização + cursor**; contagem total opt-in; export grande = job.
8. **Admin usa `supabase-js`+RLS para leitura** (rápido) e `/v1` só onde há segredo/lógica financeira (dogfooding seletivo).
9. **i18n** pt-BR/en-US/es no shell (decisão do doc §30.5).

**Riscos & edge cases:**
- **Operar na org errada** (multi-base) → ação destrutiva na base errada. Mitigação: ContextBadge permanente, cache limpo na troca, confirmação destrutiva mostra o nome da org.
- **Cache piscando dado da org A na org B** após troca → vazamento visual. Mitigação: `queryClient.clear()` + chaves de query prefixadas por `org_id`.
- **Permissão revogada durante a sessão** → UI mostra botão que a API recusa (403). Mitigação: tratar 403 com force-refresh do token e reesconder; backend é a verdade.
- **Dashboard lento/incorreto com base grande** → varredura a cada load. Mitigação: snapshot agregado + rollup por cron; nunca usar o snapshot como verdade fiscal.
- **Ação em massa que "trava o browser"** (50k linhas) ou roda parcial e some → estado inconsistente. Mitigação: job idempotente, progresso, relatório de erros, retomável.
- **"Selecionar todos os que casam o filtro" muda entre clicar e executar** → afeta registros diferentes do esperado. Mitigação: congelar o **critério**, reavaliar no job, registrar snapshot dos afetados no audit.
- **Filtro salvo referenciando tier/segmento deletado** → tela quebra. Mitigação: degradação graciosa ("filtro inválido, ajustar").
- **Busca global vazando cross-org** (dono com N bases) → PII de outra base. Mitigação: escopo rígido à org ativa em todo provider de busca.
- **Empty state confundido com erro/carregando** → dono acha que quebrou. Mitigação: três estados distintos (vazio acionável / carregando / filtro-sem-resultado).
- **Onboarding "mente"** (marca passo ✅ sem o fato) → dono acha que pode vender e não pode. Mitigação: flags derivados de fatos reais + badge "pronto para vender" gated por Asaas+tier+publicação.
- **Operator de porta vendo dashboard financeiro** → vazamento de MRR a quem não deve. Mitigação: gating do dashboard por permissão; operator cai direto na portaria.
- **Card de IA com CTA que executa ação real sem confirmação** → disparo indevido. Mitigação: CTA abre fluxo **pré-preenchido** que exige confirmação humana (guardrail §19).
- **Skeleton de dashboard "infinito"** se um card depende de domínio ainda não pronto → percepção de app travado. Mitigação: cards independentes; um card pode falhar/ocultar sem travar o resto (estado PARTIAL).

---

### 9. Escopo MVP vs. depois

**No MVP** (Fase 1 do §29 — "admin padronizado: org, tiers & perks, membros/CRM"; o admin é **pré-requisito** de tudo que o operador faz):
- **Shell completo**: `<AdminShell>` (topbar/sidebar/outlet), **seletor de org + ContextBadge + troca de contexto com limpeza de cache**, roteamento lazy dos módulos disponíveis no MVP, 403/404 amigáveis. (Épico A.)
- **Gating de UI por permissão** (sidebar filtrada, esconder ações, rotas protegidas, operator→portaria). (Épico B.)
- **Dashboard básico**: cards de MRR, membros ativos/novos/cancelados/churn, distribuição por tier, eventos/check-in — lendo snapshot agregado + rollup por cron. (Épico C parcial; **IA alerts** entram na Fase 3.)
- **Onboarding/wizard "monte em um dia"** retomável por fato real (marca, primeiro tier, pagamento Asaas, publicar) + badge "pronto para vender". (Épico D; **sugestão de tiers por IA** na Fase 3.)
- **Primitivas essenciais**: `<DataTable/>` virtualizada, **busca global (⌘K)** com Member ID, **filtros salvos**, **ações em massa** (síncrono p/ pequeno, job p/ grande), confirmação destrutiva, empty states, atalhos básicos. (Épicos E e F — núcleo.)
- **Audit log (visualização)** mínimo + preferências (densidade, idioma pt-BR no MVP). (Épico G parcial.)
- **Responsividade** dos fluxos críticos (portaria, consultar membro). (Épico H parcial.)

**Depois do MVP:**
- **Card de IA no dashboard** (alertas/ações sugeridas) + **copilot no topbar** + **sugestão de tiers no onboarding** — depende de `ai-layer` (Fase 3).
- **Busca federada rica** (todos os tipos de recurso, ranking, recências) e **command palette com ações** completas.
- **Filtros salvos compartilhados/abas fixas**, colunas configuráveis avançadas, **cargos/templates de permissão** (quando `auth-rbac` entregar).
- **Bulk avançado** (mais ações por domínio, agendamento de ação em massa, undo).
- **i18n en-US/es** completo no shell (§30.5).
- **Dashboards customizáveis** (arrastar/reordenar cards, métricas por widget) e **export agendado** de relatórios.
- **Responsividade plena** de todos os módulos (não só os críticos) e avaliação de **app nativo** do operador (§30.2 — fora da v0).

> **Resumo:** o **shell + gating + dashboard básico + onboarding + primitivas de lista/busca/bulk** são **MVP duro** (sem eles, nenhum módulo tem onde viver). O **inteligência de IA no painel**, **dashboards customizáveis**, **i18n completo** e **bulk/filtros avançados** são incrementos pós-MVP.
