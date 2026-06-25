## 27. Segurança & LGPD

> Fonte de verdade: `STANBASE.md` §26 (segurança, permissões e LGPD), reforçado por §9.2/§9.3 (minimização na rota pública), §13/§25.3 (registros financeiros que **não** podem ser apagados), §20.1/§25.6 (`connections` cifrada), §22 (HMAC de webhooks), §6 (stack: Postgres/RLS, Edge Functions, Vault, pgmq, pg_cron). Este domínio é **transversal**: não cria features novas de produto, mas define o **contrato de segurança e compliance** que todos os outros domínios obedecem. Onde `auth-rbac` (§06) entrega o *mecanismo* (RLS, claims, RBAC, audit base), este domínio entrega a **prova, a governança e os direitos do titular**.
>
> **Escopo deste documento:**
> 1. **Provar** isolamento por org (testes de RLS no CI — não só ter políticas, mas demonstrar que vazam zero).
> 2. **Cifrar** segredos e tokens de integração (Vault/pgsodium/secret manager) com helpers únicos e rotação.
> 3. **Auditar tudo** (audit log imutável, append-only, com retenção e exportação).
> 4. **LGPD operacional:** base legal e consentimento por canal, direitos do titular (acesso/portabilidade, retificação, anonimização/eliminação), minimização na rota pública, DPA com sub-processadores, PCI delegado ao Asaas, resposta a incidente, retenção, menores de idade.
>
> **Decisões imutáveis herdadas:** PSP = Asaas (PCI fica no Asaas — Stanbase **nunca** vê PAN/CVV); RLS por `org_id` em toda tabela de domínio; segredos nunca chegam ao front; Member ID sem dígito verificador (autenticidade vem do token assinado, não do ID — §07/§09); 1 membership por org; Edge Functions TS/Deno; OpenAPI como contrato. Isolamento de dados é **por org**, não por Conta — o titular pode ter dados em N orgs e cada uma é controladora independente (ver §1.10 deste doc).

---

### 1. Como funciona

#### 1.1 Modelo de responsabilidade LGPD (quem é o quê)

A distinção **controlador × operador** é a espinha dorsal do compliance e muda o produto inteiro:

| Papel LGPD | Quem | Implicação |
|---|---|---|
| **Controlador** | A **org** (dono do membership) | Decide finalidade e meios do tratamento dos dados dos **seus** membros. É quem responde a um titular que pede exclusão, quem define base legal das campanhas. |
| **Operador** | A **Stanbase** | Trata dados **em nome** da org, conforme instruções. Fornece as ferramentas (export, anonimização, consentimento) mas não decide finalidade. |
| **Controlador (dados próprios)** | A **Stanbase** | Para os dados dos **operadores/staff** (`auth.users`, `org_users`), billing da plataforma, logs técnicos — aí a Stanbase é controladora. |
| **Sub-operadores** | Supabase, Asaas, provedor LLM, Apple/Google Wallet, e-mail/push | Sub-processadores que a Stanbase contrata; exigem DPA + cláusula de sub-tratamento (ver §5). |

> **Consequência crítica de produto:** a Stanbase **não** decide sozinha apagar um membro — ela **executa** o pedido que a org (controladora) aprova/recebe, ou que o próprio titular faz via portal e a org não bloqueia. O fluxo de direitos do titular (§1.6) tem sempre um **ponto de decisão da org**. A Stanbase só age unilateralmente sobre dados onde ela é controladora (staff, billing da plataforma) ou por ordem legal.

#### 1.2 As quatro camadas de defesa (defense in depth)

```
┌─ Camada 1 — RLS (Postgres) ──────────────────────────────┐
│  toda tabela de domínio: org_id = auth.active_org_id()    │
│  + auth.has_perm(módulo, ação). Falha-fechado por default.│
├─ Camada 2 — Edge Function (revalidação live) ────────────┤
│  ações sensíveis (financeiro, LGPD, equipe) revalidam     │
│  org_users.status='active' ao vivo — não confiam só no JWT│
├─ Camada 3 — Cifragem em repouso ─────────────────────────┤
│  segredos/tokens (connections, asaas, wallet, webhooks)   │
│  cifrados (Vault/pgsodium); front nunca lê a coluna.      │
├─ Camada 4 — Auditoria + detecção ────────────────────────┤
│  audit_logs append-only de toda ação sensível; access log │
│  de leitura de PII; alertas de anomalia.                  │
└──────────────────────────────────────────────────────────┘
```

A premissa é **falha-fechado**: na ausência de claim/permissão válida, a RLS nega; a Edge Function nega; nunca o contrário. O Custom Access Token Hook (§06) sem org ativa retorna **acesso mínimo**, não total.

#### 1.3 Testes de RLS — provar o isolamento (não só ter as políticas)

Ter `USING (org_id = auth.active_org_id())` não é prova; uma policy esquecida, um `SECURITY DEFINER` mal escrito, uma view sem RLS ou um `GRANT` largo vazam tudo. O domínio exige uma **suíte de testes de isolamento que roda no CI e bloqueia o merge**.

**O que a suíte prova (matriz de ataque):**

1. **Cross-tenant SELECT:** sessão autenticada como staff da Org A (claim `active_org_id = A`) **não** retorna **nenhuma** linha de Org B em **toda** tabela de domínio. Loop automático sobre o catálogo de tabelas (`information_schema`) — toda tabela com coluna `org_id` é testada; nova tabela sem teste = falha no CI.
2. **Cross-tenant WRITE:** Org A não consegue INSERT/UPDATE/DELETE com `org_id = B` (o `WITH CHECK` rejeita).
3. **RLS habilitada em todas:** assert de que **toda** tabela de domínio tem `rowsecurity = true` e ≥1 policy; tabela nova sem RLS = falha.
4. **Sem bypass por role:** `anon` e `authenticated` não têm `BYPASSRLS`; só a `service_role` (Edge) bypassa, e seu uso é auditado.
5. **Views e funções:** views herdam RLS das tabelas base ou são `security_invoker`; funções `SECURITY DEFINER` são auditadas uma a uma (lista branca revisada).
6. **Operator escopado:** operator com `permissions = {validation_checkin:[scan,read]}` **não** lê `members` completo, `transactions`, `notes`, `connections.credentials`.
7. **Enumeração da rota pública:** `GET /v1/public/verify/{id}` sem token retorna só campos mínimos; com `member_id` inexistente, resposta indistinguível (anti-enumeração) e rate-limited.
8. **Coluna de segredo:** nenhuma role exceto `service_role` faz SELECT em `connections.credentials` / colunas cifradas; a view pública não expõe a coluna.

**Como roda:** seeds plantam 2 orgs com dados cruzados; testes `pgTAP` (no banco) + testes de integração em Deno (via PostgREST/Edge com JWTs forjados de A e B) assertam zero vazamento. Roda em cada PR; **gate de merge**. Cada domínio que adiciona tabela **deve** adicionar o caso de teste — esse é o contrato.

> **Edge case (o mais perigoso):** uma migration futura cria tabela `org_id`-scoped mas esquece `ENABLE ROW LEVEL SECURITY` ou a policy. Mitigação: o teste 3 falha o CI por **omissão** (varre o catálogo, não uma lista manual), e um lint de migration alerta no PR.

#### 1.4 Cifragem de segredos e tokens (KMS / secret manager)

Tudo que é **credencial, token, segredo ou chave** é cifrado em repouso e **nunca** trafega ao front.

**Inventário de segredos (o que é cifrado e onde):**

| Segredo | Onde mora | Mecanismo |
|---|---|---|
| Tokens OAuth/refresh de integração (Discord, Google, Twitch…) | `connections.credentials` (por org) | cifrado em coluna (pgsodium/Vault) — §19 já define helper `loadCredentials` |
| Subconta/wallet/API key Asaas (por org) | `asaas_subaccounts` / `connections` | cifrado em coluna |
| Webhook outbound `secret` (HMAC) | `webhooks.secret` | cifrado; usado só em Edge p/ assinar |
| `org_invites.token` | só **hash** persistido | hash (nunca o token cru) |
| `api_keys` | só **hash** persistido (`api_keys.hash`) | hash; a chave crua só aparece 1× na criação |
| Pass auth tokens (`passes.auth_token`) | cifrado/curto + rotação | §08/§11 |
| Chaves de plataforma (Apple Pass Type cert, Google Wallet service account, LLM key, e-mail provider key) | **secrets de Edge por ambiente** (não no DB) | Supabase secrets / secret manager; nunca em tabela |

**Regras invioláveis:**
- **Front recebe metadados, nunca o segredo.** RLS expõe **view sem a coluna de segredo**; a coluna crua só é lida pela `service_role` em Edge. Um SELECT do front em `connections` retorna `provider, status, scopes, expires_at, external_account` — jamais `credentials`.
- **Decifra só em memória, nunca loga.** Helper `loadCredentials(connection_id)` / `loadSecret(ref)` decifra, devolve em memória, e há um **lint/teste que proíbe `console.log` de objetos de credencial** (chaves `credentials|token|secret|key|password` redigidas no logger estruturado — ver §1.8).
- **Rotação:** chave de cifragem (DEK) rotacionável; segredos OAuth rotativos (Google rotaciona refresh a cada uso — persistir o novo, §19). Rotação de chave mestra → re-cifragem em batch (job).
- **Segregação por ambiente:** segredos de app (client_id/secret OAuth, certs) **diferentes** por dev/staging/prod; nunca usar prod em staging (§19).

> **Decisão técnica (Vault vs pgsodium vs secret manager externo):** MVP usa **pgsodium/Supabase Vault** para segredos por-org em coluna (simples, dentro do Postgres, RLS aplica) e **Supabase Edge secrets** para chaves de plataforma. Um `secret manager` externo (ex.: cloud KMS) fica como evolução se a auditoria/compliance exigir HSM ou se houver requisito de chave gerenciada pelo cliente (BYOK) — Open Question §8.

#### 1.5 Auditoria — log de tudo, imutável

**Dois logs distintos:**

1. **`audit_logs` (ações mutantes):** quem fez o quê, em qual alvo, quando, de onde. **Append-only** (sem UPDATE/DELETE por ninguém exceto retenção automatizada). Já é produzido por todos os domínios (§06 lista as ações de auth; §19 as de connection; §10 as financeiras). Este domínio define o **contrato**, a **imutabilidade** e a **retenção**.
2. **`pii_access_logs` (leitura de dados sensíveis):** quem **leu** PII e por quê. LGPD exige rastrear não só escrita mas acesso a dado pessoal sensível (ex.: staff abriu o perfil 360º de um membro, exportou a base, viu CPF/telefone). Registrado pela Edge em leituras sensíveis e exports.

**O que é auditado (mínimo obrigatório):**
- Toda ação de RBAC/equipe (convite, mudança de papel, revogação, transferência de posse).
- Toda ação financeira (cobrança, reembolso, payout, mudança de método).
- Todo exercício de direito do titular (export, retificação, anonimização, exclusão) — **com base legal e o ator (titular vs staff vs Stanbase)**.
- Toda mudança de consentimento (opt-in/opt-out por canal) com timestamp, origem (IP/user-agent ou tela), e versão do texto consentido.
- Toda conexão/desconexão de integração e acesso a `credentials`.
- Todo uso da `service_role` / bypass de RLS (Edge que escreve com privilégio elevado).
- Todo acesso super-admin a dados de uma org (cross-tenant pelo Stanbase Staff — §superadmin).

**Imutabilidade:** `audit_logs` e `consent_records` são **append-only**: trigger `BEFORE UPDATE OR DELETE` que `raise exception` (exceto job de retenção com flag). Idealmente um hash encadeado (`prev_hash`) para detectar adulteração (tamper-evidence) — MVP pode ser só append-only + permissão restrita; hash-chain é evolução.

**Edge case — auditar o auditor:** super-admin da Stanbase que acessa dados de uma org gera entrada de audit **na org** (visível ao owner) e no log interno. Acesso de suporte é por **consentimento/ticket** e expira (não acesso permanente). Sem isso, a org não confia.

#### 1.6 Direitos do titular — máquina de estados do DSAR

DSAR = *Data Subject Access Request*. O titular (membro) ou a org em nome dele exerce: **acesso/portabilidade**, **retificação**, **anonimização**, **eliminação**, **revogação de consentimento**, **oposição**.

```
        request criado (titular no portal OU staff no admin OU API)
                 │
                 ▼
        ┌─────────────────┐
        │   RECEIVED       │  (registra base legal, tipo, prazo legal: 15 dias resposta)
        └────────┬─────────┘
                 │ verificação de identidade do titular (§1.6.1)
                 ▼
        ┌─────────────────┐
        │   VERIFIED       │
        └────────┬─────────┘
                 │ avaliação de impedimentos (financeiro? menor? owner de org?)
        ┌────────┴─────────────────────┐
        ▼                              ▼
 ┌─────────────┐               ┌──────────────────┐
 │  APPROVED    │              │  PARTIAL / HELD   │ (ex.: exclusão vira
 └──────┬──────┘               │                  │  anonimização porque há
        │ executa job          │                  │  transação fiscal a reter)
        ▼                      └────────┬─────────┘
 ┌─────────────┐                        │
 │  COMPLETED   │ ◄──────────────────────┘ (executa a parte permitida + explica a retida)
 └─────────────┘
        │  (ou)
        ▼
 ┌─────────────┐
 │  REJECTED    │  (pedido improcedente/abusivo — registra motivo)
 └─────────────┘
```

**Por tipo de direito:**

- **Acesso / Portabilidade (export):** gera um pacote (JSON + CSV legível) com **todos** os dados do titular **naquela org**: perfil, atributos, membership, histórico de tiers, transações (resumo financeiro), interações/timeline, consentimentos, entitlements, presença em eventos, conquistas. Pacote em Storage com **URL assinada de expiração curta**, entregue ao titular. Auditado. **Escopo é por org** — export não cruza orgs (o membro tem identidades separadas por org).
- **Retificação:** titular corrige nome/e-mail/telefone/atributos. Direto via portal de privacidade ou pedido ao staff. Auditado (valor antes/depois no audit, mas o **valor antigo de PII não fica em claro** no audit — guarda hash/diff redigido).
- **Anonimização:** desidentifica o registro **preservando relações e agregados**: substitui PII por tokens (`member_id` vira pseudônimo, nome → "Membro anonimizado", e-mail/telefone → null, foto removida do Storage), mas **mantém** `transactions`, `subscriptions`, `payouts`, `entitlements`, presença, conquistas — porque são registro financeiro/operacional legítimo. O membro deixa de ser identificável; os números continuam batendo.
- **Eliminação:** o ideal LGPD ("apagar"), mas **limitado por obrigação legal** (§1.7) — na prática, eliminação de um membro com histórico financeiro **vira anonimização** dos dados pessoais + retenção do registro financeiro pelo prazo legal, e **hard delete** só do que não tem amarração legal (foto, atributos livres, notas, consentimentos de marketing). Isso é explicado ao titular.
- **Revogação de consentimento:** opt-out de um canal → para de receber por aquele canal imediatamente; não apaga histórico de envio (registro de que houve comunicação permanece).
- **Oposição ao tratamento:** ex.: oposição a perfilamento por IA → membro sai dos jobs de churn/segmentação por IA (flag `ai_opt_out`), mas mantém membership.

##### 1.6.1 Verificação de identidade do titular (anti-fraude do DSAR)
Antes de exportar/apagar, **provar que é o titular** — senão um atacante pede a base do rival. Verificação:
- Se o titular está **logado** (sessão do front do membro) → identidade já provada pelo Supabase Auth; ação direta.
- Se o pedido vem por **canal externo** (e-mail de privacidade, formulário público) → desafio: confirmar via e-mail/telefone cadastrado (link mágico) + opcionalmente Member ID. **Nunca** liberar export por simples afirmação de e-mail.
- Pedido feito por **staff** em nome do titular → exige registro de **base legal/autorização** e é auditado como "ação de terceiro".

#### 1.7 Anonimização vs. histórico financeiro (o edge case central)

O conflito: LGPD dá direito à eliminação, mas a lei fiscal/contábil/regulatória obriga **reter registros financeiros** (transações, comprovantes, dados de cobrança) por anos (tipicamente 5+ anos para fins fiscais/contábeis no Brasil). Esses dois colidem para todo membro que **já pagou algo**.

**Resolução implementada:**

1. **Separar PII de registro financeiro no modelo.** `transactions`/`subscriptions`/`payouts` referenciam o membro por **chave pseudônima estável** (`member_uuid`), e a PII identificável (nome, e-mail, CPF, telefone) vive em `member_profiles` (apagável). O registro financeiro guarda só o **mínimo legal** (valor, data, método, ref Asaas, e o pseudônimo) — não duplica nome/e-mail.
2. **Exclusão = anonimizar PII + reter financeiro.** Ao "excluir" um membro com transações: `member_profiles` é desidentificado (PII → null/token), foto removida do Storage, notas/atributos livres apagados, consentimentos de marketing apagados; `transactions` permanecem **intactas** mas agora apontam para um pseudônimo não-reidentificável. O **Member ID nunca é reutilizado** (§07) — fica como pseudônimo morto.
3. **CPF/dado fiscal:** se houver CPF capturado para NF (pós-MVP), ele é retido **somente** enquanto a obrigação fiscal exigir, depois purgado por job de retenção (§1.9). No MVP a Stanbase não emite NF (§10) e tende a **não** capturar CPF — minimização.
4. **Reversibilidade:** anonimização é **irreversível** por design (não guardamos a tabela-mapa pseudônimo→PII). Isso é o ponto: se fosse reversível, não seria anonimização (continuaria sendo dado pessoal). Avisar o titular que é definitivo.
5. **Chargeback/dispute após anonimização:** edge case real — membro anonimizado e depois chega chargeback. Como o registro financeiro foi preservado (com pseudônimo + ref Asaas), o dispute é tratável sem reidentificar a pessoa; a evidência (IP, log de entrega de acesso) ficou no registro financeiro, não no perfil. Se a defesa do chargeback exigir reidentificação, é uma exceção legal (legítimo interesse/defesa de direito) — registrada e limitada.

#### 1.8 Minimização na rota pública (LGPD by design)

A rota pública de validação (`verify.stanbase.com/{memberId}`, §09) é o ponto de **maior exposição de PII** porque qualquer um acessa.

**Regras de minimização:**
- **Sem token (digitou o ID):** só marca da org, "válido/inválido", tier, "membro desde", status. **Zero PII direta** (sem nome, sem foto, sem contato).
- **Com token assinado (QR do passe):** acrescenta nome + foto **somente se a org habilitou** (`org_privacy_settings.public_show_name/photo`). Default conservador = **não mostrar**.
- **Staff autenticado:** vê o necessário para check-in; mesmo assim **não** vê CPF/financeiro.
- **Anti-enumeração:** rate limit por IP; resposta a ID inexistente **indistinguível** (mesmo shape/tempo) de ID existente-mas-inválido; IDs não sequenciais (§07). Sem token, nunca confirmar a existência de PII.
- **Cabeçalho de privacidade:** páginas públicas com `noindex` (não indexar membros em buscadores) e sem cache de PII em CDN.

> **Edge case:** a org liga "mostrar foto no público" e um membro não quer. O membro tem **opt-out por membro** (`member_privacy.public_photo_optout`) que **sobrepõe** a config da org. Direito do titular vence a conveniência da org.

#### 1.9 Retenção de dados (data retention)

Cada categoria de dado tem um **prazo e uma política**:

| Categoria | Retenção | Após o prazo |
|---|---|---|
| Registro financeiro (`transactions`, `payouts`, refs fiscais) | prazo legal (ex.: 5+ anos) | purga ou anonimização total |
| PII de membro **ativo** | enquanto membership ativa + janela de reativação | anonimização se inativo > X (config org) |
| PII de membro **cancelado/anonimizado** | já anonimizado no cancelamento | — |
| `audit_logs` | longo (compliance, ex.: 5 anos) | arquivar/purgar |
| `pii_access_logs` | médio (ex.: 1–2 anos) | purgar |
| `consent_records` | enquanto a relação durar + prazo de prova | purgar |
| Logs técnicos / Edge (com PII incidental) | curto (ex.: 30–90 dias) | rotação automática |
| Export packages (DSAR) em Storage | curtíssimo (ex.: 7 dias) | deletar |
| Soft-deleted (lixeira) | janela de graça (ex.: 30 dias) | hard delete |

**Job de retenção (`data-retention-cron`):** roda diário; varre cada categoria, aplica a política (anonimizar/purgar/arquivar), **audita o que purgou** (sem revelar o conteúdo purgado), respeita **legal hold** (§1.11 — se há incidente/litígio em curso, não purga).

#### 1.10 Consentimento e base legal por canal

Cada **finalidade de tratamento** tem uma **base legal** e cada **canal de comunicação** tem um **consentimento independente**.

**Bases legais por finalidade (mapa):**

| Finalidade | Base legal típica | Consentimento explícito? |
|---|---|---|
| Executar o membership (cobrar, dar acesso, emitir passport) | **Execução de contrato** | Não (é o contrato) |
| Cumprir obrigação fiscal (reter transação) | **Obrigação legal** | Não |
| Marketing / campanhas por e-mail/push/WhatsApp | **Consentimento** | **Sim, por canal** |
| Perfilamento por IA (churn, segmentação, qualificação) | **Legítimo interesse** ou **consentimento** (Open Question §8) | depende da decisão |
| Hall of Fame público (nome/foto em destaque) | **Consentimento (opt-in)** | **Sim** |
| Foto no validador público | **Consentimento (opt-in)** | **Sim** |
| Segurança/antifraude (logs, validação) | **Legítimo interesse** | Não |

**Consentimento por canal (granular):** `e-mail`, `push`, `WhatsApp`, `SMS` — cada um com seu opt-in/opt-out, timestamp, **versão do texto** consentido, origem (tela/IP). O domínio `communication` (§17) **consulta** este registro antes de enviar; aqui é a **fonte de verdade**.

**Regras:**
- Opt-out é **imediato e irreversível sem novo opt-in**; um envio após opt-out é violação → o gate de envio checa `consent_records` em tempo de envio.
- **Transacional vs marketing:** mensagens transacionais (recibo, cobrança falhou, passe atualizado) seguem por **execução de contrato** e **não** dependem de consentimento de marketing — mas são separadas e nunca viram marketing disfarçado.
- **Importação de base (CRM §11):** ao importar membros existentes, a org **declara a base legal** da importação; consentimentos não nascem "true" por padrão — nascem `unknown` e o primeiro contato deve regularizar (double opt-in recomendado). Evita herdar base ilegal.
- **Double opt-in** (recomendado para e-mail/WhatsApp) registra a confirmação.

#### 1.11 Resposta a incidente (data breach)

Plano de resposta a vazamento, porque a LGPD exige comunicação à ANPD e aos titulares em prazo razoável.

**Fluxo:**
1. **Detecção** → alerta (anomalia de acesso, vazamento de chave, RLS bypass detectado, dump suspeito). Abre `security_incidents` (estado `detected`).
2. **Contenção** → revogar chaves/segredos comprometidos (rotação imediata), invalidar sessões, fechar a brecha. `legal hold` ativado: pausa jobs de retenção que possam destruir evidência.
3. **Avaliação** → escopo: quais orgs, quais titulares, quais categorias de dado. A separação por org **limita o raio** (um segredo de uma org não vaza as outras). Classifica severidade.
4. **Notificação** → se há risco a titulares: notifica a **ANPD** e os **titulares afetados** (e as **orgs controladoras**, que decidem a comunicação aos seus membros — a Stanbase é operadora). Prazos e textos versionados.
5. **Remediação + post-mortem** → corrige causa raiz, adiciona teste de regressão (ex.: novo caso na suíte de RLS), documenta.

**Edge case — vazamento de segredo de integração:** se uma `connections.credentials` vaza, o impacto é **escopado àquela org/provider**; rotaciona-se aquele token, não todos. É por isso que segredos são por-org e cifrados individualmente.

#### 1.12 Menores de idade

Tratamento de dados de crianças/adolescentes exige base legal específica (consentimento de um dos pais para < 13; cuidado especial até 18). Verticais como time/torcida e gamer têm menores.

**Comportamento:**
- **Captura de data de nascimento opcional** por org; se a org coleta, calcula faixa etária.
- **Menor de 13 (criança):** tratamento exige consentimento parental específico. No MVP, a abordagem é **minimizar/bloquear**: se a org sinaliza público potencialmente infantil, ativa-se um **fluxo de consentimento parental** (Open Question §8) ou **bloqueia** cadastro direto de menor de 13. Hall of Fame público e foto no validador **desligados** por padrão para menores.
- **13–17 (adolescente):** permitido com tratamento no melhor interesse; perfilamento por IA e exposição pública restringidos por default.
- **Sinalização:** `member_profiles.is_minor` derivado da data de nascimento; gates de comunicação e exposição pública consultam essa flag.

> **Edge case:** org não coleta idade → não dá para saber se é menor. Política: a **org declara** se seu público é majoritariamente adulto; se declara público infantil, ativa o regime de menores para todos. Responsabilidade da controladora (org), com a ferramenta provida pela Stanbase.

#### 1.13 PCI — delegado ao Asaas (a Stanbase nunca toca cartão)

- O **PAN/CVV/dados de cartão nunca chegam ao backend da Stanbase**. O checkout tokeniza o cartão **direto no Asaas** (campos hospedados / SDK do Asaas no front, ou tokenização client-side); a Stanbase recebe e guarda **somente um token opaco** (`card_token` do Asaas) e refs.
- Isso mantém a Stanbase em escopo **SAQ-A** (o mais leve — não armazena/processa/transmite dado de cartão), com o ônus PCI no Asaas.
- **Teste/guardrail:** lint/teste que falha se algum payload de Edge contiver padrão de PAN (regex de cartão) — defesa contra um cartão vazar para log ou DB por engano.
- Pix/boleto não têm dado de cartão; o risco PCI é só no cartão e está coberto pela delegação.

---

### 2. Modelo de dados

> Tabelas novas deste domínio. As de outros domínios (`transactions`, `connections`, `audit_logs`, `members`, `member_profiles`) são **referenciadas/tocadas** (não redefinidas aqui). Todas com `org_id` + RLS, exceto as de plataforma.

#### 2.1 Consentimento

**`consent_records`** (nova — fonte de verdade de consentimento por canal/finalidade)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK→organizations | controladora |
| `member_id` | uuid FK→members | titular (nullable se lead pré-membro) |
| `purpose` | text | `marketing`/`ai_profiling`/`public_hall`/`public_photo`/… |
| `channel` | text | `email`/`push`/`whatsapp`/`sms`/null (se não-canal) |
| `status` | text | `granted`/`denied`/`withdrawn`/`unknown` |
| `legal_basis` | text | `consent`/`contract`/`legal_obligation`/`legitimate_interest` |
| `text_version` | text | versão do texto/política consentido |
| `source` | jsonb | `{ ip, user_agent, screen, by:'subject'|'staff'|'import' }` |
| `occurred_at` | timestamptz | |
| | | **append-only** (trigger bloqueia UPDATE/DELETE) |
| | | INDEX(`org_id`,`member_id`,`purpose`,`channel`); estado atual = último por (member,purpose,channel) |

> Modelo **event-sourced**: cada mudança é uma nova linha; o "estado atual" é a última. Preserva histórico de prova (quando consentiu, quando revogou).

#### 2.2 Direitos do titular (DSAR)

**`dsar_requests`** (nova)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK→organizations | |
| `member_id` | uuid FK→members | titular |
| `type` | text | `access`/`rectify`/`anonymize`/`delete`/`withdraw`/`object` |
| `status` | text | `received`/`verified`/`approved`/`partial`/`completed`/`rejected` |
| `requested_by` | text | `subject`/`staff`/`legal` |
| `legal_basis_note` | text | base/justificativa quando por terceiro |
| `verification` | jsonb | método e prova da verificação de identidade |
| `result_ref` | text | URL assinada do pacote de export / resumo da execução |
| `held_reason` | text | por que parte foi retida (ex.: `financial_retention`) |
| `due_at` | timestamptz | prazo legal de resposta |
| `created_at`, `completed_at` | timestamptz | |
| | | INDEX(`org_id`,`status`); INDEX(`member_id`) |

#### 2.3 Privacidade por org e por membro

**`org_privacy_settings`** (nova — 1:1 com org)
| Coluna | Tipo | Notas |
|---|---|---|
| `org_id` | uuid PK FK | |
| `public_show_name` | bool | default false |
| `public_show_photo` | bool | default false |
| `audience_is_minor` | bool | org declara público infantil |
| `inactive_anonymize_days` | int | retenção de PII de inativos |
| `dpa_accepted_at` | timestamptz | aceite do DPA pela org (operadora→controladora) |
| `dpa_version` | text | versão do DPA aceita |
| `retention_overrides` | jsonb | prazos custom por categoria |

**`member_privacy`** (nova — opt-outs do titular sobre o público)
| Coluna | Tipo | Notas |
|---|---|---|
| `member_id` | uuid PK FK→members | |
| `public_name_optout` | bool | sobrepõe `org.public_show_name` |
| `public_photo_optout` | bool | sobrepõe `org.public_show_photo` |
| `ai_opt_out` | bool | oposição a perfilamento por IA |
| `updated_at` | timestamptz | |

#### 2.4 Auditoria e acesso a PII

**`audit_logs`** (existe §25.6 — **endurecida** aqui)
- Acrescenta: `actor_type` (`staff`/`subject`/`service`/`superadmin`/`system`), `ip`, `user_agent`, `prev_hash` (tamper-evidence, opcional MVP), `legal_basis` (em ações LGPD).
- **Append-only:** trigger `BEFORE UPDATE OR DELETE` → exceção (exceto job de retenção autorizado).
- PII **não** em claro no payload — diffs guardam hash/redação.
- INDEX(`org_id`,`at`), INDEX(`actor`), INDEX(`action`).

**`pii_access_logs`** (nova — leitura de dado pessoal sensível)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `actor` | uuid FK→auth.users | quem leu |
| `actor_type` | text | staff/superadmin/api/service |
| `subject_member_id` | uuid | de quem |
| `access_kind` | text | `view_profile`/`export`/`bulk_export`/`api_read` |
| `reason` | text | opcional (suporte/ticket) |
| `at` | timestamptz | |
| | | INDEX(`org_id`,`subject_member_id`,`at`) |

#### 2.5 Segurança operacional

**`security_incidents`** (nova — plataforma, sem `org_id` obrigatório)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `severity` | text | `low`/`medium`/`high`/`critical` |
| `status` | text | `detected`/`contained`/`assessed`/`notified`/`closed` |
| `affected_orgs` | uuid[] | escopo |
| `affected_categories` | text[] | categorias de dado |
| `detected_at`, `contained_at`, `notified_at`, `closed_at` | timestamptz | |
| `anpd_notified` | bool | |
| `notes` | text | post-mortem |

**`legal_holds`** (nova — suspende retenção/purga durante litígio/incidente)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `scope` | jsonb | `{ org_id?, member_ids?, categories? }` |
| `reason` | text | |
| `active` | bool | |
| `created_at`, `released_at` | timestamptz | |

**`data_retention_policies`** (nova — config das políticas por categoria)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `category` | text | `financial`/`pii_active`/`audit`/`pii_access`/`consent`/`tech_logs`/`export_packages`/`soft_deleted` |
| `retention_days` | int | null = legal/indefinido |
| `action` | text | `anonymize`/`purge`/`archive` |
| `scope` | text | `platform`/`org` (org pode sobrepor via `org_privacy_settings.retention_overrides`) |

**`dpa_subprocessors`** (nova — registro público de sub-processadores)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | Supabase/Asaas/LLM/Apple/Google/e-mail |
| `purpose` | text | hospedagem/pagamento/IA/wallet/comunicação |
| `location` | text | região de processamento |
| `dpa_url` | text | link p/ DPA do sub-processador |
| `active` | bool | |

#### 2.6 Tabelas tocadas em outros domínios (contrato)
- **`member_profiles`** (§25.2): a PII identificável (nome, e-mail, telefone, foto, atributos) mora aqui e é **apagável**; `transactions`/`subscriptions` **não** duplicam PII — referenciam `member` por pseudônimo estável.
- **`transactions`/`subscriptions`/`payouts`** (§10): **retidos** na anonimização; nunca apagados por DSAR enquanto houver obrigação legal.
- **`connections.credentials`, `webhooks.secret`, `api_keys.hash`, `passes.auth_token`** (§19/§22/§06/§08): cifrados/hash; view sem segredo para o front.

#### 2.7 Funções/constraints
- `is_minor(birthdate)` — deriva faixa etária.
- `current_consent(member, purpose, channel)` — retorna o estado atual (último evento).
- Trigger append-only em `audit_logs`, `consent_records`, `pii_access_logs`.
- View `connections_public` / `webhooks_public` sem colunas de segredo (RLS expõe só estas ao front).

---

### 3. API & Edge Functions

**Endpoints REST `/v1`** (alinhados ao §21; este domínio formaliza os de privacidade/consentimento e endurece o `DELETE /members`):

```
# Direitos do titular (DSAR)
POST   /v1/members/{memberId}/dsar            # cria pedido (access/rectify/anonymize/delete/withdraw/object)
GET    /v1/members/{memberId}/dsar/{id}        # status do pedido
GET    /v1/members/{memberId}/export           # gera/baixa pacote (URL assinada)  [self-service do titular]
DELETE /v1/members/{memberId}                  # § agora = anonimização + retenção financeira (não hard delete)
POST   /v1/members/{memberId}/anonymize        # explícito (staff com perm members.anonymize + step-up)

# Consentimento
GET    /v1/members/{memberId}/consent          # estado atual por canal/finalidade
PUT    /v1/members/{memberId}/consent          # grava opt-in/opt-out (titular ou staff)
GET    /v1/me/consent                          # do próprio membro logado (front do membro)
PUT    /v1/me/consent                          # idem

# Privacidade
GET    /v1/orgs/{id}/privacy                    # org_privacy_settings
PATCH  /v1/orgs/{id}/privacy                    # show_name/photo, audience_is_minor, retenção, DPA
GET    /v1/me/privacy                           # opt-outs do membro (público/IA)
PUT    /v1/me/privacy

# Compliance / governança (admin + superadmin)
GET    /v1/orgs/{id}/audit-logs                 # leitura do audit da org (paginado, filtrável)
GET    /v1/orgs/{id}/pii-access-logs            # quem leu PII
GET    /v1/dpa/subprocessors                    # lista pública de sub-processadores
POST   /v1/orgs/{id}/dpa/accept                 # org aceita o DPA (versão)

# Verificação pública (minimizada — já em §09, reforçada aqui)
GET    /v1/public/verify/{memberId}             # sem token: dados mínimos; com token: + nome/foto se permitido
```

**Edge Functions / Jobs:**

| Function/Job | Tipo | Descrição |
|---|---|---|
| `dsar-intake` | Edge | cria `dsar_requests`, registra base legal e prazo, dispara verificação de identidade |
| `dsar-verify` | Edge | valida identidade do titular (sessão / link mágico / Member ID) |
| `member-export` | Edge/Job | monta pacote JSON+CSV de **todos** os dados do titular naquela org → Storage URL assinada curta |
| `member-anonymize` | Edge/Job | desidentifica `member_profiles`, remove foto do Storage, apaga notas/atributos/consent marketing, **retém** financeiro; auditado; irreversível |
| `consent-write` | Edge | grava evento em `consent_records` (append) com source/versão; invalida cache de gate de envio |
| `consent-gate` | Edge (lib) | helper consultado por `communication` antes de cada envio (checa opt-in vigente) |
| `secret-load` / `secret-store` | Edge (lib) | decifra/cifra segredo (Vault/pgsodium); nunca loga; só `service_role` |
| `secret-rotate` | Job | rotaciona DEK / re-cifra em batch; rotaciona tokens OAuth vencendo |
| `data-retention-cron` | Cron (pg_cron) | aplica `data_retention_policies` por categoria; respeita `legal_holds`; audita purgas |
| `audit-writer` | Edge (lib) | escreve `audit_logs`/`pii_access_logs` (append, hash-chain opcional); redige PII |
| `rls-isolation-tests` | CI (pgTAP+Deno) | suíte de isolamento por tenant — **gate de merge** |
| `pan-leak-guard` | CI/lint | falha se payload/log contiver padrão de cartão (PCI) ou chave de segredo não-redigida |
| `incident-open` / `incident-notify` | Edge | abre `security_incidents`, dispara legal hold, gera notificação ANPD/titulares |

---

### 4. Telas / Front

**App admin (org) — Configurações → LGPD/Privacidade (§10.1 item 14):**
- **Painel de Privacidade da org:** toggles `mostrar nome/foto no validador público`, `público infantil`, prazos de retenção; aceite/visualização do **DPA** (versão, data); lista de **sub-processadores**.
- **Centro de Direitos do Titular (DSAR):** fila de pedidos (recebido/verificado/aprovado/parcial/concluído), com ação de aprovar/executar export/anonimização; mostra **impedimentos** (ex.: "exclusão será convertida em anonimização — há transações fiscais a reter"); step-up auth para anonimização/exclusão.
- **Consentimento por membro:** dentro do perfil 360º (CRM), aba "Consentimento & Privacidade" — estado por canal/finalidade, histórico (quando consentiu/revogou), origem; ação de registrar opt-in/opt-out em nome do membro (auditada, com base legal).
- **Audit log viewer:** tabela filtrável (ator, ação, alvo, período) + **PII access log** ("quem viu os dados deste membro"); export do audit.
- **Banner de menores:** quando `audience_is_minor`, avisos e defaults conservadores aplicados.

**App membro (front temável) — Centro de Privacidade (§24.2 perfil/preferências):**
- **Minhas preferências de comunicação:** toggles por canal (e-mail/push/WhatsApp) → grava consentimento.
- **Minha privacidade:** opt-out de aparecer com nome/foto no validador público e no Hall of Fame; opt-out de IA.
- **Meus dados:** botão **"Exportar meus dados"** (gera pacote, link curto) e **"Excluir minha conta nesta comunidade"** → fluxo que explica que financeiro será retido/anonimizado e exige confirmação; texto claro de base legal.
- Tudo **por org** (o membro vê só a org em que está; identidades separadas).

**Componentes-chave:** `<PrivacySettingsPanel/>`, `<DsarQueue/>`, `<ConsentMatrix/>`, `<AuditLogViewer/>`, `<PiiAccessTrail/>`, `<DpaAcceptance/>`, `<MemberPrivacyCenter/>`, `<DataExportButton/>`, `<DeleteMyAccountFlow/>`, `<StepUpAuthModal/>` (reuso §06).

**App superadmin (§superadmin):** painel global de incidentes (`security_incidents`), gestão de sub-processadores/DPA, visão de retenção e holds, e o **gate de auditoria do próprio super-admin** (todo acesso cross-tenant logado e visível à org).

---

### 5. Integrações externas

| Serviço | Papel LGPD/segurança | Como integra |
|---|---|---|
| **Supabase** | Sub-operador (hospedagem DB/Auth/Storage/Edge) | Vault/pgsodium p/ cifragem; RLS; Auth (verificação de identidade do DSAR); DPA da Supabase no registro de sub-processadores. Região de processamento documentada. |
| **Asaas** | Sub-operador (pagamento) + **detentor do PCI** | Tokeniza cartão (Stanbase nunca vê PAN/CVV → SAQ-A); guarda dado de cobrança; DPA do Asaas; refs financeiras retidas por obrigação legal. |
| **Provedor LLM (Claude)** | Sub-operador (IA) | Dados enviados para segmentação/copy/qualificação minimizados; **não treinar com dados do cliente** (cláusula no DPA); membro com `ai_opt_out` é excluído dos prompts; PII reduzida/pseudonimizada quando possível. |
| **Apple/Google Wallet** | Sub-operador (passport) | Recebem dados do passe (nome, Member ID, tier); DPA/termos das plataformas; minimização do que vai no passe. |
| **Provedor de e-mail/push/WhatsApp** | Sub-operador (comunicação) | Só envia a quem tem consentimento vigente (gate); DPA; opt-out propagado. |
| **KMS / Secret Manager** | Guarda/gera chaves de cifragem | MVP: Supabase Vault + Edge secrets; evolução: KMS externo/HSM/BYOK se exigido. |
| **ANPD** | Autoridade | Destinatário de notificação de incidente (processo, não API). |

> Toda integração nova entra no registro `dpa_subprocessors` **antes** de processar dado pessoal — é parte do "definition of done" de qualquer integração.

---

### 6. Épicos & tarefas

#### Épico A — Provar isolamento (testes de RLS)
- A1. Suíte de isolamento cross-tenant (pgTAP no banco): SELECT/WRITE de A não toca B, varrendo o catálogo de tabelas `org_id` — **L**
- A2. Testes de integração com JWTs forjados de A e B via Edge/PostgREST (operator escopado, perms) — **L**
- A3. Assert "toda tabela de domínio tem RLS + ≥1 policy" + lint de migration que falha tabela sem RLS — **M**
- A4. Testes de view/função `SECURITY DEFINER` (lista branca revisada) + assert sem `BYPASSRLS` em anon/authenticated — **M**
- A5. Testes anti-enumeração da rota pública + minimização de campos sem token — **M**
- A6. Integrar suíte como **gate de merge** no CI (bloqueia PR que vaza) — **S**

#### Épico B — Cifragem de segredos & PCI
- B1. Helpers `secret-load`/`secret-store` (pgsodium/Vault) + redação no logger estruturado (nunca logar credencial) — **M**
- B2. Views sem segredo (`connections_public`, `webhooks_public`) + RLS que esconde colunas cifradas do front — **M**
- B3. `secret-rotate` (rotação de DEK + re-cifragem batch + tokens OAuth vencendo) — **L**
- B4. `pan-leak-guard` (lint/teste que falha em PAN/segredo em payload/log) — **M**
- B5. Hash de `api_keys` e `org_invites.token` (só hash persistido; chave crua 1×) — **S** (coordenar com §06)
- B6. Confirmar fluxo de tokenização de cartão no Asaas (SAQ-A) — **M** (coordenar com §10)

#### Épico C — Auditoria imutável
- C1. Endurecer `audit_logs`: `actor_type`, `ip`, `legal_basis`, redação de PII; trigger append-only — **M**
- C2. `pii_access_logs` + instrumentação de leituras sensíveis (perfil 360º, export, API read) — **M**
- C3. `audit-writer` lib (usada por todos os domínios) + hash-chain opcional (tamper-evidence) — **M**
- C4. `<AuditLogViewer/>` + `<PiiAccessTrail/>` (admin) + export do audit — **M**
- C5. Auditar acesso super-admin cross-tenant (visível à org) — **M** (coordenar com §superadmin)

#### Épico D — Consentimento & base legal
- D1. `consent_records` (event-sourced, append-only) + `current_consent()` + estado atual por canal — **M**
- D2. `consent-gate` lib consultada por `communication` antes de cada envio — **M** (coordenar com §17)
- D3. `consent-write` + `<ConsentMatrix/>` (admin) + Centro de Privacidade do membro (toggles por canal) — **L**
- D4. Mapa de base legal por finalidade + base legal na importação de CRM (default `unknown`, double opt-in) — **M** (coordenar com §11)
- D5. Opt-out de IA (`ai_opt_out`) propagado aos jobs de IA — **S** (coordenar com §18)

#### Épico E — Direitos do titular (DSAR)
- E1. `dsar_requests` + máquina de estados + `dsar-intake` + prazo legal — **M**
- E2. `dsar-verify` (verificação de identidade: sessão / link mágico / Member ID) — **M**
- E3. `member-export` (pacote JSON+CSV completo → Storage URL curta) — **L**
- E4. `member-anonymize` (desidentifica, remove foto, retém financeiro, irreversível, auditado) — **L**
- E5. `DELETE /members` redefinido = anonimização + retenção (não hard delete) + impedimentos (financeiro/menor/owner) — **M**
- E6. Telas: `<DsarQueue/>` (admin), `<DataExportButton/>` + `<DeleteMyAccountFlow/>` (membro) — **L**

#### Épico F — Privacidade by design (rota pública & minimização)
- F1. `org_privacy_settings` + `member_privacy` (opt-out do titular sobrepõe org) — **M**
- F2. Minimização da rota pública (campos por token/permissão) + `noindex`/no-cache de PII — **M** (coordenar com §09/§12)
- F3. `<PrivacySettingsPanel/>` (admin) + `<MemberPrivacyCenter/>` (membro) — **M**

#### Épico G — Retenção, holds & incidente
- G1. `data_retention_policies` + `data-retention-cron` (anonimiza/purga/arquiva por categoria) — **L**
- G2. `legal_holds` (suspende purga em litígio/incidente) + integração no cron — **M**
- G3. `security_incidents` + `incident-open`/`incident-notify` (ANPD/titulares/orgs) — **M**
- G4. Retenção de export packages e soft-deleted (lixeira → hard delete na janela) — **S**

#### Épico H — Sub-processadores, DPA & menores
- H1. `dpa_subprocessors` + página pública + `dpa-accept` da org (versão) — **M**
- H2. Regime de menores: `is_minor`, defaults conservadores, gate de exposição pública/comunicação — **M**
- H3. Fluxo de consentimento parental (se decidido) ou bloqueio de < 13 — **M** (depende de Open Question)

#### Épico I — Governança contínua
- I1. "Definition of done" de segurança por domínio (toda tabela nova → teste de RLS; toda integração → sub-processador; toda PII → política de retenção) — **S** (processo/checklist)
- I2. Documentação de privacidade (política, base legal, DPA template org→membro) — **M**

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Convenção de migrations, Vault/pgsodium, pg_cron/pgmq, Storage, esqueleto `/v1`/OpenAPI, CI. Cifragem e retenção assentam aqui. |
| **auth-rbac** | **Base direta.** RLS, claims, RBAC, `audit_logs` base, step-up auth, revalidação live — este domínio **prova e estende** o que `auth-rbac` constrói. Verificação de identidade do DSAR usa Supabase Auth. |
| **payments-billing** | Define `transactions`/`subscriptions`/`payouts` que **não** podem ser apagados — o edge case anonimização×financeiro depende do modelo financeiro (PII separada do registro). Tokenização PCI no Asaas. |
| **member-identity** | `member_profiles` (a PII apagável) e o Member ID (pseudônimo que nunca é reusado). Export/anonimização operam sobre o membro. |
| **integrations-framework** | Padrão de `connections.credentials` cifrada e helper de segredos — reaproveitado/formalizado aqui. |
| **communication** | Consome o `consent-gate` antes de cada envio; consentimento por canal é fonte de verdade aqui. |
| **public-api / verification-checkin** | Rota pública minimizada (§09/§12) implementa as regras de minimização deste domínio. |

**É dependência de (quem precisa deste domínio):** `communication` (gate de consentimento), `crm` (consentimento na importação, PII access log), `ai-layer` (opt-out de IA), `superadmin` (incidentes, audit cross-tenant, sub-processadores), `verification-checkin`/`public-api` (minimização), e **todo** domínio que cria tabela (teste de RLS) ou PII (retenção).

**Acoplamentos a esclarecer:**
- A separação PII × registro financeiro precisa ser **acordada com `payments-billing`** desde o schema (não duplicar nome/e-mail em `transactions`).
- O `consent-gate` é um contrato com `communication` — definir a interface cedo.
- O super-admin bypass de RLS precisa ser **auditado por contrato** com `superadmin`.

---

### 8. Riscos & decisões técnicas

**Riscos:**
1. **Vazamento entre tenants (RLS).** Risco máximo da plataforma. Mitigação: suíte de isolamento que varre o catálogo (não lista manual) + gate de merge + lint de migration. Uma tabela nova sem RLS falha por omissão.
2. **Segredo em log/claro.** Token de integração logado ou em coluna em claro. Mitigação: helper único de cifragem, redação no logger, `pan-leak-guard`, view sem segredo, teste que proíbe SELECT da coluna por roles do front.
3. **Apagar dado que a lei obriga reter.** "Excluir membro" e sumir com a transação fiscal = ilegal. Mitigação: `DELETE` = anonimização + retenção; PII separada do registro financeiro no schema; impedimentos explícitos na UI.
4. **DSAR sem verificar identidade.** Atacante exporta a base alheia. Mitigação: verificação obrigatória (sessão/link mágico/Member ID); pedido por terceiro exige base legal e é auditado.
5. **Consentimento não respeitado no envio.** Enviar marketing a quem deu opt-out. Mitigação: `consent-gate` em tempo de envio (não em batch antigo); opt-out imediato e irreversível sem novo opt-in.
6. **Super-admin "deus".** Acesso cross-tenant sem rastro quebra a confiança e a LGPD. Mitigação: todo acesso super-admin auditado e **visível à org**; acesso de suporte por ticket e expira.
7. **Minimização pública insuficiente.** Foto/nome de menor ou de quem não quer no validador público. Mitigação: defaults conservadores, opt-out do titular sobrepõe a org, regime de menores.
8. **Anonimização reversível por engano.** Guardar a tabela-mapa pseudônimo→PII anula a anonimização. Mitigação: irreversível por design; não persistir mapa de reidentificação.
9. **Retenção destruindo evidência em incidente/litígio.** Mitigação: `legal_holds` pausam o `data-retention-cron`.
10. **Sub-processador novo sem DPA.** Integração que envia PII a um terceiro sem base. Mitigação: registro `dpa_subprocessors` é "definition of done" da integração.

**Decisões técnicas tomadas:**
- **Falha-fechado** em todas as camadas; sem org ativa = acesso mínimo, não total.
- **PII separada do registro financeiro** no schema — habilita anonimizar sem violar retenção.
- **Anonimização irreversível**; Member ID nunca reusado vira pseudônimo morto.
- **Consentimento event-sourced** (append-only) + estado atual derivado — preserva prova.
- **Audit append-only** (trigger), PII redigida no payload, hash-chain como evolução.
- **PCI delegado ao Asaas** (SAQ-A); tokenização client-side; guardrail anti-PAN.
- **Cifragem MVP** = pgsodium/Vault (coluna por-org) + Edge secrets (chaves de plataforma); KMS/HSM/BYOK como evolução.
- **Isolamento por org**, não por Conta — cada org é controladora independente; DSAR/export não cruzam orgs.

---

### 9. Escopo MVP vs. depois

**MVP (acompanha a Fase 0/1 — não é "depois"; segurança é pré-requisito):**
- **Testes de RLS de isolamento** como gate de merge (Épico A) — **inegociável desde a Fase 0**.
- Cifragem de segredos (helpers, views sem segredo, redação de log, `pan-leak-guard`) — **inegociável**.
- `audit_logs` endurecido (append-only, actor_type, base legal nas ações LGPD).
- Consentimento por canal (`consent_records` + `consent-gate`) — necessário antes de qualquer envio de marketing (§17).
- Direitos do titular **essenciais:** export (acesso/portabilidade), anonimização, `DELETE`=anonimização+retenção, retificação.
- Minimização da rota pública + `org_privacy_settings`/`member_privacy` (opt-out do titular).
- Separação PII × registro financeiro no schema (decisão estrutural — tem que nascer certa).
- PCI delegado ao Asaas (SAQ-A) + guardrail.
- DPA com sub-processadores (Supabase/Asaas/LLM/Wallet/e-mail) registrado e aceito pela org.
- Retenção básica (job que purga export packages, soft-deleted; respeita legal hold) + `legal_holds`.
- Regime de menores **mínimo:** flag, defaults conservadores de exposição pública.

**Depois (pós-MVP):**
- `pii_access_logs` completo com instrumentação fina + viewer rico.
- Hash-chain (tamper-evidence) no audit.
- `data-retention-cron` completo por categoria com políticas configuráveis por org.
- Resposta a incidente operacional (`security_incidents` + notificação ANPD automatizada) — MVP tem o processo e a tabela; automação depois.
- Consentimento parental formal para menores de 13 (vs. bloqueio simples no MVP).
- KMS externo/HSM/BYOK; chave gerenciada pelo cliente enterprise.
- Centro de Privacidade do membro completo (self-service total) — MVP cobre export/delete/opt-outs essenciais.
- Pseudonimização avançada nos prompts de IA; relatório de impacto (DPIA/RIPD) por org.
- Certificações (ISO 27001 / SOC 2) e auditoria externa.

---

> **Resumo:** este é o domínio **transversal de confiança**. Não inventa features de produto, mas define o contrato que torna o resto vendável a uma comunidade séria. Os três pilares inegociáveis desde o dia 1 são: **provar** o isolamento por org (testes de RLS no CI), **cifrar** os segredos (e nunca tocar em cartão — PCI no Asaas), e **separar PII de registro financeiro** para conseguir, ao mesmo tempo, respeitar o direito de exclusão do titular e a obrigação legal de reter o financeiro. Tudo o mais (consentimento, DSAR, retenção, incidente, menores) se apoia nessas três fundações.
