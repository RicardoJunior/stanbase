## 12. Validação Pública & Check-in/Portaria

> **Domínio:** prova pública de que um membro é válido + operação de portaria (check-in de evento, scanner online/offline, anti-fraude e anti-reuso).
> **Fontes de verdade no STANBASE.md:** §7 (Member ID), §8 (Passport/QR), §9 (Rota pública de validação), §10.1 item 12 (módulo "Validação & Portaria"), §14 (Eventos e ingressos — check-in), §25.4 (`passes`/`tickets`/`checkins`), §26 (LGPD/segurança).
> **Decisões imutáveis aplicáveis:** Member ID = 8 chars alternando letra/número, alfabeto sem ambíguos, **sem dígito verificador** (a integridade vem da validação online + token assinado, não de check digit); Passport = Apple + Google; 1 membership por org; PSP = Asaas (irrelevante aqui, mas o status de membership que esta rota lê é alimentado pelos webhooks de billing).

---

### 12.1 Como funciona

Este domínio entrega **três superfícies** sobre os mesmos dados, separadas por **nível de confiança do solicitante**:

1. **Página/endpoint público de validação** — qualquer pessoa (porteiro improvisado, lojista, parceiro) confirma que um Member ID é válido, com dados mínimos.
2. **Validação com token** — quem escaneou o QR do passe (logo, possui um token assinado) vê um pouco mais (foto/nome) + confirmação anti-fraude.
3. **Portaria/check-in autenticado** — staff (`operator`) logado faz check-in de evento, marca presença, vê tudo e registra interação no CRM. Funciona **online e offline**.

#### 12.1.1 Os três níveis de visibilidade (decidido em §9.2)

| Nível | Quem é | Como prova | O que vê | Pode agir? |
|---|---|---|---|---|
| **L0 — Público sem token** | Digitou o Member ID na URL | nada (só o ID) | Marca da org · "Membro válido/inválido" · tier (se org permitir) · "membro desde" (se org permitir) · status binário (ativo/inativo) | Não |
| **L1 — Com token (QR)** | Escaneou o QR do passe | `token` JWT assinado na URL | L0 + **foto** (se org permitir) + **nome** (se org permitir) + selo "QR autêntico / verificado agora" | Não |
| **L2 — Staff autenticado** | `operator`/`admin`/`owner` logado | JWT de usuário Supabase + RBAC | Tudo (perfil 360º resumido, perks ativos, tier, histórico de check-in) + **ações**: check-in, marcar presença, registrar interação no CRM, ver ingresso | Sim |

> **Princípio LGPD (minimização, §26):** L0 nunca expõe PII. O que aparece em cada nível é **configurável pela org** dentro de limites de segurança (a org pode esconder foto/nome em L1, mas **não pode promover PII para L0**).

#### 12.1.2 Máquina de estados — `member.status` (lida pela validação)

A validação **não é dona** do status do membro (ele vive em `members.status`, escrito pelo domínio member-identity/payments-billing). Ela apenas **lê e projeta** para o solicitante. Estados relevantes e o que a validação mostra:

```
active        → "Membro válido"            (verde)
grace/past_due→ "Membro válido (pendência)"(amarelo) — acesso ainda liberado no grace period
paused        → "Membro pausado"           (cinza)  — inválido para check-in, válido como histórico
inactive      → "Membro inativo"           (vermelho)
canceled      → "Membro inativo"           (vermelho) — nunca "não existe" (preserva privacidade do motivo)
revoked       → idem inativo, em tempo real (Realtime)
not_found     → "ID não encontrado"        (neutro) — resposta genérica, anti-enumeração
```

Regra de negócio: para **público (L0/L1)** colapsamos `canceled`/`revoked`/`inactive` numa única mensagem "Membro inativo" (não revelar o motivo). Para **staff (L2)** mostramos o estado real e o motivo.

#### 12.1.3 Máquina de estados — `ticket.status` (check-in de evento)

```
issued ──compra/emissão──▶ valid ──check-in──▶ used
                            │                    │
                            ├─ cancel ──▶ void   └─ (reentrada? ver 12.8.3)
                            └─ event_canceled ──▶ void
                            └─ transfer ──▶ valid (novo titular)
```

- **`valid` → `used`** é a transição de check-in. É **idempotente por design**: a primeira chamada marca `used`; chamadas subsequentes retornam "já usado às HH:MM por OPERADOR" (anti-reuso), **não** erro fatal.
- **Anti-reuso** = um `ticket` só pode ter **um** check-in efetivo (`UNIQUE` em `checkins(ticket_id) WHERE valid`). Reentrada controlada é um modo opt-in do evento (§12.8.3).

#### 12.1.4 Fluxo passo a passo — Validação pública por ID (L0)

1. Pessoa abre `verify.stanbase.com/{memberId}` (ou domínio da org).
2. Front normaliza o ID (upper, remove separadores `-`/`·`/espaço), valida formato (regex `^[A-HJ-NP-Z][2-9]...` alternando, sem I/O/0/1).
3. Front chama `GET /v1/public/verify/{memberId}` (sem token).
4. Edge Function: rate-limit por IP → normaliza → busca membro → aplica política de campos públicos da org → retorna **DTO mínimo**.
5. Se não existe: resposta **genérica** `{ valid:false, reason:"not_found" }` com **mesma latência** de um hit (timing-safe, anti-enumeração).
6. Front renderiza badge com a marca da org. Abre canal Realtime para refletir revogação ao vivo enquanto a aba estiver aberta.

#### 12.1.5 Fluxo passo a passo — Validação por QR (L1)

1. Porteiro escaneia o QR do passe → o QR contém `https://verify.stanbase.com/{memberId}?t={token}` (token assinado; ver §12.6).
2. Front extrai `t` e chama `GET /v1/public/verify/{memberId}?token={t}`.
3. Edge Function valida o token: assinatura, `exp`, `nbf`, `aud`, `iss`, `jti` não revogado, `sub == memberId`. Em QR dinâmico (TOTP-like), valida o passo de tempo (±1 janela de skew).
4. Token válido → retorna **DTO enriquecido** (L0 + foto/nome conforme política) + `verified_at` + selo de autenticidade.
5. Token inválido/expirado/revogado → **degrada para L0** (mostra o que dá por ID) + banner "QR expirado, peça para reabrir o passe" — **não** bloqueia a validação básica.

#### 12.1.6 Fluxo passo a passo — Check-in de evento na portaria (L2)

1. Operador abre o **Scanner** (PWA do admin, módulo "Validação & Portaria"), seleciona o **evento** ativo.
2. App carrega (e cacheia para offline) o **manifesto do evento**: lista de `tickets` válidos + hashes de validação + política do evento (reentrada? capacidade? janela de horário?).
3. Operador escaneia o QR do ingresso/passe.
4. **Modo online:** `POST /v1/checkin` com `{ event_id, ticket_id|member_id, token, device_id, scanned_at, nonce }`.
   - Server valida token, valida que o ticket pertence ao evento, valida status do membro (active/grace), valida janela de horário, tenta transição `valid→used` (atômica).
   - Retorna resultado verde/amarelo/vermelho + dados do membro + tier + foto.
5. **Modo offline:** app valida **localmente** contra o manifesto cacheado (assinatura local + status snapshot), grava o check-in numa **fila local (outbox)** e mostra resultado provisório. Sincroniza quando volta a rede (§12.8.1).
6. Check-in efetivo → escreve em `checkins`, marca `ticket.used`, dispara push para o passe ("ingresso utilizado"), grava `interaction` no CRM, emite webhook `event.checkin`, atualiza contador Realtime (taxa de check-in no dashboard).

#### 12.1.7 Regras de negócio concretas

- **Member ID é case-insensitive** e armazenado upper, sem separador (§7.5). A rota aceita `b7k2-m9x4`, `B7K2 M9X4`, `B7K2M9X4` → todos normalizam para `B7K2M9X4`.
- **ID nunca é segredo** (§7.6). Logo, L0 por ID **não prova nada de sensível** — só o token prova autenticidade.
- **ID nunca é reutilizado** (§7.6): mesmo cancelado, a validação resolve o ID (mostra "inativo"), nunca "não existe" — exceto IDs que de fato nunca existiram.
- **Sem dígito verificador** (decidido §7.4): não há validação local de check digit; integridade vem da **consulta online**. No offline, integridade vem da **assinatura do manifesto/token**, não de check digit.
- **Status em tempo real** (§9.3): revogação de membership reflete imediatamente em qualquer aba de validação aberta (Realtime) e em qualquer scanner online.
- **Campos públicos por org** (§9.3): a org define em Configurações > LGPD/Privacidade quais campos saem em L0 e L1. Defaults conservadores (ver §12.8.6).
- **Check-in exige evento ativo + ticket do evento.** Um passe de membership puro (carteirinha) **não** é check-in de evento; pode ser "presença de membro" se o evento permitir entrada por tier (sem ticket nominal) — modo "entrada por membership" (§12.8.4).

---

### 12.2 Modelo de dados

Reaproveita §25.4 (`passes`, `events`, `tickets`, `checkins`) e adiciona o que falta para token/rotação/anti-enumeração/offline/política de campos.

#### 12.2.1 Tabelas tocadas (já existentes no doc)

**`passes`** (§25.4) — adicionar colunas de token/rotação:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `member_id` | text FK→members.member_id | |
| `org_id` | uuid FK | denormalizado p/ RLS e rate-limit |
| `type` | enum `membership`/`ticket` | |
| `platform` | enum `apple`/`google` | |
| `serial` | text | serial do passe na Wallet |
| `ticket_id` | uuid FK→tickets nullable | preenchido quando `type=ticket` |
| **`token_secret`** | bytea (cifrado) | segredo por-passe para QR dinâmico TOTP-like |
| **`token_kid`** | text | id da chave de assinatura usada (rotação) |
| **`token_version`** | int | incrementa a cada rotação/revogação → invalida QR antigo |
| **`dynamic_qr`** | bool | true para passes de alto risco (TOTP) |
| `status` | enum `active`/`revoked` | |
| `created_at` / `updated_at` | timestamptz | |

**`tickets`** (§25.4) — confirmar/expandir:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `event_id` | uuid FK | |
| `member_id` | text FK nullable | nulo p/ ingresso não-nominal/convidado |
| `org_id` | uuid FK | |
| `tier_pricing` | jsonb | lote/preço aplicado |
| `status` | enum `issued`/`valid`/`used`/`void` | máquina §12.1.3 |
| `pass_id` | uuid FK→passes | |
| `holder_name` | text nullable | p/ ingresso de convidado (não-membro) |
| `transferable` | bool | permite transferência de titularidade |
| `created_at` | timestamptz | |

**`checkins`** (§25.4) — expandir para offline/anti-reuso:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `event_id` | uuid FK | |
| `ticket_id` | uuid FK nullable | nulo p/ check-in por membership (§12.8.4) |
| `member_id` | text FK | |
| `operator_user_id` | uuid FK→auth.users | quem fez |
| `device_id` | text | dispositivo do scanner |
| `mode` | enum `online`/`offline` | |
| `scanned_at` | timestamptz | momento do scan (relógio do device) |
| `synced_at` | timestamptz nullable | quando o offline subiu |
| `client_nonce` | text | idempotência fim-a-fim (gerado no device) |
| `result` | enum `granted`/`denied_duplicate`/`denied_invalid`/`denied_status`/`denied_window` | |
| `created_at` | timestamptz | server time |

#### 12.2.2 Tabelas novas

**`verify_signing_keys`** — chaveiro de assinatura de tokens (rotação):
| Coluna | Tipo | Notas |
|---|---|---|
| `kid` | text PK | key id |
| `alg` | text | `EdDSA` (Ed25519) recomendado |
| `public_key` | bytea | exposto via JWKS interno |
| `private_key_ref` | text | referência ao secret manager (nunca a chave em claro) |
| `status` | enum `active`/`next`/`retired` | só 1 `active` por vez |
| `not_before` / `not_after` | timestamptz | janela de validade |
| `created_at` | timestamptz | |

**`token_revocations`** — denylist de `jti`/passe revogados (consulta na verificação):
| Coluna | Tipo | Notas |
|---|---|---|
| `jti` | text PK | id do token revogado |
| `pass_id` | uuid FK nullable | revogação por passe inteiro |
| `org_id` | uuid FK | |
| `reason` | text | |
| `revoked_at` | timestamptz | |
| `expires_at` | timestamptz | TTL = exp original (auto-limpeza por cron) |

> Otimização: a revogação principal é por **`pass.token_version`** (bump invalida tudo do passe sem listar jti). A `token_revocations` cobre revogação granular de um token específico ainda válido.

**`event_checkin_policies`** — política de portaria por evento:
| Coluna | Tipo | Notas |
|---|---|---|
| `event_id` | uuid PK FK | |
| `org_id` | uuid FK | |
| `allow_reentry` | bool | reentrada permitida (default false) |
| `reentry_cooldown_sec` | int | intervalo mínimo entre reentradas |
| `entry_window_start` / `entry_window_end` | timestamptz nullable | janela de horário de entrada |
| `entry_by_membership` | bool | aceita check-in por tier sem ticket nominal |
| `allowed_tiers` | jsonb | tiers que entram por membership |
| `offline_mode_enabled` | bool | permite scanner offline neste evento |
| `require_photo_match` | bool | exige foto p/ liberar (anti-screenshot humano) |

**`org_verify_settings`** — política de campos públicos/privacidade (LGPD §26):
| Coluna | Tipo | Notas |
|---|---|---|
| `org_id` | uuid PK FK | |
| `public_show_tier` | bool | L0 mostra tier (default true) |
| `public_show_member_since` | bool | L0 mostra "membro desde" (default true) |
| `public_show_status` | bool | L0 mostra status (default true) |
| `token_show_photo` | bool | L1 mostra foto (default false — conservador) |
| `token_show_name` | bool | L1 mostra nome (default true) |
| `token_show_name_format` | enum `full`/`first_last_initial` | "João S." (default `first_last_initial`) |
| `custom_domain` | text nullable | `verificar.suacomunidade.com` |
| `dynamic_qr_default` | bool | passes desta org nascem com QR dinâmico |

**`verify_access_log`** — auditoria/anti-enumeração (append-only, particionado por dia):
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | bigint PK | |
| `org_id` | uuid nullable | nulo se ID não resolveu |
| `member_id` | text nullable | |
| `ip_hash` | bytea | IP hasheado (LGPD) |
| `level` | enum `L0`/`L1`/`L2` | |
| `result` | enum `hit`/`not_found`/`rate_limited`/`token_invalid` | |
| `at` | timestamptz | |

#### 12.2.3 Índices & constraints relevantes

- `members(member_id)` **UNIQUE global** (já no doc §25.2) — base da resolução O(1).
- `checkins` **anti-reuso:** `CREATE UNIQUE INDEX ON checkins(ticket_id) WHERE result='granted'` (impede dois check-ins efetivos do mesmo ticket; reentrada usa tabela/flag separada).
- `checkins` **idempotência offline:** `UNIQUE(event_id, ticket_id, client_nonce)` — reprocessar a outbox não duplica.
- `tickets(event_id, status)` — listar válidos do evento (manifesto).
- `tickets(member_id, event_id)` — check-in por membership/lookup.
- `token_revocations(expires_at)` — cron de limpeza.
- `verify_access_log(ip_hash, at)` — janela de rate-limit/detecção de varredura.
- `passes(member_id, type)` e `passes(token_kid)` — refresh em massa por rotação de chave.
- **RLS:** todas as tabelas com `org_id` sob RLS (§26). **Exceção crítica:** a leitura pública (L0/L1) **não passa por RLS de usuário** — roda numa Edge Function com role de serviço que aplica a **política de campos explicitamente em código** (o DTO é montado pelo servidor, nunca expõe a linha crua). `checkins`/`tickets` sob RLS por `org_id` + papel `operator`.

---

### 12.3 API & Edge Functions

#### 12.3.1 Endpoints REST `/v1`

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| `GET` | `/v1/public/verify/{memberId}` | nenhuma (L0) / `?token=` (L1) | Validação pública. Sem token → DTO mínimo; com token válido → DTO enriquecido. Rate-limited, timing-safe, anti-enumeração. (§9.1) |
| `GET` | `/v1/public/verify/{memberId}/qr` | token interno do passe | (uso do passe dinâmico) devolve o passo TOTP atual p/ render do QR — chamado pelo device do membro, não pela portaria |
| `POST` | `/v1/checkin` | JWT operator + RBAC | Marca presença/check-in de evento. Idempotente por `client_nonce`. Body: `{event_id, ticket_id?, member_id?, token?, mode, device_id, scanned_at, client_nonce}` |
| `POST` | `/v1/checkin/batch` | JWT operator | Sincroniza a **outbox offline**: lista de check-ins; servidor resolve conflitos e devolve veredito por item |
| `GET` | `/v1/events/{id}/checkin-manifest` | JWT operator | Baixa o **manifesto assinado** do evento p/ modo offline (tickets válidos, hashes, política, snapshot de status, validade curta) |
| `GET` | `/v1/events/{id}/checkin-stats` | JWT operator/admin | Contadores ao vivo (presentes, % check-in, por tier) |
| `POST` | `/v1/passport/{memberId}/revoke-token` | JWT admin | Revoga QR (bump `token_version` + denylist) — perda de celular, fraude |
| `POST` | `/v1/tickets/{id}/validate` | JWT operator | (já no doc §21.2) valida ingresso isolado sem registrar presença (modo "conferência") |
| `GET` | `/v1/verify/settings` / `PATCH` | JWT admin | Lê/edita `org_verify_settings` (campos públicos, domínio, QR dinâmico) |
| `GET` | `/v1/events/{id}/checkin-policy` / `PATCH` | JWT admin | Política de portaria do evento |

#### 12.3.2 Edge Functions / Jobs

| Function/Job | Tipo | Descrição |
|---|---|---|
| `public-verify` | Edge (público) | Núcleo da rota pública. Sem dependência de RLS de usuário; monta DTO por política. Rate-limit por IP (token bucket em Postgres/`pgmq` ou KV). Timing-safe constante. |
| `checkin` | Edge | Lógica transacional de check-in (lock de linha `tickets` `SELECT FOR UPDATE`, transição atômica, anti-reuso, webhook, Realtime, push). |
| `checkin-sync` | Edge | Recebe outbox offline, deduplica por `client_nonce`, resolve "primeiro vence" por `scanned_at`. |
| `checkin-manifest` | Edge | Gera e **assina** o manifesto do evento (Ed25519). TTL curto (ex.: 4h ou até fim do evento). |
| `verify-token-issue` | Edge (interna) | Chamada por `passport/issue` (domínio passport) p/ cunhar o JWT/TOTP do QR. |
| `verify-key-rotation` | Cron (pg_cron) | Promove chave `next`→`active`, gera nova `next`, marca antigas `retired` após grace. Reemite passes em lote (fila pgmq). |
| `token-revocation-gc` | Cron | Limpa `token_revocations` expiradas. |
| `verify-anomaly-detector` | Cron | Varre `verify_access_log` por padrões de enumeração (muitos `not_found` do mesmo `ip_hash`) → bloqueio temporário. |
| `passport-push-checkin` | Job (pgmq) | Pós-check-in: push APNs/Google Wallet "ingresso utilizado". |

> **Dogfooding (§10.3):** o scanner do admin consome **a mesma** `/v1/checkin` que um parceiro headless usaria. Sem rota privilegiada paralela.

---

### 12.4 Telas/Front

#### 12.4.1 Página pública de validação (membro/anônimo) — `apps/member` ou app público dedicado

- **`/{memberId}` (verify.stanbase.com):** badge temável com a marca da org (logo, cor). Estados visuais verde/amarelo/cinza/vermelho. "Verificado às HH:MM:SS". Quando há token: foto (se permitido) + nome formatado. Banner de QR expirado. Conexão Realtime para refletir revogação. Acessível (contraste, leitor de tela), carrega rápido (é a primeira impressão na porta).
- **Estados de erro amigáveis:** "ID não encontrado", "QR expirado — reabra o passe", "Sem conexão — tente de novo".
- **Componente reutilizável `<VerifyBadge/>`** (citado em §24.3) — embeddable em site da org.

#### 12.4.2 Scanner / Portaria (admin, papel operator) — `apps/admin` módulo "Validação & Portaria" (§10.1 #12)

- **Seleção de evento + sessão de portaria.** Mostra capacidade, presentes, % check-in (Realtime).
- **Scanner de câmera** (getUserMedia + lib de QR), com fallback de **digitação manual do Member ID** (porta sem câmera/QR ruim).
- **Resultado em tela cheia:** semáforo grande (verde GRANTED / amarelo ATENÇÃO / vermelho DENIED), foto grande do membro (anti-screenshot por conferência humana), nome, tier, motivo do denied. Som/vibração distintos por resultado.
- **Banner de modo:** "ONLINE" vs "OFFLINE — N check-ins na fila". Botão de sincronizar manual.
- **Lista de presentes / busca** por nome/ID. Ação "desfazer check-in" (com motivo, audita).
- **Modo "conferência"** (validar sem marcar presença) para checagens fora da porta.
- **Reentrada:** quando a política permite, mostra "Reentrada — última saída HH:MM".

#### 12.4.3 Admin — Configurações de Validação & Privacidade

- **Campos públicos (LGPD):** toggles para tier/membro-desde/status em L0; foto/nome e formato do nome em L1. Preview ao vivo do que o público vê.
- **QR dinâmico:** ligar por org e/ou por evento de alto risco.
- **Domínio de validação:** `verify.stanbase.com/{id}` (padrão) vs domínio próprio.
- **Política de portaria por evento:** reentrada, cooldown, janela de horário, entrada por membership, exigir foto, habilitar offline.
- **Revogar QR de um membro** (perda de celular): botão na ficha do membro no CRM.

---

### 12.5 Integrações externas

| Serviço | Como integra |
|---|---|
| **Apple Wallet (PassKit) / APNs** | O QR vive no passe; push de atualização ("ingresso utilizado", "QR revogado") via APNs. Emissão/assinatura é do domínio **passport**; aqui consumimos o token e disparamos refresh. |
| **Google Wallet API** | Idem: objeto do passe atualizado via PATCH REST após check-in/revogação. |
| **Supabase Realtime** | Canal por `member_id` (revogação ao vivo na página pública) e por `event_id` (contadores de check-in no scanner/dashboard). |
| **Supabase Auth + RBAC (auth-rbac)** | L2 exige JWT de usuário com papel `operator`+ permissão de check-in na org. |
| **Asaas (via webhooks de billing → member.status)** | Indireto: a validação **lê** o `status` que os webhooks de pagamento mantêm; uma inadimplência/cancelamento reflete em tempo real na porta. Não chamamos o Asaas aqui. |
| **Secret manager (KMS)** | Guarda `private_key_ref` das chaves de assinatura e o `token_secret` dos passes dinâmicos cifrados (§26). |
| **Sympla/Ingresse (events-tickets)** | Ingressos importados viram `tickets` validáveis pela mesma portaria (mapeamento de external_ref → ticket). |

---

### 12.6 Token do QR — desenho técnico

**Modo padrão (QR estático assinado):**
- JWT compacto **Ed25519 (EdDSA)** — assinatura curta, cabe em QR de baixa densidade.
- Claims: `iss=stanbase`, `aud=verify`, `sub=memberId`, `org`, `pass_id`, `tv` (token_version), `jti`, `iat`, `exp` (ex.: 24–72h), `nbf`.
- `kid` no header → resolve a chave em `verify_signing_keys`.
- A URL no QR: `https://{domínio}/{memberId}?t={jwt}`. O passe é **reemitido** quando o token está perto de expirar (push do passport).

**Modo alto risco (QR dinâmico, TOTP-like):**
- Segredo por passe (`passes.token_secret`) → o QR no celular **rotaciona** (ex.: a cada 30–60s) um código derivado (HOTP/TOTP) embutido no token.
- A verificação aceita ±1 janela de skew de relógio.
- **Anti-screenshot:** um print fica obsoleto em segundos (§12.8.5). A foto na tela do operador (L1/L2) é a segunda barreira contra print compartilhado.
- Custo: exige o app/PWA do membro aberto para gerar o passo (ou o passe Wallet com QR dinâmico — limitado; provavelmente PWA do membro p/ esse caso). **Decisão de produto pendente** (§12.10 Q4).

**Rotação de chave (`verify-key-rotation`):**
- Sempre há `active` (assina novos) e `retired` (ainda verifica até `not_after`) → zero downtime de validação durante rotação.
- Vazamento de chave → marcar `retired` imediatamente + bump global → força reemissão.

**Anti-enumeração (§9.3):**
- IDs não sequenciais (já garantido pela geração CSPRNG §7.5).
- Rate-limit por IP (token bucket) + resposta **genérica e timing-constant** para `not_found`.
- `verify-anomaly-detector` bloqueia IPs que varrem (muitos `not_found`).
- Sem dígito verificador (decidido) → **não** dá pra "adivinhar offline" se um ID é bem-formado além do alfabeto; toda checagem de existência custa uma chamada rate-limited.

---

### 12.7 Épicos & tarefas

#### Épico A — Rota pública de validação (L0/L1)
- A1. Edge Function `public-verify`: resolução de Member ID normalizado + DTO por política (S). **M**
- A2. Normalização/validação de formato do ID (regex alfabeto sem ambíguos, upper, strip separadores) compartilhada (member-identity) (S)
- A3. Política de campos públicos: aplicar `org_verify_settings` ao montar DTO L0/L1 (M)
- A4. Verificação de token (Ed25519, claims, exp/nbf/jti/tv, JWKS interno) (M)
- A5. Degradação graciosa token inválido → L0 + banner (S)
- A6. Resposta timing-constant + genérica p/ `not_found` (S)
- A7. Rate-limit por IP (token bucket) + `verify_access_log` (M)
- A8. Front página pública temável `<VerifyBadge/>` + estados visuais + acessibilidade (M)
- A9. Realtime na página pública (revogação ao vivo) (S)
- **Esforço épico: L**

#### Épico B — Tokens, chaves e rotação
- B1. Tabela `verify_signing_keys` + geração de chaveiro + secret manager (M)
- B2. `verify-token-issue` (cunhar token estático) integrada ao `passport/issue` (M)
- B3. Cron `verify-key-rotation` (promoção active/next/retired + reemissão em lote via pgmq) (M)
- B4. `token_revocations` + endpoint `revoke-token` + bump `token_version` (M)
- B5. Cron `token-revocation-gc` (S)
- B6. QR dinâmico TOTP-like (segredo por passe, geração no PWA do membro, verificação com skew) (L) — *gate por decisão Q4*
- **Esforço épico: L**

#### Épico C — Check-in online
- C1. Edge `checkin`: transição atômica `valid→used` com `SELECT FOR UPDATE` + anti-reuso (M)
- C2. Validação de pertencimento ticket↔evento, status do membro, janela de horário (M)
- C3. Índices/constraints de anti-reuso e idempotência por `client_nonce` (S)
- C4. Webhook `event.checkin` + `interaction` no CRM + contador Realtime (M) — *depende de webhooks, crm*
- C5. Push pós-check-in p/ passe (APNs/Google) (M) — *depende de passport*
- C6. Endpoint `checkin-stats` (presentes, % por tier) (S)
- C7. "Desfazer check-in" com auditoria + reverter `ticket.status` (M)
- **Esforço épico: L**

#### Épico D — Check-in offline (portaria sem internet)
- D1. `checkin-manifest`: gerar + assinar manifesto do evento (tickets válidos, hashes, política, snapshot status, TTL) (L)
- D2. Cache local do manifesto no PWA (IndexedDB) + verificação local (assinatura + status snapshot) (L)
- D3. Outbox local de check-ins offline (IndexedDB) + UI de "N na fila" (M)
- D4. `checkin-sync`/`checkin/batch`: dedupe por `client_nonce`, resolução de conflito "primeiro `scanned_at` vence" (L)
- D5. Tratamento de conflito pós-sync (duplicado offline, membro revogado depois do snapshot) + relatório ao operador (M)
- **Esforço épico: XL**

#### Épico E — Scanner / Portaria (front)
- E1. Tela de seleção de evento + sessão de portaria + indicador online/offline (M)
- E2. Scanner de câmera (getUserMedia + QR) + fallback digitação manual (M)
- E3. Tela de resultado fullscreen (semáforo, foto grande, som/vibração) (M)
- E4. Busca/lista de presentes + reentrada + desfazer (M)
- E5. PWA offline-ready (service worker, IndexedDB, sync background) (L)
- **Esforço épico: L**

#### Épico F — Configuração & privacidade (admin)
- F1. Tela de campos públicos (LGPD) com preview ao vivo + `org_verify_settings` CRUD (M)
- F2. Política de portaria por evento (`event_checkin_policies`) CRUD (M)
- F3. Domínio próprio de validação (provisionamento/SSL — depende de fundacao) (M)
- F4. Botão "revogar QR" na ficha do membro (CRM) (S)
- **Esforço épico: M**

#### Épico G — Anti-fraude & observabilidade
- G1. `verify-anomaly-detector` (detecção de enumeração) + bloqueio temporário (M)
- G2. Métricas/dashboards: taxa de check-in, denied por motivo, latência da rota pública, validações por nível (M) — *depende de observability*
- G3. Testes de RLS + testes de carga da rota pública + testes de concorrência de check-in (race) (L)
- **Esforço épico: M**

---

### 12.8 Riscos, decisões técnicas & edge cases

#### 12.8.1 Validação offline na portaria (edge case central)
- **Problema:** portaria sem internet (local de evento ruim, túnel, ginásio).
- **Solução:** manifesto **assinado** do evento cacheado no device → o scanner valida **localmente** (assinatura Ed25519 + snapshot de status no momento do download) e enfileira o check-in (outbox).
- **Risco residual:** um membro **revogado após** o download do manifesto continua passando offline. Mitigação: manifesto com TTL curto, snapshot timestamp visível, e na **sincronização** marcamos esses check-ins como "concedido offline com status defasado" para auditoria/contestação. Eventos de alto risco devem desabilitar offline (`offline_mode_enabled=false`) ou exigir reconexão periódica.
- **Conflito de duplicado offline:** dois operadores offline escaneiam o mesmo ticket → ambos concedem localmente. No sync, **o primeiro `scanned_at` vence** (`granted`), o segundo vira `denied_duplicate`. Operador é notificado no relatório pós-evento.

#### 12.8.2 Membro inativo/cancelado/pausado na porta
- L0/L1: mostra "Membro inativo" genérico (não revela motivo — privacidade).
- L2 check-in: `denied_status` com o motivo real para o operador decidir (ex.: "pendência de pagamento — liberar?"). Política do evento pode permitir override manual auditado (ex.: grace period configurável §13.4).
- **Grace/past_due:** decisão de negócio — durante grace period o membro ainda é "válido com pendência" (amarelo). Ver Q3.

#### 12.8.3 Ingresso já usado (anti-reuso)
- Segunda leitura do mesmo ticket → `denied_duplicate` com "já usado às HH:MM por [operador]". Não é erro fatal; é informação para o operador.
- **Reentrada legítima:** só quando `event_checkin_policies.allow_reentry=true`. Aí registramos eventos de saída/entrada sem violar o `UNIQUE` de check-in efetivo (tabela de movimentos separada ou flag de reentrada). Cooldown evita double-scan acidental.
- **Race condition** (dois scanners simultâneos online): resolvido por `SELECT FOR UPDATE` na linha do ticket → só um ganha `granted`, o outro recebe `denied_duplicate` imediatamente.

#### 12.8.4 Foto opcional + check-in por membership
- Foto é **opcional** (membro pode não ter; org pode não querer expor). Sem foto, o operador valida pelo nome/tier — a barreira anti-fraude cai um pouco, então eventos de alto risco devem **exigir foto** (`require_photo_match=true`) e/ou QR dinâmico.
- **Entrada por membership** (sem ticket nominal): evento permite que qualquer membro de `allowed_tiers` entre escaneando a **carteirinha**. Check-in registra `member_id` sem `ticket_id`. Anti-reuso aqui é "uma entrada por membro por evento" (`UNIQUE(event_id, member_id) WHERE result='granted'`), salvo reentrada.

#### 12.8.5 Fraude por screenshot do QR
- QR estático: um print **funciona** até expirar/ser revogado — risco real para eventos.
- Mitigações: (1) **QR dinâmico TOTP-like** para alto risco (print obsoleto em segundos); (2) **anti-reuso** (o primeiro a entrar "queima" o ingresso — o print do amigo é rejeitado como duplicado); (3) **foto na tela do operador** (conferência humana); (4) `exp` curto + reemissão. Combinação de (1)+(2)+(3) cobre a maioria.
- **Não resolvido por design:** dois "amigos" entrando antes de qualquer um queimar o ticket exigem dinâmico+foto. Documentar para o cliente que screenshot só é risco baixo com essas barreiras ligadas.

#### 12.8.6 Leitor/portaria sem internet vs. token dinâmico
- **Tensão de design:** QR dinâmico TOTP exige o servidor (ou o segredo) para validar o passo de tempo. Offline + dinâmico ⇒ o manifesto precisa incluir o `token_secret` de cada passe (no device do operador), o que aumenta a superfície de vazamento. **Decisão técnica:** offline suporta QR **estático** por padrão; offline+dinâmico só com manifesto cifrado e device confiável (gate por evento). Para a maioria dos eventos, offline-estático + anti-reuso + foto é suficiente.

#### 12.8.7 Privacidade & LGPD (§26)
- L0 nunca expõe PII (minimização). A org **não pode** promover PII para L0 (limite de produto, não configurável).
- IP em log é **hasheado**. `verify_access_log` tem retenção curta + particionamento por dia.
- "Membro inativo" genérico em L0/L1 evita vazar que alguém cancelou/foi banido.
- Exclusão/anonimização do membro (LGPD §26) deve **revogar tokens** e fazer a rota responder `not_found` (ou "inativo") sem PII residual.

#### 12.8.8 Outros riscos técnicos
- **Hot path público:** `/v1/public/verify` é a rota mais exposta da plataforma (anônima, pré-evento com pico). Precisa de cache de leitura (status), rate-limit robusto e ser barata. Cuidar de não acoplar a queries pesadas do CRM.
- **Relógio do device offline** não confiável → usar `scanned_at` para ordenar conflitos, mas validar contra `synced_at` para detectar relógios absurdos.
- **Domínio próprio de validação** depende de provisionamento SSL (fundacao) — pode ficar fora do MVP (Q em §30.4 do doc).
- **Idempotência de check-in** fim-a-fim via `client_nonce` é obrigatória (retries de rede não podem duplicar presença).

---

### 12.9 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Edge Functions, RLS multi-tenant, Realtime, pg_cron/pgmq, secret manager, provisionamento de domínio/SSL para `verify.*`. |
| **member-identity** | Resolve o Member ID, normalização/alfabeto, `members.status` que a rota lê; geração de ID. |
| **passport** | Emite os passes e o QR; este domínio cunha/verifica o token e dispara refresh do passe (acoplamento forte com §8). |
| **auth-rbac** | L2 exige papel `operator`/`admin` e permissões de check-in; RLS por papel. |
| **payments-billing** | Mantém `members.status` (active/grace/past_due/canceled) via webhooks Asaas — o que a porta lê em tempo real. |
| **events-tickets** | Cria `events`/`tickets`/lotes; este domínio valida e dá check-in neles. (Acoplamento forte — fronteira a alinhar.) |
| **crm** | Check-in grava `interaction` na timeline e alimenta engajamento. |
| **webhooks** | Emite `event.checkin`, `passport.issued`/revogado. |
| **communication** | Push pós-check-in/revogação (via passport, mas dispara mensagem). |
| **observability-qa** | Métricas da rota pública, taxa de check-in, testes de race/RLS/carga. |
| **security-lgpd** | Política de campos públicos, minimização, anonimização que revoga tokens, DPA. |
| **design-system** | `<VerifyBadge/>`, telas temáveis da portaria e da página pública. |
| **admin-app** | Hospeda o módulo "Validação & Portaria" e as configurações. |
| **member-app** | Hospeda a página pública e (se houver) o gerador de QR dinâmico no PWA. |

---

### 12.10 Escopo MVP vs. depois

Pela §29 (Fase 1 inclui "rota pública de validação + check-in básico"), este domínio **entra no MVP**, mas **fatiado**:

**MVP (Fase 1):**
- Rota pública L0 + L1 com token **estático** assinado (Ed25519) + rotação básica de chave.
- DTO por política de campos públicos (`org_verify_settings`) com defaults conservadores.
- Rate-limit + anti-enumeração + resposta genérica.
- Realtime de revogação na página pública.
- Check-in **online** de evento: anti-reuso, transição atômica, denied por status/duplicado, foto na tela do operador.
- Scanner básico no admin (câmera + digitação manual) + contador de check-in.
- Revogar QR de um membro.
- Webhook `event.checkin` + interação no CRM.

**Depois (Fase 2+):**
- **Check-in offline completo** (manifesto assinado, outbox, sync com resolução de conflito) — XL, é o maior risco; sai do MVP salvo necessidade de cliente âncora com evento sem internet.
- **QR dinâmico TOTP-like** (alto risco) — opt-in pós-MVP.
- **Reentrada / janelas de horário / entrada por membership** — políticas avançadas de portaria.
- **Domínio próprio de validação** por org (depende de provisionamento SSL).
- **Detector de anomalia/enumeração** automatizado (no MVP, rate-limit estático já cobre o básico).
- **Importação Sympla/Ingresse** validável na portaria (junto com events-tickets Fase 2).

---

### 12.11 Perguntas abertas de negócio (para o dono responder antes de desenvolver)

Ver objeto estruturado (`openQuestions`). Resumo das mais críticas: (1) check-in offline entra no MVP? (2) status em grace/past_due passa na porta? (3) defaults de campos públicos/foto; (4) QR dinâmico no MVP e como gerar (PWA vs Wallet); (5) override manual de denied pelo operador; (6) política padrão de reentrada; (7) titularidade/transferência de ingresso afeta a porta.
