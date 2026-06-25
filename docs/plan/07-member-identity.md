## 07. Identidade do Membro & Member ID

> Domínio que define **o que é um membro**, como ele nasce, vive e morre na plataforma, e o contrato de identidade (o **Member ID** de 8 caracteres) que atravessa Passport, validação pública, CRM, billing e API. É a "espinha dorsal" relacional: quase todo outro domínio aponta para `members.member_id`.

Fonte de verdade: STANBASE.md §7 (Member ID), §4 (glossário — `Member`, `Customer`, `Conta`, `Org`), §11.3 (lifecycle stages), §25.2 (modelo de dados), §2 (1 membership por org, Conta com N orgs), §30 (decisões).

Decisões já imutáveis assumidas aqui:
- Member ID = 8 chars, padrão **L-N-L-N-L-N-L-N** (alterna letra/dígito), alfabeto **sem ambíguos** (`I O 0 1`), **sem dígito verificador**, **UNIQUE global** na Stanbase.
- IDs **nunca são reutilizados** após cancelamento.
- 1 membership por org; uma **pessoa** em N orgs = N `members` = N Member IDs = N passes.
- Member = relação **pessoa × org**. Customer (CRM) = visão 360º da mesma relação (não duplica registro — é a mesma `members` + tabelas satélite).

---

### 1. Como funciona

#### 1.1 Conceitos e separação de identidade

Três identidades distintas coexistem e **não devem ser confundidas**:

| Conceito | O que é | Escopo | Tabela base |
|---|---|---|---|
| **Person / Pessoa** | O ser humano real, único na Stanbase (idealmente reconhecido por e-mail/telefone/auth) | Global (cross-org) | `persons` (nova) |
| **Auth user** | A credencial de login (Supabase Auth) | Global; pode não existir (membro importado sem login) | `auth.users` (Supabase) |
| **Member** | A relação **pessoa × org** — a "carteirinha". Carrega o **Member ID** | Por org | `members` |
| **Customer (CRM)** | A visão 360º do member (perfil, métricas, timeline) | Por org | satélites de `members` |

Regra de ouro: **Member ID identifica o `members` (pessoa×org), não a pessoa.** Uma pessoa em 3 orgs tem 3 Member IDs. Isso é decisão de produto (§7.6), não bug.

A camada `persons` é o **eixo cross-org** que permite: (a) "esta pessoa é membro de quantas comunidades?", (b) merge de duplicados, (c) reconciliar importado-sem-login com o auth user criado depois. **Sem `persons`, não há como ligar o mesmo CPF/e-mail em duas orgs** — e isso é necessário para o app de membro mostrar "minhas memberships".

> Nota de privacidade (LGPD): `persons` é cross-org, então **não pode** carregar dados que vazem entre tenants. Ela guarda apenas chaves de reconciliação (e-mail hash, phone hash, auth_user_id) — nunca PII rica nem nada visível por RLS de outra org. PII rica fica em `member_profiles` (por org, isolada por RLS).

#### 1.2 Geração do Member ID (algoritmo definitivo)

Alfabetos (STANBASE.md §7.2):
- `LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"` → 24 letras (sem `I`, `O`).
- `DIGITS  = "23456789"` → 8 dígitos (sem `0`, `1`).
- Padrão posicional: índices pares (0,2,4,6) = letra; ímpares (1,3,5,7) = dígito.
- Capacidade: 24⁴ × 8⁴ = **1.358.954.496** (~1,36 bi).

Fluxo passo a passo:
1. Sortear 8 posições com **CSPRNG** (`crypto.getRandomValues`), respeitando o padrão L-N.
2. Normalizar para **uppercase** (o gerador já produz upper, mas a normalização é defensiva).
3. Checar **blocklist** (§1.4). Se bater, descartar e re-sortear (não conta como colisão de unicidade).
4. Tentar inserir com **constraint UNIQUE global**. Em colisão (violação de unique), **retry com backoff** (re-sortear inteiro, não incrementar). Máx. `N=7` tentativas.
5. Se estourar `N` tentativas → erro `MEMBER_ID_GENERATION_EXHAUSTED` (alerta de observabilidade; sinaliza saturação do espaço ou bug). Em ~1,36 bi de espaço, 7 retries só falham com o espaço quase cheio.

Onde gera: a geração é **server-side autoritativa** — feita em Postgres (função `gen_member_id()` + trigger/RPC) OU na Edge Function `POST /v1/members`. **Decisão recomendada: gerar no banco** (função `SECURITY DEFINER` que sorteia e insere numa transação), porque:
- elimina a janela de corrida entre "gerei no app" e "inseri" (a checagem de unicidade e a inserção são atômicas);
- garante que **todo** caminho de criação (API, admin via PostgREST, import, webhook de pagamento que cria membro) use o mesmo gerador. Nada cria membro sem passar pelo gerador canônico.

> ⚠️ CSPRNG no Postgres: `gen_random_bytes()` (pgcrypto) é CSPRNG e atende. Evitar `random()` (não-cripto, previsível) — anti-enumeração depende de IDs imprevisíveis (§9.3 do doc: "IDs não sequenciais ... dificultam varredura").

#### 1.3 Unicidade global e retry de colisão

- A unicidade é **global na Stanbase**, não por org (§7.1: "a rota pública resolve qualquer ID sem ambiguidade entre orgs"). Logo o índice UNIQUE é em `members.member_id` **sem** `org_id` na chave.
- Probabilidade de colisão segue o paradoxo do aniversário: com ~36k IDs emitidos, p(colisão na próxima inserção) ≈ 36k/1,36bi ≈ 0,0026%. Retry resolve trivialmente em escala MVP. A política de N=7 retries é folga enorme.
- O retry **re-sorteia o ID inteiro** (não muta um char), preservando aleatoriedade uniforme.

#### 1.4 Blocklist

- Mesmo alternando letra/dígito, combinações podem formar palavras ofensivas/infelizes (ex.: sequências que viram palavrões com leetspeak, marcas registradas, termos sensíveis). Decisão: **blocklist curta** mantida pela Stanbase (global), não editável por org.
- Estratégia: blocklist por **substring/padrão** (regex e lista exata) avaliada no momento da geração, antes da inserção. Tabela `member_id_blocklist` (global). Ex.: bloquear se contém substring de uma lista de termos (considerando substituições óbvias `5→S`, `3→E`, `4→A`, `8→B`).
- Custo: a blocklist remove uma fração desprezível do espaço; não afeta capacidade.
- Vandalismo reverso: a blocklist também serve para **reservar prefixos** institucionais se um dia quisermos (ex.: nunca emitir IDs que pareçam comandos do sistema). MVP: só a lista de ofensivos.

#### 1.5 Normalização e exibição

- **Armazenamento:** sempre **uppercase**, sem separador, 8 chars contíguos. Coluna `member_id CHAR(8)` (ou `text` com check de tamanho/charset).
- **Input do usuário (digitação/busca):** normalizar antes de comparar — `upper()`, **remover separadores** (` `, `-`, `·`, `.`), e mapear ambíguos digitados por engano: `I→1`? **Não** — como `0/1/I/O` nunca existem em IDs válidos, o comportamento é: se o usuário digitar `O`, tratamos como `0` que é inválido → "ID inexistente". Decisão recomendada (UX): **auto-corrigir o input** mapeando `O→0`? Não. Em vez disso, **rejeitar caracteres fora do alfabeto** com mensagem clara, mas oferecer correção sugerida quando o erro é óbvio (digitou `I` provavelmente quis dizer nada — só avisar). Ver openQuestion sobre auto-correção.
- **Exibição (telas, passport, e-mail):** agrupar visualmente em dois blocos de 4: `B7K2 · M9X4` ou `B7K2-M9X4` (STANBASE.md §7.5). O separador é **só visual**; nunca persiste, nunca entra em URL canônica.
- **URL de validação:** `verify.stanbase.com/{memberId}` usa a forma contígua uppercase. Aceitar variações com separador/lowercase via redirect 301 para a canônica.
- Constraint de banco: `CHECK (member_id ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ][2-9][ABCDEFGHJKLMNPQRSTUVWXYZ][2-9][ABCDEFGHJKLMNPQRSTUVWXYZ][2-9][ABCDEFGHJKLMNPQRSTUVWXYZ][2-9]$')` — garante padrão L-N e alfabeto no nível do banco.

#### 1.6 Ciclo de vida do membro — máquina de estados

Estados (alinhados a §11.3 "lead → membro → ativo → em risco → cancelado → reativado", refinados para implementação):

| Estado (`members.status`) | Significado | Tem membership paga ativa? | Tem entitlements? | Member ID emitido? |
|---|---|---|---|---|
| `lead` | Pessoa capturada (importada, formulário, free) ainda sem assinatura paga | Não | Não (ou só free) | **Sim** (já tem ID desde a criação) |
| `pending` | Checkout iniciado, aguardando 1º pagamento confirmar | Pendente | Não | Sim |
| `active` | Membership vigente e em dia | Sim | Sim | Sim |
| `past_due` | Inadimplente, dentro do grace period (acesso ainda liberado) | Sim (em atraso) | Sim (ainda) | Sim |
| `suspended` | Grace estourou; acesso revogado mas relação ainda recuperável | Não | Revogados | Sim |
| `canceled` | Cancelado (pelo membro, admin ou fim de plano parcelado sem recompra) | Não | Revogados | Sim (preservado) |
| `reactivated` | Estado transitório/flag após voltar de canceled/suspended | Sim | Reconcedidos | **Mesmo ID** (não gera novo) |

> Decisão de produto importante: **`reactivated` não é um estado terminal distinto de `active`** — é semanticamente "está `active` de novo, mas já foi cancelado antes". Recomenda-se modelar `status='active'` + flag/derivado `was_reactivated` ou simplesmente inferir pela timeline, em vez de um estado próprio que complica a máquina. (Ver openQuestion.) Abaixo trato `reactivated` como transição que aterrissa em `active`.

`engagement`/`em risco` (churn) **não** é estado de lifecycle de membership — é um **score** (`member_metrics.churn_score`) do domínio CRM/IA. Não polui esta máquina de estados. "Em risco" = `active` com churn_score alto. Manter separado evita acoplar billing a heurística de IA.

Transições válidas:

```
                ┌────────────────────────────────────────────────┐
                ▼                                                │
 (criação) → lead ──checkout──> pending ──pagto ok──> active     │
                │                  │                    │  ▲      │
                │                  │ pagto falha        │  │ pagto recobra (dentro grace)
                │                  ▼                    ▼  │      │
                │               canceled           past_due       │
                │  (lead nunca pagou,                  │          │
                │   admin arquiva)                     │ grace expira
                ▼                                      ▼          │
            canceled <───────cancel/fim parcelado─── suspended    │
                │                                      │          │
                │ recompra / readmissão                │ paga pendência
                └──────────────► active ◄──────────────┘──────────┘
                       (reativação: MESMO Member ID)
```

Regras de negócio concretas das transições:
- **lead → pending:** dispara no início do checkout (`POST /v1/subscriptions`). Member ID já existe desde `lead`.
- **pending → active:** webhook Asaas `payment_confirmed`/`payment_received` do 1º pagamento. Concede entitlements (domínio tiers-perks), emite/atualiza Passport, dispara `member.activated`.
- **active → past_due:** webhook Asaas `payment_overdue`/`payment_failed`. Inicia grace period (configurável por org, §13.4). Acesso **mantido** durante grace.
- **past_due → active:** pagamento recuperado (dunning) dentro do grace.
- **past_due → suspended:** grace period expira sem pagamento. Revoga entitlements, atualiza Passport (push), remove cargos Discord etc.
- **suspended → active:** membro paga pendência. Reconcede entitlements. **Mesmo Member ID.**
- **active/past_due/suspended → canceled:** cancelamento explícito (membro/admin) ou fim natural de plano parcelado/único sem recompra. Para parcelado (sem auto-renew, §13.3.2): ao fim do período de acesso, vai para `canceled`.
- **canceled → active (reativação):** membro recompra ou admin readmite. **Reusa o mesmo Member ID** (§7.6 "IDs nunca são reutilizados após cancelamento" — interpretação: o ID **não é dado a outra pessoa**; quando a *mesma* pessoa volta, ela **reusa o ID dela**, preservando histórico). **Esta é a decisão central de reativação.** Ver §1.7 e openQuestion.

Cada transição: (1) grava `interactions` (timeline CRM); (2) escreve `audit_logs`; (3) emite webhook de saída correspondente (`member.created`, `member.activated`, `member.tier_changed`, `member.past_due`, `member.suspended`, `member.churned`, `member.reactivated`); (4) enfileira jobs de side-effect (Passport push, sync de canais/entitlements) via pgmq.

#### 1.7 Vínculo Member ↔ Auth user ↔ Customer

- **Member ↔ Auth user:** `members.user_id` (FK opcional para `auth.users`). **Opcional** porque existe membro **sem login** (importado). Quando a pessoa cria conta, faz-se o **claim/link** (§1.8).
- **Member ↔ Customer (CRM):** **não há tabela separada de customer.** Customer = o conjunto `members` + `member_profiles` + `member_metrics` + `interactions` + `entitlements` para aquele member. O "registro vivo por pessoa" do §11.5 é a agregação por `member_id`. Não duplicar.
- **Member ↔ Person:** `members.person_id` (FK para `persons`). É o que liga os N members da mesma pessoa entre orgs.

#### 1.8 Edge case — importado sem login que depois cria conta (claim)

Cenário: org importa CSV com 2.000 membros (e-mail/telefone, sem senha). Cada um vira `members` com `user_id = NULL`, `status='lead'` ou `active` (se a importação trouxe membership). Member IDs já gerados. Depois, "João" clica em "entrar", faz login social/OTP com o **mesmo e-mail**.

Fluxo de reconciliação (claim):
1. Auth cria/retorna `auth.users` para João (novo `auth_user_id`).
2. Pós-login, job/trigger procura `persons` por `email_hash`/`phone_hash` que casem.
3. Se achar uma `person` órfã (sem `auth_user_id`) → **vincula** `auth_user_id` à `person` e propaga: todos os `members` daquela person que tinham `user_id = NULL` recebem `user_id`. Member IDs **inalterados**.
4. Se não achar → cria `person` nova ligada ao `auth_user_id`. (João é genuinamente novo.)
5. Conflito: já existe `person` com **outro** `auth_user_id` para o mesmo e-mail → caso de duplicata → fila de merge (§1.9). Não auto-mesclar cegamente (risco de account takeover por e-mail reusado).

Matching: por **e-mail normalizado** (lower, trim; tratar `+alias` do Gmail? recomendar **não** colapsar aliases por padrão — gera falso-positivo de merge) e **telefone E.164**. Verificação: claim só vincula automaticamente se o canal foi **verificado** (OTP no e-mail/telefone que está logando). E-mail não verificado → claim manual com revisão (anti-takeover).

#### 1.9 Edge case — merge de duplicados

Cenário: a mesma pessoa virou 2 `members` na **mesma org** (importou com e-mail X, depois se cadastrou com e-mail Y; ou dois cadastros manuais). Ou duas `persons` que são a mesma pessoa.

Regras de merge:
- **Dois members na mesma org → merge:** escolher um **survivor** (regra padrão: o de membership ativa; empate → o mais antigo `joined_at`; empate → o com Passport emitido). O **Member ID do survivor é preservado**; o ID do perdedor é **aposentado** (marcado `merged_into`, nunca reemitido a terceiros). Histórico (interactions, notes, transactions, entitlements, tickets, checkins) é **reapontado** para o survivor. O perdedor vira `members.status='merged'` com `merged_into_member_id` apontando para o survivor (tombstone — preserva auditoria e permite "este ID foi mesclado em B7K2M9X4").
- **Passport:** os passes do perdedor são **revogados/atualizados** apontando para o survivor (push), evitando duas carteirinhas ativas da mesma pessoa na mesma org.
- **Billing:** assinaturas/transações do perdedor reapontadas; **nunca** mesclar duas assinaturas pagas ativas sem revisão humana (risco de cobrança dupla / perda de receita). Merge com 2 subs ativas → flag para resolução manual.
- **Duas persons (cross-org):** merge no nível de `persons` re-liga os `members` de ambas para a person survivor; cada Member ID por org segue intacto. Só colapsa em conflito se as duas persons forem membros **da mesma org** (vira o caso acima).
- **Reversibilidade:** merge é **soft** (tombstone + ponteiros) por janela de X dias para permitir desfazer, depois consolida. (Ver openQuestion sobre reversibilidade.)

#### 1.10 Edge case — membro sem e-mail

§11.1 lista e-mail como contato, mas porteiro pode cadastrar alguém só com nome (lead de evento). Decisão: **e-mail não é obrigatório** para criar `members`. Implicações:
- `member_profiles.email` é nullable. Identidade mínima viável: **Member ID + nome** (ou nem nome — Member ID é a PK funcional).
- Sem e-mail e sem telefone → **não há chave de reconciliação** → essa person não participa de claim/merge automático (fica "ilha"). Aceitável: porteiro depois coleta contato e aí entra na reconciliação.
- Login: sem e-mail/telefone, a pessoa **não consegue logar** por OTP. Caminhos: (a) admin adiciona contato depois; (b) login social (Google/Apple/X) cria o e-mail no claim. Passport funciona offline via link mágico do pass mesmo sem login.
- Comunicação: membro sem canal não recebe campanhas — sinalizar no CRM ("sem canal de contato").

#### 1.11 Edge case — reativação reusa ID ou gera novo

**Decisão recomendada (e default): a mesma pessoa que reativa REUSA o mesmo Member ID.** Justificativa fiel ao doc: §7.6 "IDs nunca são reutilizados" combinado com "mantêm histórico e validação" — o objetivo é **preservar o histórico** e a carteirinha. Gerar novo ID quebraria QR de passe antigo, links de validação compartilhados, e a continuidade do CRM/LTV. Logo: reativação = `canceled → active` no **mesmo** `members` row, **mesmo** `member_id`. O Passport antigo é re-emitido/atualizado (mesmo serial ou novo serial sob o mesmo Member ID).

O ID **só** é "novo" quando é **outra pessoa** ou **nova relação pessoa×org** que nunca existiu. Reativação nunca cria nova relação — recupera a existente.

(Há uma leitura alternativa onde "não reutilizar" = cada ciclo de membership ganha ID novo. Marcada como openQuestion **blocking** porque muda schema e UX de validação.)

---

### 2. Modelo de dados

Todas as tabelas de domínio carregam `org_id` e têm RLS, **exceto** as cross-org explicitamente globais (`persons`, `member_id_blocklist`), que têm RLS própria restritiva (service-role/edge only).

#### 2.1 Tabelas novas / centrais

**`persons`** (NOVA — eixo cross-org de identidade) — *sem `org_id`, global*
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `auth_user_id` | uuid NULL UNIQUE | FK `auth.users`; NULL para importado sem login |
| `email_hash` | bytea NULL | hash determinístico (HMAC c/ pepper) do e-mail normalizado — chave de reconciliação sem expor PII cross-org |
| `phone_hash` | bytea NULL | idem para telefone E.164 |
| `merged_into_person_id` | uuid NULL | tombstone de merge cross-org |
| `created_at` | timestamptz | |
- Índices: UNIQUE parcial em `email_hash` WHERE `email_hash IS NOT NULL` (mas ver merge — não pode ser UNIQUE hard se quisermos tolerar duplicata temporária; usar índice **não-único** + processo de merge). Índice em `phone_hash`, em `auth_user_id`.
- RLS: **negar tudo** para roles de org; acesso só via Edge Function (service role). Evita vazamento cross-tenant.

**`members`** (TOCADA — §25.2) — *com `org_id`, RLS*
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | chave interna |
| `member_id` | char(8) | **UNIQUE global**, NOT NULL, CHECK do padrão/alfabeto |
| `org_id` | uuid | FK `organizations`, RLS |
| `person_id` | uuid | **NOVA** FK `persons` |
| `user_id` | uuid NULL | FK `auth.users` — NULL se sem login (redundante com person.auth_user_id mas conveniente para RLS rápida) |
| `tier_id` | uuid NULL | FK `tiers` |
| `status` | enum `member_status` | lead/pending/active/past_due/suspended/canceled/merged |
| `joined_at` | timestamptz | "membro desde" |
| `source` | text | origem (import, checkout, manual, api, event) |
| `merged_into_member_id` | char(8) NULL | **NOVA** tombstone; aponta survivor |
| `reactivated_at` | timestamptz NULL | **NOVA** última reativação (deriva "was_reactivated") |
| `created_at` / `updated_at` | timestamptz | |
- Índices: **`UNIQUE (member_id)` global** (sem org_id). Índice `(org_id, status)` para filtros do CRM. Índice `(person_id)`. Índice `(org_id, user_id)`. Índice em `merged_into_member_id`.
- Constraints: `CHECK (member_id ~ '<regex L-N>')`; `UNIQUE (org_id, person_id) WHERE status <> 'merged'` → **garante 1 membership por org por pessoa** (decisão §2/§4). Tombstones (`merged`) excluídos do unique para permitir o perdedor coexistir.

**`member_profiles`** (TOCADA) — *com `org_id` via member, RLS*
- `member_id` (FK), `name` NULL, `photo_url` NULL, `email` NULL, `phone` NULL, `social` jsonb, `attributes` jsonb. E-mail/phone **nullable** (§1.10). Índice de busca trigram em `name`, `email`.

**`member_id_blocklist`** (NOVA — global)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `pattern` | text | substring ou regex |
| `kind` | enum (exact/substring/regex) | |
| `reason` | text | ofensivo/reservado |
- RLS: leitura só service-role. Consultada pelo gerador.

**`member_status_history`** (NOVA — auditoria de máquina de estados) — *com `org_id`, RLS*
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `member_id` | char(8) FK | |
| `from_status` / `to_status` | enum | |
| `reason` | text | (payment_failed, grace_expired, manual_cancel, reactivation, merge…) |
| `actor` | text | system/user_id/operator |
| `occurred_at` | timestamptz | |
- Espelha em `interactions` para a timeline, mas esta é a fonte canônica para reconstruir transições.

#### 2.2 Tipos / enums
```sql
CREATE TYPE member_status AS ENUM
  ('lead','pending','active','past_due','suspended','canceled','merged');
```

#### 2.3 Função geradora (canônica, no banco)
- `gen_member_id() RETURNS char(8)` — SECURITY DEFINER; usa `gen_random_bytes` (pgcrypto), monta L-N, checa `member_id_blocklist`, retorna candidato (sem inserir).
- `create_member(p_org_id, p_person_id, ...) RETURNS members` — loop de até 7 tentativas: gera candidato, INSERT, captura `unique_violation`, re-tenta; emite evento. **Único ponto de criação de members.**
- Trigger `BEFORE INSERT ON members`: se `member_id IS NULL`, recusa (força uso de `create_member`) OU preenche via gerador — decidir: recomendado **trigger preenche** para cobrir inserts via PostgREST do admin, com a mesma proteção de retry feita em loop no app quando vier por edge function.

#### 2.4 Relações (resumo)
```
persons (global) 1───N members (por org) 1───1 member_profiles
                                          1───1 member_metrics  (CRM)
                                          1───N interactions    (CRM timeline)
                                          1───N entitlements    (tiers-perks)
                                          1───N passes          (passport)
                                          1───N subscriptions   (billing)
auth.users 1───0..N members (via user_id)  e  1───0..1 persons (via auth_user_id)
members.merged_into_member_id ──► members.member_id (tombstone)
```

---

### 3. API & Edge Functions

#### 3.1 Endpoints REST `/v1` (já previstos em §21.2, detalhados aqui)
| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/v1/members` | Cria member (chama `create_member` → gera Member ID). Idempotente via `Idempotency-Key`. |
| `GET` | `/v1/members` | Lista/filtra/segmenta (por status, tier, tags). Paginação por cursor. |
| `GET` | `/v1/members/{memberId}` | Detalhe 360º (resolve por Member ID normalizado). |
| `PATCH` | `/v1/members/{memberId}` | Atualiza perfil/atributos/contatos. |
| `DELETE` | `/v1/members/{memberId}` | Cancela/anonimiza (LGPD) — não apaga o ID (tombstone). |
| `GET` | `/v1/members/{memberId}/timeline` | Timeline de interações. |
| `POST` | `/v1/members/{memberId}/transition` | (NOVO) Transição de estado explícita (cancel/reactivate/suspend) com validação da máquina. |
| `POST` | `/v1/members/{memberId}/reactivate` | (NOVO) Reativa preservando ID. |
| `POST` | `/v1/members/merge` | (NOVO) Mescla dois members (survivor/loser), com dry-run. |
| `POST` | `/v1/members/import` | (NOVO) Importa CSV → cria members sem login (gera IDs em lote). |
| `GET` | `/v1/members/lookup?email=&phone=` | (NOVO) Reconciliação/busca por contato (interno/admin). |
| `GET` | `/v1/me/memberships` | (NOVO, app de membro) Lista todos os members/IDs da pessoa logada (cross-org). |

#### 3.2 Edge Functions / Jobs
| Tipo | Nome | Descrição |
|---|---|---|
| Function | `member-create` | Wrapper de `create_member` com retry, blocklist, eventos, idempotência. |
| Function | `member-claim` | Pós-login: reconcilia `auth_user_id` com `persons`/`members` órfãos (§1.8). |
| Function | `member-merge` | Executa merge (reaponta histórico, tombstone, revoga passes do loser). Dry-run + apply. |
| Function | `member-transition` | Aplica transição de status validando a máquina; dispara side-effects. |
| Function | `member-import` | Processa CSV em lote (gera IDs, cria persons/members, dedup interno do arquivo). |
| Job (cron) | `lifecycle-grace-sweep` | Varre `past_due` cujo grace expirou → `suspended` (pg_cron). |
| Job (cron) | `lifecycle-parcelado-expiry` | Plano parcelado sem auto-renew chegou ao fim do acesso → `canceled`. |
| Trigger | `on_member_status_change` | Grava `member_status_history`, enfileira pgmq (passport/canais/webhooks). |
| Trigger | `on_auth_user_created` | Dispara `member-claim` (reconciliação). |

> Eventos de webhook de saída emitidos: `member.created`, `member.activated`, `member.tier_changed`, `member.past_due`, `member.suspended`, `member.churned` (canceled), `member.reactivated`, `member.merged`. (Domínio webhooks consome.)

---

### 4. Telas / Front

#### 4.1 Admin (org)
- **Lista de Membros / CRM** (§11.4 — kanban por lifecycle, tabela, cards): coluna/badge de **status** (lead/active/past_due/suspended/canceled), **Member ID** exibido agrupado (`B7K2 · M9X4`) com botão copiar e link "abrir validação pública". Filtros por status/tier/tag.
- **Perfil 360º do membro:** header com Member ID (copiável, formatado), foto, nome, status, "membro desde"; abas: Visão geral, Timeline, Financeiro, Entitlements, Notas/Tarefas, **Identidade** (auth vinculado? sim/não; person cross-org: "também membro de N outras bases" — só se a Conta tiver visibilidade; contatos verificados).
- **Ação Reativar:** botão em member `canceled` → modal confirma "reusar mesmo ID B7K2M9X4 e restaurar histórico" → chama `/reactivate`.
- **Ação Cancelar:** com motivo; mostra impacto (revoga entitlements, atualiza passport).
- **Merge de duplicados:** tela de "Possíveis duplicados" (lista sugerida por e-mail/telefone/nome), com **diff lado-a-lado** (qual ID sobrevive, o que será reapontado), **dry-run** antes de aplicar, e aviso forte se houver 2 assinaturas ativas.
- **Importar CSV:** wizard (mapear colunas → preview de dedup interno → confirmar). Mostra quantos IDs serão gerados.
- **Configuração de status/grace:** (compartilhada com billing) grace period por org.

#### 4.2 Membro (front hosted / app)
- **Carteirinha (Member Card):** Member ID em destaque, formatado, com QR (token assinado — domínio passport). Componente `<MemberCard/>` do SDK.
- **"Minhas memberships":** se a pessoa é membro de várias orgs, lista os passes/IDs (`/v1/me/memberships`). Cada org com sua marca.
- **Perfil/contatos:** editar nome, foto, contatos (alimenta reconciliação/comunicação).
- **Reativar:** se membership cancelada, CTA "Voltar a ser membro" (recompra → reusa ID).

#### 4.3 Componentes/utilitários compartilhados (design-system / sdk-js)
- `formatMemberId(id)` → `B7K2 · M9X4`. `normalizeMemberId(input)` → upper, strip separadores, valida charset.
- `<MemberIdBadge/>` (copiável), `<MemberStatusBadge/>`, `<VerifyBadge/>` (já citado no §24.3).

---

### 5. Integrações externas

| Serviço | Como integra com este domínio |
|---|---|
| **Supabase Auth** | Fonte de `auth.users`; trigger `on_auth_user_created` dispara claim. OAuth (Google/Apple/X) e OTP definem os contatos verificados usados na reconciliação. |
| **Asaas (PSP)** | Webhooks de pagamento dirigem transições `pending→active`, `active→past_due`, etc. Não cria Member ID, mas o pagamento confirmado pode ativar um lead. |
| **Apple/Google Wallet (Passport)** | Consome `member_id`; passes são re-emitidos em reativação e revogados/reapontados em merge/cancel. Este domínio publica eventos; passport reage. |
| **Discord/Telegram/WhatsApp (canais)** | Transições de status disparam atribuição/remoção de cargos (suspended/canceled removem acesso). |
| **Provedor de e-mail/OTP** | Verificação de e-mail/telefone para reconciliação segura (anti-takeover). |
| **LLM (IA-layer)** | Consome member para churn score, mas não é dependência **deste** domínio (a máquina de estados não depende de IA). |

Nenhuma integração externa **gera** o Member ID — geração é 100% interna (CSPRNG no banco). Isso é requisito de segurança/anti-enumeração.

---

### 6. Épicos & tarefas

**Épico A — Geração e contrato do Member ID** *(núcleo, bloqueia quase tudo)*
- A1. Migration: enum `member_status`, tabela `members` (colunas novas), `member_profiles` nullable, CHECK do padrão L-N. **(M)**
- A2. `pgcrypto`; função `gen_member_id()` com alfabeto sem ambíguos via `gen_random_bytes`. **(S)**
- A3. Tabela `member_id_blocklist` + checagem na geração + seed inicial de termos. **(S)**
- A4. `create_member()` com loop de retry (N=7), unique global, idempotência. **(M)**
- A5. Trigger `BEFORE INSERT` que garante geração canônica em qualquer caminho (PostgREST/edge). **(S)**
- A6. Testes: unicidade sob concorrência (inserts paralelos), distribuição de charset, retry, blocklist, regex. **(M)**
- A7. Utils front/SDK: `formatMemberId`, `normalizeMemberId`, validador. **(S)**

**Épico B — Camada `persons` e vínculos**
- B1. Migration `persons` (hashes, auth_user_id) + RLS restritiva service-role. **(M)**
- B2. HMAC determinístico de e-mail/telefone (pepper em secret manager) + normalização E.164/e-mail. **(M)**
- B3. FK `members.person_id`, `members.user_id`; backfill/seed. **(S)**
- B4. Constraint `UNIQUE (org_id, person_id)` parcial (exclui merged) — 1 membership/org/pessoa. **(S)**

**Épico C — Máquina de estados / lifecycle**
- C1. `member_status_history` + trigger `on_member_status_change` (audit + pgmq + webhooks). **(M)**
- C2. `member-transition` (validação das transições permitidas; rejeita inválidas). **(M)**
- C3. Endpoints `/transition`, `/reactivate`, `/cancel`. **(M)**
- C4. Cron `lifecycle-grace-sweep` (past_due→suspended) integrando grace por org. **(M)** *(depende de billing p/ grace + webhooks Asaas)*
- C5. Cron `lifecycle-parcelado-expiry` (fim de acesso parcelado → canceled). **(S)** *(depende de billing)*
- C6. Emissão dos eventos de webhook de saída. **(S)** *(depende de webhooks)*

**Épico D — Reconciliação (claim) importado↔login**
- D1. Trigger `on_auth_user_created` → enfileira `member-claim`. **(S)**
- D2. `member-claim`: match por hash verificado, vincula auth a person/members órfãos, propaga `user_id`. **(L)**
- D3. Regras anti-takeover (só auto-vincula canal verificado; conflito → fila de revisão). **(M)**
- D4. `/v1/me/memberships` (cross-org para a pessoa logada). **(M)**

**Épico E — Merge de duplicados**
- E1. Detector de duplicados (por hash e/ou trigram de nome) → lista de candidatos. **(M)**
- E2. `member-merge` dry-run: calcula survivor, o que será reapontado, conflitos (2 subs ativas). **(L)**
- E3. `member-merge` apply: reaponta interactions/notes/transactions/entitlements/tickets/checkins; tombstone `merged`; revoga/reaponta passes. **(L)**
- E4. Reversibilidade soft (janela X dias) + job de consolidação. **(M)**
- E5. Tela admin de merge (diff, dry-run, confirmação). **(M)** *(admin-app)*

**Épico F — Importação em lote**
- F1. `member-import` (parse CSV, mapeamento de colunas, dedup interno do arquivo, geração de IDs em lote performática). **(L)**
- F2. Criação de persons sem login + members `lead`/`active`. **(M)**
- F3. Wizard de import no admin (preview, relatório de erros). **(M)** *(admin-app)*

**Épico G — Front/CRM de identidade**
- G1. `<MemberIdBadge/>`, `<MemberStatusBadge/>`, formatação visual. **(S)** *(design-system)*
- G2. Perfil 360º — aba Identidade (auth vinculado, person cross-org, contatos verificados). **(M)** *(admin-app)*
- G3. Lista/kanban por lifecycle com filtros de status. **(M)** *(admin-app, crm)*
- G4. `<MemberCard/>` + "Minhas memberships" no front de membro. **(M)** *(member-app)*

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Schema base, RLS multi-tenant, `organizations`/`accounts`, pgcrypto, pgmq, pg_cron, monorepo. Sem isso não há onde gerar `members`. |
| **auth-rbac** | `auth.users`, OAuth/OTP, papéis (operator pode criar lead na portaria; admin faz merge). Claim depende de Auth. RLS de `members` usa o JWT. |
| **payments-billing** | As transições `pending→active`, `active→past_due`, `→suspended`, fim de parcelado vêm de webhooks/estado de assinatura e do grace period configurável. |
| **passport** | Reage a transições e reativação/merge (re-emite/revoga passes); consome `member_id`. (Acoplamento bidirecional, mas passport é consumidor.) |
| **webhooks** | Eventos de saída (`member.*`) precisam do framework de entrega. |
| **crm** | Timeline (`interactions`), métricas, segmentação consomem este domínio; perfil 360º é renderizado no CRM. |
| **design-system / admin-app / member-app** | Telas e componentes de exibição/ação. |

Quem depende **deste** domínio (downstream): praticamente todos (tiers-perks, verification-checkin, events-tickets, content-gating, community-channels, communication, hall-of-fame, public-api, mcp) — pois ancoram em `member_id`.

---

### 8. Riscos & decisões técnicas

1. **Anti-enumeração depende de CSPRNG real.** Risco: usar `random()` do Postgres torna IDs previsíveis → varredura da rota pública. Mitigação: `gen_random_bytes`/`crypto.getRandomValues` obrigatório; rate-limit na rota pública (domínio verification). **Atenção alta.**
2. **Unicidade global vs. RLS por org.** O índice UNIQUE é global, mas a inserção roda sob RLS por org. A função de criação precisa de privilégio para "ver" colisões em outras orgs sem vazar dados → `SECURITY DEFINER` que só compara o `member_id` (nunca retorna dados de outra org). Risco de vazamento se mal implementada.
3. **`persons` cross-org é superfície de vazamento LGPD.** Se qualquer query de org alcançar `persons`, vaza a existência da pessoa em outras orgs. Mitigação: RLS deny-all + acesso só via edge service-role; só hashes, nunca PII.
4. **Merge é destrutivo e irreversível na prática.** Reapontar billing/tickets errado = caos financeiro. Mitigação: dry-run obrigatório, tombstone soft, bloqueio quando 2 subs ativas, audit completo.
5. **Reativação reusa ID — decisão de produto não-trivial.** Se o dono esperava ID novo por ciclo, há retrabalho de schema/passport. Marcado como openQuestion blocking.
6. **Claim e account takeover.** Vincular automaticamente por e-mail não verificado permite sequestro de membership. Mitigação: só verificado; `+alias` não colapsa; conflito → revisão manual.
7. **Membro sem contato vira ilha.** Não participa de reconciliação nem comunicação. Aceitável, mas precisa sinalização clara no CRM para o dono não "perder" o membro.
8. **Trigger que preenche `member_id` em insert PostgREST** precisa do mesmo retry/blocklist do caminho edge — divergência de lógica entre os dois caminhos é risco. Mitigação: lógica única na função do banco; o app só chama.
9. **`status` da máquina vs. estado real no Asaas** podem divergir (webhook perdido). Mitigação: job de reconciliação periódico (billing) que reconcilia status; este domínio expõe `transition` idempotente.
10. **Capacidade de 1,36 bi parece infinita, mas** com colisão a N=7 retries, monitorar taxa de retry como sinal precoce de saturação (improvável no horizonte do produto, mas barato medir).

---

### 9. Escopo MVP vs. depois

**No MVP (Fase 0–1, §29):**
- Geração canônica do Member ID (CSPRNG, retry, unicidade global, regex/CHECK) — **é literalmente Fase 0** ("Modelo de dados núcleo + geração do Member ID").
- Tabela `members` + `member_profiles` (e-mail/phone nullable) + status enum.
- Máquina de estados essencial: `lead → pending → active → past_due → suspended → canceled` e **reativação reusando ID** (depende de billing/webhooks que já estão na Fase 1).
- Vínculo `member ↔ auth user` e `member ↔ person` + **claim** básico de importado→login (Fase 1 tem import de base e login social).
- Normalização/exibição (`formatMemberId`/`normalizeMemberId`) e `<MemberCard/>` (Passport é Fase 1).
- Importação CSV básica (Fase 1 cita "migração de bases existentes" no CRM básico).
- Blocklist mínima (seed de ofensivos).

**Depois (Fase 2+):**
- **Merge de duplicados** com dry-run/reversibilidade e tela dedicada (Fase 2 — CRM completo).
- `persons` cross-org com "Minhas memberships" multi-org polido (depende de várias orgs em uso real).
- Detecção automática de duplicados por IA/trigram.
- Reconciliação avançada (resolução de conflitos de takeover com UI de revisão).
- Reversibilidade de merge / consolidação agendada.
- Blocklist administrável e leetspeak/normalização sofisticada.

> Pré-requisito de arranque: como quase tudo ancora em `member_id`, **A1–A6 (Épico A) devem ser a primeira coisa codada após a fundação** — antes de tiers, CRM, billing e passport.
