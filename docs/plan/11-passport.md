## 11. Passport (Apple Wallet & Google Wallet)

> Domínio que materializa a Stanbase no celular do membro: a **carteirinha de membership** e os **ingressos de evento**, nativos em Apple Wallet e Google Wallet, com atualização dinâmica (push) e QR de verificação assinado.
> Fonte de verdade: STANBASE.md §8 (Passport), §9 (rota pública de validação), §7 (Member ID), §14 (eventos/ingressos), §25.4 (modelo de dados de passes). Decisões imutáveis aplicadas: **Apple + Google desde o MVP**; **Stanbase é o publisher único** (um Pass Type ID Apple + uma Issuer Google), **arte por org**; Member ID = 8 chars sem dígito verificador; **1 membership por org**, N ingressos por membro.

---

### 11.1 Como funciona

#### 11.1.1 Conceitos

- **Passport** = conjunto de passes de um membro num device (1 carteirinha de membership + N ingressos).
- **Pass** = um cartão individual no Wallet. Dois tipos:
  - `membership` — prova de associação, mostra tier/status (Apple `storeCard` ou `generic`; Google `Generic` ou `Loyalty`).
  - `ticket` — ingresso de um evento específico (Apple `eventTicket`; Google `EventTicket`).
- **Publisher único:** a Stanbase assina **todos** os passes com **um** Pass Type ID certificate (Apple) e **uma** service account / Issuer ID (Google). A marca da org entra como **arte/design** (logo, cores, strings), nunca como certificado próprio. Isso evita gerenciar N certificados Apple e N issuers Google.
- **Identidade do passe ≠ Member ID.** O passe é identificado internamente por um **serial** opaco (UUID/random) e protegido por um **auth_token** (Apple) ou **OTP/JWT** (Google). O Member ID aparece como conteúdo legível, mas a segurança vem do **token assinado no QR** (§9.4 do doc).

#### 11.1.2 Máquina de estados do pass

```
                       issue()
        (nenhum) ───────────────────► issued
                                          │ device adiciona (Apple: register device; Google: salvou via JWT)
                                          ▼
                                     registered ◄──────────┐
                                          │                │ refresh/push (tier/status/evento muda)
              membership cancelada/        │                │  → reemite payload, mantém serial
              tier change / suspensão      ▼                │
                                       updated ─────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────┐
        │ membership revogada/expirada     │ ticket usado no check-in     │
        ▼                                  ▼                              ▼
    revoked (membership)             expired (ticket pós-evento)      used (ticket)
        │                                  │                              │
        └──────── push final (voided=true / status visível) ─────────────┘
                                          │
                                          ▼
                                   (device pode remover; serial nunca reusado)
```

Regras concretas da máquina:
- `issued` → `registered`: Apple chama `POST /devices/.../registrations/...` no nosso web service; Google marca o objeto como salvo (callback opcional). Antes de `registered` não há canal de push para aquele device.
- Qualquer mudança relevante (tier, status, "membro desde" não muda; saldo de perks; dados do evento) gera evento de domínio → enfileira **push** → device faz pull do payload novo. Estado lógico → `updated` (não é coluna obrigatória; é derivado de `updated_at`).
- `revoked`: membership cancelada/suspensa/inadimplente além do grace. Para a **carteirinha**, NÃO se apaga o passe do device (não há API para isso). Em vez disso: o payload passa a mostrar **status = Inativo/Revogado**, o QR para de validar online, e em Apple opcionalmente seta `voided=true` (risca o passe). Push final informa o device.
- `expired` (ticket): após `event.ends_at` o ingresso vira passado; Apple usa `relevantDate`/`expirationDate`, Google `EventTicket` com `state=EXPIRED`.
- `used` (ticket): check-in marca uso → push reflete "Utilizado" + horário; anti-reuso garantido no servidor (não só no passe).

#### 11.1.3 Fluxo de emissão (membership) — passo a passo

1. Membro autenticado clica **"Adicionar ao Wallet"** no front (ou via `<AddToWallet/>` embed / API headless).
2. Front chama `POST /v1/passport/issue` com `{ type: "membership", platform: "apple"|"google"|"auto" }`. `auto` deixa o backend detectar plataforma pelo User-Agent.
3. Edge Function `passport-issue`:
   a. Valida que existe `membership` **ativa** para `(member, org)` (status `active`/`trialing`/`grace`). Se inativa → 409 `membership_inactive`.
   b. Resolve a **arte da org** (brand: logo, cor primária/realce, strings de label localizadas).
   c. Cria/recupera registro `passes` (1 membership por member → upsert por `(member_id, type='membership')`). Gera `serial` opaco se novo.
   d. Gera/rotaciona o **verification token** do QR (JTI + `exp` curto + `kid`) e calcula a **URL de verificação** (`https://verify.stanbase.com/{memberId}?token=...` ou domínio da org).
   e. **Apple:** monta `pass.json` + assets (do brand), assina manifest (SHA-1 do conjunto) com o Pass Type ID cert (PKCS#7 detached), zipa em `.pkpass`. Retorna como `application/vnd.apple.pkpass` (download) ou URL temporária no Storage.
   f. **Google:** garante a **Class** da org existe (cria sob demanda, idempotente), faz **upsert do Object** (Generic/Loyalty) via REST, gera o **JWT "Save to Google Wallet"** (assinado pela service account) e retorna o link `https://pay.google.com/gp/v/save/{jwt}`.
   g. Persiste em `passes`: `serial`, `platform`, `auth_token` (Apple) / `google_object_id`, `verification_token_jti`, `status='issued'`.
   h. Emite evento `passport.issued` (webhook + timeline CRM).
4. Device adiciona à carteira. Apple registra o device no nosso web service (→ `registered`). Google salva o objeto.

#### 11.1.4 Fluxo de emissão (ticket)

- Disparado por **compra/atribuição de ingresso** (domínio events-tickets), não pelo membro manualmente: ao confirmar pagamento do ingresso, `tickets` é criado e um job `passport-issue-ticket` gera o pass `ticket` vinculado a `(event_id, member_id, ticket_id)`.
- O front mostra "Adicionar ao Wallet" no ingresso; chama `POST /v1/passport/issue { type:"ticket", ticket_id }` que retorna o pkpass/JWT já pronto.
- Conteúdo: nome do evento, data/hora, local (com `relevantDate`/`locations` para lock-screen Apple e geofence), tier do comprador, QR com token do ingresso (escopo `ticket`), número/lote.

#### 11.1.5 Fluxo de atualização dinâmica (push)

Gatilhos (eventos de domínio que tocam um pass):
- `member.tier_changed` → atualiza label de tier + arte se a arte for por-tier.
- `member.status_changed` (active↔suspended↔canceled↔grace) → atualiza status visível; se revogado, marca/risca.
- `subscription.payment_failed` além do grace → revoga.
- `event.updated` (data/local/horário do evento mudou) → atualiza todos os tickets daquele evento.
- `ticket.checked_in` → marca "Utilizado".
- `passport.token_rotated` (job de rotação) → atualiza QR.

Pipeline:
1. Trigger de banco / Edge Function publica mensagem em **pgmq** `passport_push` com `{ pass_id }` (dedup por `pass_id` + janela curta para coalescer múltiplas mudanças).
2. Worker `passport-push-worker` (consumidor pgmq, acionado por pg_cron a cada ~15s ou por NOTIFY):
   - **Apple:** para cada device registrado do pass, envia **APNs push vazio** (apenas sinaliza). O device então chama `GET /v1/passport/apple/v1/passes/{passTypeId}/{serial}` com header `If-Modified-Since`; respondemos 200 com o `.pkpass` novo (ou 304). Bump em `passes.updated_at` controla o `Last-Modified`.
   - **Google:** chamamos **PATCH** no Object via REST (atualiza campos/estado); a propagação ao device é automática pelo Google. Sem APNs.
3. Marca `passes.last_pushed_at`; em falha, retry com backoff; após N falhas → DLQ + alerta.

#### 11.1.6 Conteúdo do passe (campos)

| Campo | Membership | Ticket | Fonte |
|---|---|---|---|
| Logo + cor da org | ✓ | ✓ | `organizations.brand` |
| Nome do membro | ✓ | ✓ | `member_profiles.name` |
| **Member ID** (formatado `B7K2-M9X4`) | ✓ | ✓ (comprador) | `members.member_id` |
| Tier (label + cor) | ✓ | ✓ | `members.tier_id` |
| Status (Ativo/Inativo) | ✓ | — | `members.status` |
| "Membro desde" | ✓ | — | `members.joined_at` |
| Evento (nome/data/local) | — | ✓ | `events` |
| Lote/assento/nº | — | ✓ | `tickets` |
| **QR** (URL verify + token assinado) | ✓ | ✓ | gerado |

- **i18n:** labels em pt-BR / en-US / es (decisão de produto §30.5). Apple usa `pass.strings` por locale; Google usa `translatedValues`.
- **Privacidade:** foto só entra se a org permitir (config) e respeita a mesma regra da rota pública (§9.2).

#### 11.1.7 Edge cases cobertos

- **Revogação reflete no passe:** sem API para deletar passe remotamente. Estratégia dupla: (a) status visível "Revogado/Inativo" + Apple `voided=true` (risca) / Google `state=INACTIVE`/`EXPIRED`; (b) o **QR para de validar online** imediatamente (rota pública puxa status ao vivo — §9.3). Mesmo que o membro mantenha o cartão no device, ele não valida na portaria.
- **Expiração:** membership não tem expiração natural (recorrente) exceto plano parcelado/único, que tem `access_until` → ao expirar, status vira inativo e dispara revogação visual. Ticket expira em `event.ends_at`.
- **Múltiplos passes por membro:** 1 membership (upsert único) + N tickets (um por `ticket_id`). Push é por `pass_id`, isolado. Mudança de tier NÃO toca tickets; mudança de evento NÃO toca a carteirinha.
- **Rotação do token do QR:** token tem `exp` curto. Job de rotação reemite e dá push. Para eventos de alto risco, QR pode ser **dinâmico (TOTP-like)** renovado pelo device a cada N segundos (campo de rotação no passe + endpoint de refresh). MVP: token rotativo com exp de ~horas + revalidação online.
- **Device sem wallet / navegador desktop:** detectar capacidade. Se sem Apple/Google Wallet → mostrar fallback: **PWA member card** (`<MemberCard/>`) com o mesmo QR + botão "enviar para meu celular" (link por e-mail/SMS) e "copiar link de verificação". Nunca quebrar o fluxo.
- **Plataforma errada:** pedir Apple num Android (ou vice-versa) → backend responde com o link da outra plataforma ou `406 platform_unsupported` com sugestão. `auto` resolve pelo UA.
- **Limites de plataforma:** Apple `.pkpass` deve ser ≤ alguns MB (assets enxutos, PNG @1x/@2x/@3x otimizados); APNs exige certificado/token APNs válido (rotacionar antes do vencimento). Google: limites de QPS na REST API (batch/backoff em campanhas de push em massa), JWT "Save" tem limite de tamanho (referenciar Class por ID, não inline objetos grandes).
- **Mudança de número/troca de celular:** membro reabre "Adicionar ao Wallet" → reemite mantendo `serial`; novos registros de device se acumulam; devices inativos são limpos (Apple manda `DELETE registration` no unregister).
- **Org troca a marca/arte:** novo `brand_version`; passes existentes ficam desatualizados visualmente até o próximo push. Job opcional de re-push em massa após troca de arte (respeitando QPS Google e janela APNs).

---

### 11.2 Modelo de dados

Base existente em STANBASE.md §25.4 (`passes`). Expandido abaixo. Toda tabela carrega `org_id` e RLS por `org_id`.

#### `passes` (expandida)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK organizations | RLS |
| `member_id` | uuid FK members | dono do passe |
| `type` | enum `membership`/`ticket` | |
| `platform` | enum `apple`/`google` | um registro por plataforma; membro pode ter os dois |
| `serial` | text | opaco, UNIQUE global; **nunca reusado** |
| `auth_token` | text | Apple PassKit authenticationToken (cifrado) |
| `google_object_id` | text | `{issuerId}.{suffix}` para Google |
| `ticket_id` | uuid FK tickets NULL | só para `type='ticket'` |
| `event_id` | uuid FK events NULL | denormalizado p/ push em massa por evento |
| `brand_version` | int | versão da arte aplicada; detecta desatualização |
| `verification_token_jti` | text | JTI do token corrente do QR |
| `verification_token_exp` | timestamptz | expiração do token do QR |
| `status` | enum `issued`/`registered`/`revoked`/`expired`/`used` | |
| `voided` | boolean default false | Apple voided / Google inactive |
| `last_pushed_at` | timestamptz | última tentativa de push |
| `updated_at` | timestamptz | controla `Last-Modified` Apple |
| `created_at` | timestamptz | |

Constraints/índices:
- UNIQUE `(member_id, type, platform)` onde `type='membership'` (1 carteirinha por plataforma por membro). Para tickets, UNIQUE `(ticket_id, platform)`.
- UNIQUE `serial`.
- Index `(org_id, status)`, `(event_id)` (push por evento), `(verification_token_exp)` (job de rotação), `(member_id)`.

#### `pass_devices` (nova — registros de device Apple PassKit)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `pass_id` | uuid FK passes | |
| `device_library_id` | text | `deviceLibraryIdentifier` Apple |
| `push_token` | text | APNs push token (cifrado) |
| `platform` | enum `apple` | (Google não usa este registro) |
| `active` | boolean | unregister → false |
| `registered_at` / `unregistered_at` | timestamptz | |

- UNIQUE `(pass_id, device_library_id)`. Index `(device_library_id)` (lookup do web service Apple).

#### `pass_verification_tokens` (nova — histórico/rotação de tokens do QR)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `pass_id` | uuid FK passes | |
| `jti` | text UNIQUE | |
| `scope` | enum `membership`/`ticket` | escopo do que o token valida |
| `kid` | text | key id usado p/ assinatura (rotação de chaves) |
| `issued_at` / `expires_at` | timestamptz | |
| `revoked` | boolean | invalidação imediata (revogação) |

- Index `(pass_id, revoked, expires_at)`. Tokens antigos mantidos para auditoria; verificação rejeita `revoked=true` ou expirados.

#### `wallet_classes` (nova — controle de Google Class / Apple template por org+tipo)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `type` | enum `membership`/`ticket` | |
| `google_class_id` | text | `{issuerId}.{slug}-{type}` |
| `google_class_synced_at` | timestamptz | última sync da Class |
| `brand_version` | int | arte aplicada na Class |

- UNIQUE `(org_id, type)`. Garante criação idempotente da Class antes de emitir Objects.

#### `wallet_signing_keys` (nova — segredos de plataforma, escopo global Stanbase, fora de RLS de org)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `kind` | enum `apple_passtype_cert`/`apple_apns`/`google_sa`/`qr_jwt` | |
| `kid` | text | identificador da chave (rotação) |
| `secret_ref` | text | ponteiro p/ secret manager (não o segredo cru) |
| `active` | boolean | |
| `not_after` | timestamptz | vencimento (alerta de rotação) |

> Segredos crus (cert Apple, APNs key, SA JSON Google, chave de assinatura JWT do QR) ficam no **secret manager / Supabase Vault**, nunca em coluna. Esta tabela só rastreia metadados e rotação.

Tabelas tocadas de outros domínios (apenas leitura/gatilho): `members`, `member_profiles`, `tiers`, `subscriptions`, `events`, `tickets`, `checkins`, `organizations` (brand), `audit_logs`.

---

### 11.3 API & Edge Functions

#### Endpoints públicos `/v1` (camada Edge, DTOs limpos)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/passport/issue` | Emite/recupera pass (`type`, `platform`, `ticket_id?`); retorna `.pkpass` ou link Save-to-Google. Idempotente por `(member, type, ticket_id)`. |
| POST | `/v1/passport/{memberId}/refresh` | Força reemissão + push (admin/membro): rotaciona token, reaplica brand. |
| GET | `/v1/passport/{memberId}/passes` | Lista passes do membro (status, plataforma, tipo). |
| POST | `/v1/passport/{passId}/revoke` | Revoga (admin): seta status revogado, void, invalida tokens, push final. |
| GET | `/v1/public/verify/{memberId}` | Validação pública (token opcional) — owner: verification-checkin, consumido pelo QR. |

#### Web service Apple PassKit (rotas exigidas pelo protocolo, Edge Function `passport-apple-webservice`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/passport/apple/v1/devices/{deviceLibId}/registrations/{passTypeId}/{serial}` | Registra device (cria `pass_devices`, salva push token). |
| DELETE | `/v1/passport/apple/v1/devices/{deviceLibId}/registrations/{passTypeId}/{serial}` | Unregister (device removeu o passe). |
| GET | `/v1/passport/apple/v1/devices/{deviceLibId}/registrations/{passTypeId}?passesUpdatedSince=` | Lista seriais com updates pendentes p/ o device. |
| GET | `/v1/passport/apple/v1/passes/{passTypeId}/{serial}` | Retorna `.pkpass` atualizado (`If-Modified-Since` → 200/304). |
| POST | `/v1/passport/apple/v1/log` | Recebe logs de erro do device (gravar p/ debug). |

> Autenticação dessas rotas: header `Authorization: ApplePass {auth_token}` validado contra `passes.auth_token`.

#### Google Wallet (chamadas de saída, dentro das functions)
- Criação/Upsert de **Class** (`genericClass`/`loyaltyClass`/`eventTicketClass`) via REST.
- Upsert de **Object** + **PATCH** para updates.
- Geração de **JWT** `save` assinado pela service account.

#### Jobs / workers
| Job | Trigger | Descrição |
|---|---|---|
| `passport-push-worker` | pgmq `passport_push` (pg_cron ~15s) | Consome fila, dispara APNs (Apple) / PATCH (Google). |
| `passport-token-rotation` | pg_cron diário/horário | Rotaciona tokens do QR perto do `exp`, enfileira push. |
| `passport-brand-resync` | manual/admin | Re-sync de Class Google + re-push após troca de arte da org. |
| `passport-apns-cert-monitor` | pg_cron diário | Alerta vencimento de cert Apple/APNs/SA Google (`wallet_signing_keys.not_after`). |
| `passport-issue-ticket` | evento `ticket.created` (pago) | Gera pass de ingresso automaticamente. |
| `passport-device-cleanup` | pg_cron semanal | Limpa `pass_devices` inativos. |

#### Eventos de domínio emitidos (webhooks §22)
`passport.issued`, `passport.updated`, `passport.revoked`, `passport.token_rotated`.

---

### 11.4 Telas / Front

#### Membro (front hosted temável + embeds)
- **Botão "Adicionar ao Wallet"** (`<AddToWallet/>`): detecta plataforma, mostra badge oficial Apple/Google. Estados: carregando, sucesso, erro, "device sem wallet" → fallback.
- **Member Card / carteirinha** (`<MemberCard/>`): render web do passe (logo org, Member ID formatado, tier, status, "membro desde", QR). Serve de fallback quando não há Wallet e como preview.
- **Tela de ingresso**: na lista de eventos/ingressos, botão "Adicionar ao Wallet" por ingresso + QR.
- **Fallback "enviar ao celular"**: link por e-mail/SMS quando em desktop.
- **Estado revogado/expirado**: card mostra status claramente; sem botão de adicionar se inativo.

#### Admin (painel padronizado)
- **Configuração de arte do passe** (em Configurações → Marca/Tema): logo, cor primária/realce, escolher tipo (storeCard vs generic / loyalty), preview lado a lado Apple/Google, strings/labels, toggle "mostrar foto no passe".
- **Aba Passport no perfil do membro (CRM)**: passes ativos, plataforma, status, ações **reemitir / revogar / re-push**, histórico de pushes.
- **Painel de saúde do Passport** (Configurações → Desenvolvedores/Integrações): status dos certificados (vencimento APNs/Apple/Google), fila de push, taxa de erro, devices registrados.
- **Ação em massa**: "republicar passes" após troca de arte.

#### Componentes principais
`<AddToWallet/>`, `<MemberCard/>`, `<PassPreview platform/>`, `<PassportHealthBadge/>`, `<MemberPassportPanel/>` (admin).

---

### 11.5 Integrações externas

| Serviço | Como integra |
|---|---|
| **Apple Wallet / PassKit** | Pass Type ID certificate (1 da Stanbase) p/ assinar `.pkpass`; web service de updates hospedado em Edge Functions; **APNs** (token-based auth p256 `.p8` preferível a cert) p/ push de "tem update". |
| **Google Wallet API** | Service account (1 Issuer Stanbase); REST p/ Class/Object + PATCH; JWT "Save to Google Wallet" assinado pela SA. Requer conta Google Wallet API Issuer aprovada. |
| **Supabase Storage** | Hospeda assets de arte por org (logos otimizados @1x/@2x/@3x) e, opcionalmente, `.pkpass` temporários. |
| **Secret manager / Supabase Vault** | Guarda cert Apple, `.p8` APNs, SA JSON Google, chave de assinatura do JWT do QR. |
| **pgmq + pg_cron** | Fila e agendamento de pushes/rotação. |
| **verification-checkin (interno)** | A rota pública de verificação valida o token do QR e devolve status ao vivo. |
| **Asaas (indireto)** | Eventos de pagamento → status de membership → gatilho de update/revogação do passe. |

---

### 11.6 Épicos & tarefas

#### Épico A — Infra de assinatura e segredos
- A1. Provisionar Pass Type ID + cert Apple; gerar `.p8` APNs token-based; documentar rotação. **M**
- A2. Criar Issuer Google Wallet + service account; aprovar conta Issuer. **M**
- A3. Tabela `wallet_signing_keys` + Vault refs; helper de carregar/rotacionar chaves. **M**
- A4. Gerar par de chaves p/ JWT do QR (assinatura ES256) + `kid`/rotação. **S**

#### Épico B — Geração e assinatura Apple (.pkpass)
- B1. Builder de `pass.json` por tipo (storeCard/generic membership; eventTicket). **L**
- B2. Pipeline de assets (resize/otimização) a partir do brand da org. **M**
- B3. Assinatura PKCS#7 do manifest + zip `.pkpass` em Deno (lib WASM/openssl). **L**
- B4. Endpoint `POST /v1/passport/issue` (Apple) + persistência em `passes`. **M**
- B5. i18n `pass.strings` (pt-BR/en-US/es). **S**

#### Épico C — Web service PassKit + APNs
- C1. Rotas de registration/unregister/list/get pass + auth `ApplePass`. **L**
- C2. `If-Modified-Since`/`Last-Modified` + 304 handling. **S**
- C3. Cliente APNs (token-based) p/ push vazio. **M**
- C4. `pass_devices` (registro, cleanup, multi-device). **M**
- C5. Endpoint de log Apple. **S**

#### Épico D — Google Wallet
- D1. Criação idempotente de Class por org+tipo (`wallet_classes`). **M**
- D2. Upsert de Object (Generic/Loyalty/EventTicket). **M**
- D3. Geração do JWT "Save to Google Wallet". **S**
- D4. Updates via PATCH no Object + tratamento de QPS/backoff. **M**
- D5. `translatedValues` i18n. **S**

#### Épico E — QR, token e verificação
- E1. Emissão de token assinado (JTI+exp+kid+scope) + `pass_verification_tokens`. **M**
- E2. Job de rotação `passport-token-rotation` + invalidação na revogação. **M**
- E3. Geração do payload do QR (URL verify + token) por escopo. **S**
- E4. (Pós-MVP) QR dinâmico TOTP-like para eventos de alto risco. **L**

#### Épico F — Atualização dinâmica (push)
- F1. Triggers de domínio → enfileira `passport_push` (dedup/coalesce). **M**
- F2. `passport-push-worker` (Apple APNs + Google PATCH), retry/backoff/DLQ. **L**
- F3. Mapeamento de gatilhos: tier/status/evento/checkin/rotação. **M**
- F4. `passport-brand-resync` (re-push após troca de arte). **M**

#### Épico G — Tickets no passport
- G1. `passport-issue-ticket` automático na compra. **M**
- G2. Campos de evento (relevantDate/locations Apple; EventTicket Google). **M**
- G3. Estado `used`/`expired` refletido via push (integra check-in). **M**

#### Épico H — Front
- H1. `<AddToWallet/>` com detecção de plataforma + badges oficiais. **M**
- H2. `<MemberCard/>` (fallback/preview web). **M**
- H3. Fallback desktop "enviar ao celular". **S**
- H4. Admin: editor de arte do passe + preview Apple/Google. **L**
- H5. Admin: painel Passport no CRM (reemitir/revogar/re-push). **M**
- H6. Admin: painel de saúde (certs, fila, devices). **M**

#### Épico I — Observabilidade & operação
- I1. `passport-apns-cert-monitor` + alertas de vencimento. **S**
- I2. Métricas: emissões, pushes, taxa de erro APNs/Google, latência. **M**
- I3. Logs estruturados + DLQ + replay manual de push. **M**

---

### 11.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | org/RLS/Storage/pgmq/pg_cron, Member ID já gerado, secret manager. |
| **member-identity** | Member ID, serial, relação pessoa×org; o passe é a materialização da carteirinha. |
| **tiers-perks** | Tier/label/cor/arte por tier exibidos no passe; mudança de tier dispara push. |
| **payments-billing** | Status da membership (ativo/grace/cancelado/inadimplente) que define revogação/expiração; plano parcelado define `access_until`. |
| **verification-checkin** | Consome o token do QR (verificação online) e o check-in marca `used`; é o par natural do Passport. |
| **events-tickets** | Geração de passes de ingresso, dados do evento, estados used/expired. |
| **design-system** | Tokens de marca e componentes `<AddToWallet/>`/`<MemberCard/>`. |
| **admin-app / member-app** | Telas de configuração de arte, painel CRM e botões no front. |
| **webhooks** | Emissão de `passport.*`. |
| **public-api / mcp** | Expor issue/verify; MCP "emita a carteirinha do membro X" (§23). |
| **security-lgpd** | Minimização de PII no passe e na verificação; DPA com Apple/Google. |
| **observability-qa** | Monitor de certs, filas e taxa de erro. |

---

### 11.8 Riscos & decisões técnicas

- **Assinatura de `.pkpass` em Deno/Edge:** PKCS#7 detached não é trivial em runtime serverless. Risco de cold start/limite de CPU. Mitigação: lib WASM (node-forge/openssl-wasm) ou function dedicada com warmup; medir tempo de assinatura; cachear assets já assinados quando só o token muda? (não dá — manifest cobre tudo; minimizar payload).
- **Revogação não apaga o passe do device:** decisão de produto crítica — a segurança real está no **QR online** (rota verify puxa status ao vivo) e no **void/inactive** visual, não em remover o cartão. Documentar para o dono que "o membro pode ter o cartão riscado no celular, mas ele não valida".
- **Apple sem push de atualização garantido:** APNs só sinaliza; o device decide quando puxar (pode demorar/estar offline). Ingressos/portaria NÃO dependem do push — dependem da verificação online no scan. O passe é conveniência; a verdade é o servidor.
- **QPS e cotas Google em push em massa:** troca de arte / campanha de re-push pode estourar limites. Mitigar com fila + backoff + janelas.
- **Rotação de certificados/keys:** APNs `.p8`, Pass Type cert e SA Google vencem; monitor obrigatório (job I1) — vencimento silencioso quebra todos os passes.
- **Token do QR — janela de exp vs. UX:** exp muito curto = QR "morre" offline; muito longo = janela de fraude. MVP: exp de horas + revalidação online sempre; TOTP só para eventos de alto risco (pós-MVP).
- **Tamanho do `.pkpass` / assets por org:** logos pesados estouram limite; pipeline de otimização obrigatório (B2).
- **Multi-device e troca de aparelho:** acúmulo de `pass_devices`; cleanup + tratar unregister corretamente para não fazer push para tokens mortos (APNs retorna `Unregistered` → desativar device).
- **Idempotência de Class/Object Google:** criar Class duas vezes dá erro; usar get-or-create + ignore-already-exists.
- **1 membership por org × N orgs:** uma pessoa em 2 orgs tem 2 carteirinhas distintas (2 serials, 2 Member IDs) — o `<AddToWallet/>` opera sempre no contexto da org corrente.
- **Brand desatualizada:** passes não se atualizam sozinhos ao trocar arte; só no próximo push. `brand_version` detecta e o `passport-brand-resync` corrige sob demanda.

---

### 11.9 Escopo MVP vs. depois

**MVP (Fase 1 — §29 do doc, "Passport Apple + Google + validação + check-in básico"):**
- Carteirinha de membership Apple (`.pkpass` storeCard/generic) **e** Google (Generic/Loyalty), emissão via `POST /v1/passport/issue`.
- Conteúdo completo do passe: marca org, nome, Member ID, tier, status, "membro desde", QR com token assinado.
- Web service PassKit + APNs (push de atualização) + Google PATCH.
- Atualização dinâmica em mudança de tier/status + **revogação** refletida (void/inactive + QR offline).
- `<AddToWallet/>`, `<MemberCard/>` fallback, editor básico de arte no admin, painel Passport no CRM.
- Ingresso no passport (Apple eventTicket + Google EventTicket) com QR e estado used/expired — **se** events-tickets entrar no MVP (caso entre só venda básica, manter ticket pass no MVP por ser barato dado o motor pronto).
- Monitor de vencimento de certificados.

**Depois:**
- QR dinâmico TOTP-like para eventos de alto risco.
- Arte por-tier (vs. por-org) e temas avançados de passe.
- Re-push em massa orquestrado por campanhas de marca.
- Geofence/locations avançado e `relevantDate` rico nos ingressos.
- App nativo (passes já são nativos via Wallet; app é separado e fora da v0 — §30.2).
- Suporte a Apple "share pass" e Google grouping multi-pass.
