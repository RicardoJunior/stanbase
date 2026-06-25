# Stanbase — Perguntas Abertas para Destravar o Desenvolvimento

## 95. Perguntas Abertas para Destravar o Desenvolvimento

Este documento consolida TODAS as perguntas em aberto levantadas pelos planos de cada domínio, deduplicadas e agrupadas por tema. Cada pergunta traz: contexto (por que importa), opções, **recomendação** e prioridade:

- 🔴 **Bloqueante** — precisa ser decidida ANTES de iniciar o desenvolvimento (afeta schema, contrato de API, base legal ou arquitetura core difícil de mudar depois).
- 🟡 **Decidir durante** — pode ser resolvida no fluxo do desenvolvimento do domínio, sem travar o início.
- 🟢 **Pode ficar para depois** — refinamento ou feature pós-MVP.

---

## 🔴 Top decisões bloqueantes

Estas são as decisões que precisam ser tomadas primeiro porque travam o schema, o contrato público ou a base legal de vários domínios ao mesmo tempo. Recomendação resumida para cada:

1. **i18n na fundação (Q1)** — pt-BR no MVP com arquitetura i18n-ready (locale no JWT/perfil, campos traduzíveis em JSONB por locale já modelados, populando só pt-BR). Mudar o schema depois é caro. _Afeta: Fundação, Tiers/Perks, CRM, Comunicação, Passport, IA, MCP, Front._
2. **Coluna `mode` (live/test) em todas as tabelas desde o início (Q2)** — nascer com a coluna mesmo que o sandbox completo só ligue na Fase 4; adicioná-la retroativamente em todo o schema é muito mais caro. Isolamento por coluna + filtro no resolver/RLS (não banco separado). _Afeta: todos os domínios de negócio + API pública._
3. **Reuso do Member ID na reativação (Q15)** — a mesma pessoa que volta reusa o mesmo Member ID e preserva histórico; "IDs nunca reutilizados" significa não dar o ID a OUTRA pessoa. Preserva QR, links de validação e LTV. _Afeta: Member Identity, Passport, CRM, Validação._
4. **Definição de LTV (Q20)** — LTV = valor do plano (bruto sem juros de financiamento); `total_paid` (com juros) e `net_org` (líquido) como campos separados; `customer_interest` NUNCA entra no LTV. Número aparece em todo o produto. _Afeta: CRM, Gamificação, IA, Billing._
5. **Quem calcula os juros do parcelamento (Q24)** — Stanbase calcula com tabela Price e envia o valor total fixo ao Asaas; validar paridade de centavos no sandbox (golden tests). Trava a arquitetura de checkout. _Afeta: Billing, Eventos._
6. **Inadimplência: grace mantém acesso (Q27, Q30, Q53, Q72, Q85)** — durante o grace configurável o acesso (perks, conteúdo, canal, passe, porta) é mantido; revogação só ao FIM do grace. Coerência transversal obrigatória. _Afeta: Billing, Validação, Conteúdo, Comunidade, Passport, Front._
7. **PII na validação pública e papel do operador (Q11, Q44, Q66)** — default conservador: sem token só dados mínimos (sem PII); foto OFF por padrão em L1, ON só em L2 (staff); operador de porta NUNCA vê financeiro/base; dupla porta (org habilita + membro opt-in) para foto. Fronteira LGPD. _Afeta: Validação, RBAC, CRM, Passport, Front, LGPD._
8. **Confirmação de escrita por IA/MCP e blast-radius (Q60, Q61)** — leitura executa direto; escrita vira proposta com confirmação; financeiro, envio em massa (>100 membros) e anonimização exigem segunda confirmação out-of-band; allowlist curada de tools (proibir sempre via MCP: API keys, webhooks, equipe, exclusão LGPD em massa; financeiro só pós-MVP). _Afeta: IA, MCP, Admin App._

---

## A. Plataforma, Fundação & Arquitetura

### Q1. i18n desde a fundação 🔴
**Pergunta:** Os três idiomas (pt-BR, en-US, es) entram já no MVP ou pt-BR primeiro com arquitetura preparada?
**Por que importa:** Define a estratégia de localização (colunas traduzíveis vs. tabela de traduções vs. JSONB por locale), que muda o modelo de dados de vários domínios (tiers, perks, conteúdo, comunicação) e templates de e-mail/passe. Mudar depois é caro.
**Opções:** (a) pt-BR no MVP com arquitetura i18n-ready (locale no perfil + JSONB por locale), traduções depois; (b) três idiomas plenos no MVP; (c) pt-BR hard-coded, refatorar na Fase 4.
**Recomendação:** (a) pt-BR no MVP com arquitetura i18n-ready: modelar locale no JWT/perfil e prever campos traduzíveis (JSONB por locale) nas tabelas com texto voltado ao membro, populando só pt-BR. _Domínios: Fundação, Tiers/Perks, CRM, Comunicação, Passport, IA, MCP, Admin, Front._

### Q2. Coluna `mode` (live/test) e sandbox 🔴
**Pergunta:** O Sandbox/Test mode entra no MVP? Isolamento por coluna `mode` ou projeto Supabase separado?
**Por que importa:** A coluna `mode` precisa nascer cedo em TODAS as tabelas de domínio, senão vira migration retroativa cara. Decisor de DX para captar parceiros.
**Opções:** (a) coluna `mode` em tudo desde o início + filtro no resolver/policies, Asaas/Wallet sandbox quando `mode=test`; (b) projeto/schema separado (dobra infra, risco de drift); (c) sem sandbox formal no MVP.
**Recomendação:** (a) Decidir AGORA pela coluna `mode` em todas as tabelas (mesmo que o sandbox completo só ligue na Fase 4); filtro automático no resolver/policies; uma única base de código, sem drift. _Domínios: todos de negócio + API pública/MCP._

### Q3. Domínio próprio de validação e de membros no MVP 🟢
**Pergunta:** No MVP usar apenas `verify.stanbase.com/{id}` e `org.stanbase.*` (slug), ou já suportar domínio próprio da org com SSL automático?
**Por que importa:** Roteamento host→org, ACME/SSL e DNS por tenant aumentam materialmente a complexidade de infra (compartilhada entre verify.*, membros e e-mail). Itens §30.4 em aberto, repetidos em Fundação, Theming e Member App.
**Opções:** (a) só subdomínio Stanbase no MVP, domínio próprio na fase seguinte; (b) domínio próprio com SSL automático desde o MVP; (c) custom domain como feature beta atrás de flag.
**Recomendação:** (a) Só subdomínio/slug Stanbase no MVP; domínio próprio com SSL automático (mesma infra de verify.* e membros) numa fase seguinte. Valida o white-label sem o risco de ACME/DNS no caminho crítico. _Domínios: Fundação, Theming, Member App._

### Q4. Apex de hosting do front de membros 🔴
**Pergunta:** O front hosted fica em `*.stanbase.app` (apartado), `*.stanbase.com` (alinhado ao doc) ou domínio dedicado?
**Por que importa:** Cookies de sessão, CORS, OAuth callbacks e isolamento entre orgs dependem disso. Apartar membros em domínio próprio evita vazamento de cookie com institucional/admin.
**Opções:** (a) `*.stanbase.app` apartado (melhor isolamento); (b) `*.stanbase.com` (mistura com site/admin); (c) domínio dedicado novo.
**Recomendação:** (a) Apex dedicado e apartado para membros (`*.stanbase.app`) para isolar sessão/cookies do institucional e do admin. _Domínio: Member App._

### Q5. Isolamento de dados entre orgs da mesma Conta 🟡
**Pergunta:** Orgs irmãs (mesmo dono) são 100% isoladas, ou há visão agregada cross-org no nível da Conta?
**Por que importa:** Define se o RLS é estritamente por `org_id` ou se precisa de um segundo eixo por `account_id` (claims, policies, superadmin).
**Opções:** (a) isolamento estrito por `org_id` (uma org por vez no seletor); (b) `org_id` + visão agregada read-only na Conta; (c) agregação só via export.
**Recomendação:** (a) Isolamento estrito por `org_id` no MVP. Agregação na Conta é conveniência que vem depois sem reescrever RLS.

### Q6. Multi-manager de Conta 🟢
**Pergunta:** Uma Conta pode ter vários administradores (account_users), ou no MVP só o owner?
**Por que importa:** Útil para agências, mas adiciona um segundo nível de RBAC (conta) além do de org.
**Opções:** (a) só owner por conta no MVP; (b) multi-manager desde o MVP; (c) não diferenciar conta de org.
**Recomendação:** (a) Só owner por conta no MVP; `account_users` multi-manager pós-MVP (caso agência).

### Q7. Mover org entre Contas 🟢
**Pergunta:** Mover uma org de uma Conta para outra (vender/migrar base) entra no MVP?
**Por que importa:** Mexe em billing e propriedade; raro e arriscado no início.
**Opções:** (a) fora do MVP (org fixa na conta criadora); (b) no MVP com aprovação superadmin; (c) self-service.
**Recomendação:** (a) Fora do MVP; tratar via superadmin manualmente se surgir.

### Q8. Busca global cross-org no admin 🟡
**Pergunta:** A busca global (⌘K) permite cross-org para o dono com várias bases, ou é restrita à org ativa?
**Por que importa:** Rompe isolamento de PII entre bases e complica RLS/permissão (papéis diferentes por org).
**Opções:** (a) sempre restrita à org ativa; (b) cross-org opt-in só para o owner da Conta com badge da org; (c) "modo conta" separado.
**Recomendação:** (a) Restrita à org ativa no MVP; avaliar cross-org pós-MVP só para o owner da Conta, com permissão validada por org.

---

## B. Auth, RBAC & Equipe

### Q9. Método de login de operadores/staff 🔴
**Pergunta:** Staff loga só por OTP + OAuth (sem senha)?
**Por que importa:** Define a superfície de auth, telas de login/recuperação/suporte. Senha adiciona fluxos e risco; OTP/OAuth é mais seguro mas depende de deliverability.
**Opções:** (a) só OTP + OAuth; (b) OTP + OAuth + senha opcional; (c) senha como padrão.
**Recomendação:** (a) Só OTP + OAuth no MVP; senha só se cliente enterprise exigir (pós-MVP).

### Q10. Login de membros: social-only ou social + OTP 🟡
**Pergunta:** Membro pode logar com e-mail/OTP além de Google/Apple/X, ou só social?
**Por que importa:** Membros sem conta social ficam de fora se for social-only; afeta conversão no checkout.
**Opções:** (a) social-only; (b) social + e-mail/OTP (magic code); (c) social + e-mail/senha.
**Recomendação:** (b) Social + e-mail/OTP. Cobre quem não quer rede social, melhora conversão, sem senha.

### Q11. Latência de revogação de acesso de staff/operador 🔴
**Pergunta:** Revogação de operador de porta/staff precisa ser imediata (segundos) ou tolera TTL do token (~1h)?
**Por que importa:** Imediata exige revalidação ao vivo no banco em cada ação sensível e/ou TTL curto, com custo de latência. Define a arquitetura de sessão.
**Opções:** (a) híbrido (imediata p/ operador/financeiro/LGPD, TTL p/ resto); (b) TTL curto p/ todos; (c) imediata p/ tudo.
**Recomendação:** (a) Híbrido: revalidação ao vivo para operador de porta, financeiro e LGPD; TTL curto (1h) com refresh rotativo para o restante.

### Q12. Sessão de operador atrelada ao turno/evento 🟡
**Pergunta:** Operador tem sessão que expira ao fim do evento e/ou device-bound?
**Por que importa:** Reduz risco de credencial de portaria vazada continuar ativa.
**Opções:** (a) TTL curto + revogar operadores em massa pós-evento (MVP); (b) device-bound por turno (pós-MVP); (c) sem tratamento especial.
**Recomendação:** (a) MVP: TTL curto + ação "revogar operadores em massa" por evento + cron de cleanup; device-bound pós-MVP.

### Q13. Convite com e-mail divergente 🟡
**Pergunta:** Se o convidado autentica com e-mail diferente do convite, bloquear por padrão?
**Por que importa:** Travar previne sequestro de convite, mas pode gerar atrito legítimo (OAuth com outra conta).
**Opções:** (a) bloquear sempre; (b) bloquear com override do admin; (c) permitir sempre.
**Recomendação:** (b) Bloquear por padrão com possibilidade de o admin reenviar/autorizar explicitamente.

### Q14. Transferência de posse de org 🟡
**Pergunta:** Transferência de posse exige aceite do destinatário (two-step) ou é unilateral?
**Por que importa:** Aceite evita transferir posse "por surpresa" e responsabiliza o novo owner.
**Opções:** (a) aceite + step-up auth do owner atual; (b) unilateral com step-up; (c) unilateral simples.
**Recomendação:** (a) Exigir aceite do destinatário e reautenticação (step-up) do owner atual.

### Q15. Escopo de PII do operador no scan 🔴
**Pergunta:** O operador de porta vê quais dados do membro no scan, além do mínimo de validação?
**Por que importa:** Define o escopo de PII na portaria (LGPD). _Consolida com Q44 e Q66._
**Opções:** (a) só status/tier/foto p/ conferência; (b) mínimo + registrar presença/interação no CRM; (c) mínimo + perks ativos + interação.
**Recomendação:** (b) Mínimo + check-in + registrar interação no CRM; NUNCA financeiro, NUNCA exportar base.

### Q16. Editor de permissões: por usuário ou templates 🟡
**Pergunta:** No MVP, permissões editadas por usuário (checkboxes) ou já com cargos/templates reutilizáveis?
**Por que importa:** Templates reduzem erro em equipes grandes, mas adicionam UI e modelo de dados.
**Opções:** (a) por usuário com presets dos 3 papéis no MVP, templates depois; (b) templates desde o MVP; (c) só 3 papéis fixos.
**Recomendação:** (a) Por usuário com presets dos 3 papéis no MVP; `role_templates` reutilizáveis pós-MVP.

### Q17. Exclusão LGPD de owner único 🟡
**Pergunta:** Owner único de orgs pode pedir exclusão da própria conta? O que acontece com as orgs?
**Por que importa:** Deixaria orgs órfãs e conflita com obrigações financeiras/contábeis.
**Opções:** (a) bloquear até transferir/arquivar todas; (b) transferência automática p/ Stanbase; (c) arquivar órfãs automaticamente.
**Recomendação:** (a) Bloquear a exclusão até transferir ou arquivar as orgs onde é único owner; preservar audit/registros financeiros.

### Q18. Gating de UI sem permissão 🟢
**Pergunta:** Botão sem permissão é escondido ou desabilitado com tooltip?
**Por que importa:** Define o padrão de `<Gated/>` em todos os módulos.
**Opções:** (a) esconder; (b) desabilitar com tooltip; (c) misto.
**Recomendação:** (c) Misto com default "esconder": esconder ações financeiras/destrutivas (não vazar capacidade), desabilitar com tooltip as comuns onde sumir confunde.

---

## C. Identidade do Membro & Member ID

### Q19. Reuso do Member ID na reativação 🔴
**Pergunta:** Mesma pessoa (canceled→active) reusa o mesmo Member ID e histórico, ou cada ciclo gera ID novo?
**Por que importa:** Decisão mais estrutural do domínio — muda schema, validade do Passport/QR antigo, continuidade de CRM/LTV e a interpretação de "IDs nunca reutilizados".
**Opções:** (a) reusar mesmo ID e restaurar histórico; (b) novo ID por ciclo, encadeando; (c) reusar ID mas zerar "membro desde".
**Recomendação:** (a) Reusar o mesmo Member ID e preservar histórico. "IDs nunca reutilizados" = não dar a OUTRA pessoa. Mantém QR, links de validação e LTV; manter "membro desde" original e registrar `reactivated_at` separado. _Domínios: Member Identity, Passport, CRM, Validação._

### Q20. Estados de membership vs. lifecycle de CRM 🟡
**Pergunta:** "reactivated" e "em risco" são estados da máquina de membership, ou derivados (flag/score)?
**Por que importa:** Tratar "em risco" como estado acopla billing a heurística de IA; "reactivated" como estado duplica lógica com "active".
**Opções:** (a) ambos são estados de pleno direito; (b) estados de billing = lead/pending/active/past_due/suspended/canceled/merged, "em risco"=score, "reativado"=active+flag; (c) híbrido com lifecycle stage derivado.
**Recomendação:** (b) Separar: estados de membership = billing; "em risco" é score; "reativado" é active + flag. O kanban de lifecycle do CRM é VIEW derivada, não a fonte de verdade.

### Q21. Identidade mínima de um membro 🟡
**Pergunta:** E-mail é obrigatório para criar um membro? Qual a identidade mínima viável?
**Por que importa:** Sem contato, não há reconciliação nem comunicação nem login OTP. Afeta nullability de colunas e validações.
**Opções:** (a) e-mail obrigatório sempre; (b) e-mail OU telefone; (c) Member ID + nome bastam (e-mail/phone nullable).
**Recomendação:** (c) Não exigir e-mail (nullable). Identidade mínima = Member ID (+ nome quando houver). Sinalizar "sem canal de contato" no CRM. Suporta o fluxo real de portaria.

### Q22. Reconciliação (claim) de membro importado 🟡
**Pergunta:** Em que condição um membro importado sem login é auto-vinculado ao logar?
**Por que importa:** Vincular por e-mail não verificado permite account takeover.
**Opções:** (a) auto-vincula só com canal verificado (OTP/OAuth); (b) por e-mail mesmo não verificado; (c) nunca auto-vincula.
**Recomendação:** (a) Auto-vincular somente com canal verificado; conflitos vão para fila de revisão.

### Q23. Múltiplos memberships ativos por pessoa/org 🟡
**Pergunta:** A mesma pessoa pode ter mais de um membership ativo na mesma org?
**Por que importa:** A constraint `UNIQUE(org_id, person_id)` só funciona se a resposta for não.
**Opções:** (a) não: 1 ativo por pessoa/org (segundo checkout vira upgrade); (b) sim transitoriamente, resolvido por merge; (c) sim, independentes.
**Recomendação:** (a) Não permitir dois ativos: segundo checkout vira upgrade/troca de tier do membership existente. Reforça "1 membership por org".

### Q24. Merge com duas assinaturas pagas ativas 🟡
**Pergunta:** Ao mesclar duas memberships com assinatura paga ativa, qual o comportamento? _Consolida com Q33 (CRM)._
**Por que importa:** Reapontar billing errado causa cobrança dupla ou perda de receita.
**Opções:** (a) bloquear merge automático e exigir resolução manual; (b) manter a mais cara/antiga e cancelar a outra com reembolso pro-rata; (c) permitir e manter as duas.
**Recomendação:** (a) Bloquear o merge automático e exigir resolução manual (alerta forte no dry-run). Caso raro o suficiente para tolerar passo manual.

### Q25. Reversibilidade do merge 🟡
**Pergunta:** O merge de duplicados é reversível e por quanto tempo?
**Por que importa:** Merge reaponta histórico financeiro e revoga passes; um erro precisa de janela de desfazer.
**Opções:** (a) irreversível após confirmação; (b) soft/reversível por janela fixa (30 dias) e depois consolida; (c) sempre reversível.
**Recomendação:** (b) Soft-reversível por janela fixa (~30 dias) com tombstone, depois job consolida.

### Q26. Regra de survivor do merge 🟢
**Pergunta:** Qual Member ID é preservado por padrão no merge?
**Por que importa:** O dono precisa confiar em qual ID sobrevive (o já impresso/ditado/compartilhado).
**Opções:** (a) ativa > mais antiga (joined_at) > com Passport, com override do admin; (b) sempre o mais antigo; (c) sempre manual.
**Recomendação:** (a) Default automático (ativa > mais antiga > com Passport) MAS permitir o admin sobrescrever no dry-run.

### Q27. Caractere ambíguo na busca de Member ID 🟢
**Pergunta:** Caractere ambíguo (I, O, 0, 1) na busca/validação: auto-corrigir ou rejeitar?
**Por que importa:** Auto-corrigir (O→0) pode mapear a outro ID válido; sem dígito verificador não dá para validar local.
**Opções:** (a) rejeitar e destacar o caractere; (b) auto-corrigir heuristicamente; (c) rejeitar mas sugerir correção sem aplicar.
**Recomendação:** (c) Rejeitar caracteres fora do alfabeto e sugerir a correção SEM aplicar (usuário confirma).

### Q28. Blocklist de Member IDs 🟢
**Pergunta:** A blocklist de IDs ofensivos/reservados é só global (Stanbase) ou a org pode adicionar?
**Por que importa:** Combinações ofensivas variam por idioma (produto trilíngue).
**Opções:** (a) só global; (b) global + org adiciona; (c) global multi-idioma.
**Recomendação:** (a)+(c) MVP só global, curada pela Stanbase, com seed multi-idioma (pt/en/es). Org-level depois se houver demanda.

---

## D. CRM & Base de Customers

### Q29. Definição de LTV 🔴
**Pergunta:** LTV reflete o líquido para a org (após comissão/PSP), o bruto pago, ou o valor do plano sem juros? E o `customer_interest` entra?
**Por que importa:** É o número que aparece em todo o produto (ranking de superfãs, RFM, segmentos, dashboard). Define a priorização comercial do dono. _Consolida com Q72 (gamificação)._
**Opções:** (a) LTV = líquido recebido pela org; (b) LTV = bruto pago (inclui tudo); (c) LTV = valor do plano sem juros, mantendo `total_paid` e `net_org` separados.
**Recomendação:** (c) LTV = valor do plano (bruto sem juros de financiamento); manter `total_paid` (com juros) e `net_org` (líquido) como campos separados. `customer_interest` NUNCA entra no LTV.

### Q30. Critérios concretos de transição de lifecycle 🔴
**Pergunta:** O que torna um member "active" e o que o coloca em "at_risk" (dias de inatividade + churn_score)?
**Por que importa:** Lifecycle alimenta dashboard, segmentos, alertas de IA e campanhas. Sem thresholds não há máquina de estados.
**Opções:** (a) defaults de plataforma fixos; (b) configurável por org dentro de limites; (c) só baseado em billing. _Consolida com Q73 (thresholds de IA)._
**Recomendação:** (a)→(b) Defaults sensatos no MVP (active = pagamento em dia + atividade em 30d; at_risk = inadimplente no grace OU churn alto OU inativo >60d), configurável por org como evolução. Defaults por vertical onde a cadência varia (balada ≠ clube de carro). Billing sempre manda no cancelado.

### Q31. PII sensível e quem pode ver/exportar 🔴
**Pergunta:** Quais atributos custom são PII por padrão e quem (qual papel) pode ver/exportar?
**Por que importa:** Define masking, permissão `crm.pii.read` e o que vaza em export/rota pública. _Consolida com Q15, Q44._
**Opções:** (a) PII = email/telefone/doc/endereço/foto por padrão, só owner/admin veem, operador nunca; (b) org define por campo; (c) tudo visível sem masking.
**Recomendação:** (a) Defaults sensíveis mascarados; visibilidade por permissão `crm.pii.read`; operador NUNCA vê PII; export completo auditado.

### Q32. Reembolso/chargeback e lifecycle/RFM 🟡
**Pergunta:** Reembolso reduz LTV e rebaixa lifecycle/RFM automaticamente, ou afeta só o financeiro?
**Por que importa:** Define se um superfã que pediu reembolso "perde status" no CRM.
**Opções:** (a) reembolso subtrai LTV e rebaixa RFM/lifecycle; (b) subtrai LTV mas não mexe em lifecycle (só billing cancela); (c) parcial não afeta, chargeback adiciona flag de risco.
**Recomendação:** (b)+(c) Reembolso subtrai do LTV (tem que bater com o caixa), mas lifecycle só muda se o membership for cancelado pelo billing. Chargeback adiciona flag de risco.

### Q33. Snapshot vs. dinâmico em campanhas 🟡
**Pergunta:** Audiência de campanha sobre segmento dinâmico é congelada no envio ou continua dinâmica?
**Por que importa:** Define reprodutibilidade/idempotência e o comportamento de automações "enviar quando entrar em risco".
**Opções:** (a) envio único = snapshot, automação recorrente = dynamic com de-dupe; (b) sempre snapshot; (c) sempre dynamic.
**Recomendação:** (a) Campanha pontual congela snapshot; automações contínuas ficam dynamic com "não reenviar para quem já recebeu".

### Q34. Política padrão de import de CSV 🟡
**Pergunta:** Linha do CSV que bate com membro existente: pular, sobrescrever ou mesclar campos vazios?
**Por que importa:** Risco de sobrescrever dados bons com ruins, ou criar duplicatas.
**Opções:** (a) pular e reportar dup; (b) preencher só campos vazios (fill gaps); (c) usuário escolhe no wizard.
**Recomendação:** (c) Usuário escolhe a política por import, com default = "preencher apenas campos vazios" (não-destrutivo) e dup reportada. Nunca sobrescrever silenciosamente.

### Q35. Templates de atributos custom por vertical 🟢
**Pergunta:** Quais conjuntos de atributos vêm pré-configurados por tipo de org (carro, time, gamer, balada, creator, empresa)?
**Por que importa:** Acelera onboarding e dá consistência. Precisa da lista concreta por vertical.
**Opções:** (a) set curado por vertical; (b) sem templates; (c) set genérico único.
**Recomendação:** (a) Templates curados (editáveis) com 3-6 campos por vertical, derivados do §11.1. Pedir a lista final ao dono antes do seed.

### Q36. Edição de perfil/atributos pelo membro 🟡
**Pergunta:** O membro edita o próprio perfil/atributos, ou é read-only e só a org edita?
**Por que importa:** Afeta qualidade do dado e o escopo da área do membro.
**Opções:** (a) membro edita contatos + atributos marcados "member_editable"; (b) tudo read-only; (c) membro edita tudo.
**Recomendação:** (a) Membro edita contatos e consentimentos sempre, e atributos custom apenas se marcados `member_editable`. Atributos operacionais ficam read-only.

### Q37. Reconhecimento de LTV em plano parcelado 🟡
**Pergunta:** Reconhecer o valor cheio do plano na compra paga, ou amortizar ao longo do acesso?
**Por que importa:** Afeta MRR/LTV exibidos e comparabilidade com assinaturas.
**Opções:** (a) valor cheio no "paid" (org recebeu antecipado); (b) amortizar linearmente; (c) conforme parcelas caem.
**Recomendação:** (a) Reconhecer o valor cheio do plano (sem juros) na compra paga; usar o período de acesso só para entitlements/lifecycle.

---

## E. Pagamentos, Assinaturas & Billing (Asaas)

### Q38. Quem calcula os juros do parcelamento 🔴
**Pergunta:** A Stanbase calcula os juros (tabela Price) e envia valor fixo ao Asaas, ou o Asaas calcula e refletimos?
**Por que importa:** Divergência de centavos entre simulador e fatura quebra a transparência ("sem letrinha miúda"). Trava a arquitetura de checkout e os golden tests.
**Opções:** (a) Stanbase calcula e envia valor fixo (controle do spread); (b) Asaas calcula (zero divergência, menos controle); (c) híbrido com validação.
**Recomendação:** (a) Stanbase calcula com tabela Price, envia valor total fixo ao Asaas, valida paridade de centavos no sandbox (golden tests). _Domínios: Billing, Eventos._

### Q39. Inadimplência em plano parcelado mantém acesso 🔴
**Pergunta:** Se o cliente para de pagar parcelas no meio (ex.: 4 de 12), o acesso continua até o fim do período ou é revogado?
**Por que importa:** A org recebe antecipado (Stanbase financia); o prejuízo da inadimplência é da Stanbase, já precificado no spread. Define a máquina de estados do parcelado.
**Opções:** (a) manter acesso até o fim, perseguir cobrança no cartão (dunning); (b) revogar ao defaultar; (c) configurável (default manter).
**Recomendação:** (c)→(a) Configurável por org com default = manter acesso até o fim do período (modelo Hotmart: compra avulsa, acesso garantido). Perseguir cobrança via dunning.

### Q40. Grace period padrão de inadimplência 🟡
**Pergunta:** Quantos dias de grace antes de revogar acesso na recorrente, e é configurável por org? _Consolida com Q53, Q72, Q85 (transversal)._
**Por que importa:** Grace curto irrita e aumenta churn involuntário; longo dá acesso grátis a inadimplentes.
**Opções:** (a) fixo 3 dias; (b) configurável por org (default 3); (c) configurável por org (default 7).
**Recomendação:** (b) Configurável por org com default de 3 dias. **Regra transversal:** durante o grace o acesso (perks, conteúdo, canal, passe, porta) é mantido; corte só ao fim do grace.

### Q41. Comportamento de downgrade no meio do ciclo 🔴
**Pergunta:** No downgrade, o membro perde perks imediatamente ou ao fim do ciclo já pago? E gera crédito/reembolso? _Consolida Tiers Q49 + Billing._
**Por que importa:** Errar gera disputa "paguei e perdi acesso". Define UX, proração e o momento do sync de revogação.
**Opções:** (a) imediato com crédito prorata; (b) ao fim do ciclo atual (`pending_tier_change`, sem reembolso); (c) configurável por org.
**Recomendação:** (b) Ao fim do ciclo atual (mantém perks até lá, agenda a mudança, sem reembolso, sem reversão de split). Padrão de mercado (Spotify/Netflix). Upgrade, sim, com proração imediata.

### Q42. Proração de upgrade: manter ou reiniciar ciclo 🔴
**Pergunta:** Na proração de upgrade, mantém-se `current_period_end` original ou reinicia o ciclo?
**Por que importa:** Decide se cobra só a diferença até o fim do ciclo (mantém data) ou inicia ciclo novo. Impacta receita e datas de cobrança.
**Opções:** (a) manter ciclo original (cobra só a diferença prorata-die); (b) reiniciar ciclo no upgrade.
**Recomendação:** (a) Manter o ciclo original e cobrar a diferença prorata-die (padrão SaaS, menos atrito).

### Q43. Upgrade/downgrade em planos parcelados 🔴
**Pergunta:** Permitir change-tier em planos parcelados (em até 12x)?
**Por que importa:** Plano parcelado é compra avulsa sem auto-renovação; proração com parcelas futuras é matematicamente complexa e arriscada.
**Opções:** (a) bloquear no MVP e tratar como nova compra com crédito; (b) tratar como nova compra com crédito; (c) só upgrade.
**Recomendação:** (a) Bloquear no MVP e tratar como nova compra com crédito do período não-consumido; reavaliar depois.

### Q44. Acesso em reembolso parcial 🟡
**Pergunta:** No reembolso parcial, manter acesso até o fim do período, reduzir proporcionalmente, ou revogar?
**Por que importa:** Devolver metade do dinheiro não implica metade do acesso. Define `access_policy` em refunds.
**Opções:** (a) manter acesso até o fim (default); (b) reduzir proporcionalmente; (c) revogar imediatamente.
**Recomendação:** (a) Manter acesso até o fim do período por default (reembolso parcial geralmente é cortesia), com `access_policy` configurável na ação.

### Q45. Cancelamento de recorrente: padrão de acesso 🟡
**Pergunta:** No cancelamento, manter acesso até o fim do período pago (`cancel_at_period_end`) ou imediato com reembolso?
**Por que importa:** Define expectativa do membro e política de receita.
**Opções:** (a) acesso até o fim, sem reembolso (default); (b) imediato com reembolso proporcional; (c) org escolhe.
**Recomendação:** (a) Default = acesso até o fim do período pago, sem reembolso. Reembolso por cancelamento como exceção manual do admin.

### Q46. Vaga limitada volta ao pool no cancelamento 🟡
**Pergunta:** Ao cancelar/expirar uma assinatura de tier com vagas limitadas, a vaga volta ao pool? _Consolida com Q67 (eventos)._
**Por que importa:** Lote fundador perde escassez com rotatividade infinita; tier de capacidade operacional pode devolver.
**Opções:** (a) nunca volta (lote histórico); (b) sempre volta; (c) configurável por tier (`reclaim_on_cancel`).
**Recomendação:** (c) Configurável por tier, default "não volta" para lote fundador e "volta" para tier de capacidade. **Em eventos, default "volta"** (ocupação física do venue), com override por ticket type.

### Q47. Responsabilidade por chargeback perdido 🔴
**Pergunta:** Em chargeback perdido de valor já repassado/sacado, quem absorve: org, Stanbase ou split?
**Por que importa:** Perda real; se a org já sacou e não há saldo, alguém fica com o prejuízo. Define `disputes`, congelamento de payout e Termos de Uso. _Consolida com Q102 (superadmin liability)._
**Opções:** (a) org absorve (débito de saldo/próximos payouts, `platform_balance` negativo se necessário); (b) Stanbase absorve; (c) split proporcional.
**Recomendação:** (a) Org absorve o valor líquido (a venda e o relacionamento são dela); Stanbase contesta em nome da org; congelar payout do valor disputado preventivamente. **Matriz por cenário:** erro da plataforma = Stanbase; fraude/org sumiu = org. Definir nos Termos.

### Q48. Base de comissão com cupom/desconto 🟡
**Pergunta:** A comissão de 7,99% incide sobre o valor com desconto ou cheio? Cupom cumula com parcelamento?
**Por que importa:** Define receita da plataforma e a engine de cálculo.
**Opções:** (a) 7,99% sobre o valor com desconto, org absorve, cupom cumula (juros sobre valor com desconto); (b) 7,99% sobre o valor cheio; (c) cupom desabilitado no parcelamento.
**Recomendação:** (a) Comissão sobre o valor com desconto (org concede e absorve); permitir cupom + parcelamento, juros sobre o valor já com desconto.

### Q49. Frequência de payout 🟢
**Pergunta:** Qual a frequência padrão de repasse? Saque on-demand? Mínimo/taxa?
**Por que importa:** Fluxo de caixa do dono é argumento de venda.
**Opções:** (a) diário automático + saque on-demand; (b) semanal + on-demand; (c) só on-demand.
**Recomendação:** (a) Diário automático por default (Asaas oferece saque grátis) + saque on-demand. Maximiza percepção de fluxo de caixa rápido.

### Q50. Emissão de nota fiscal no MVP 🟡
**Pergunta:** A Stanbase emite NF (da comissão e/ou NFS-e da venda) no MVP, ou fica por conta da org?
**Por que importa:** Obrigação fiscal/contábil; sem NF da comissão a org não deduz despesa. _Liga com Q117 (CPF/retenção)._
**Opções:** (a) sem emissão no MVP; (b) MVP emite NF da comissão Stanbase→org; (c) MVP emite NFS-e da venda + NF da comissão.
**Recomendação:** (b) Emitir NF da comissão Stanbase→org desde o MVP (obrigação da plataforma, baixo esforço via Asaas); NFS-e da venda fica pós-MVP (configurável por org). Confirmar com contabilidade.

### Q51. Trials no MVP de billing 🟢
**Pergunta:** Trials entram no MVP? Com cartão (cobra ao fim) ou sem cartão (expira)? _Consolida com Q56 (anti-abuso de trial)._
**Por que importa:** Trial com cartão converte melhor mas adiciona cobrança agendada e máquina de estados `trialing`.
**Opções:** (a) sem trial no MVP; (b) trial com cartão; (c) trial sem cartão.
**Recomendação:** (a)→(b) Deixar trial fora do corte crítico (entregar checkout/recorrência/parcelado primeiro); quando entrar, trial com cartão (converte melhor). **Anti-abuso:** 1 trial por membro na org inteira.

---

## F. Engine de Tiers, Perks & Entitlements

### Q52. Grandfathering de perks ao remover perk do tier 🔴
**Pergunta:** Quando a org remove um perk de um tier, membros atuais perdem ou mantêm (grandfathering de perks)?
**Por que importa:** Grandfathering de PREÇO é simples (snapshot); de PERKS exige `tier_snapshot` e desvia o resolver — aumenta muito a complexidade da engine.
**Opções:** (a) sempre perdem (resolver usa tier atual); (b) sempre mantêm (snapshot do perk-set); (c) admin escolhe.
**Recomendação:** (a) Sempre perdem por padrão (perk-set segue o tier atual); só preço é congelado. Mantém o resolver simples.

### Q53. Reajuste de preço: grandfather ou todos 🟡
**Pergunta:** Ao reajustar o preço de um tier, aplica só a novos (grandfather) ou a todos no próximo ciclo?
**Por que importa:** Define se a subscription cobra do snapshot ou do `tier.price`. Impacta confiança ("fundador paga sempre o preço de fundador").
**Opções:** (a) sempre grandfather; (b) aplicar a todos no próximo ciclo; (c) admin escolhe.
**Recomendação:** (c) Admin escolhe por reajuste, default = grandfather. Snapshot de preço na subscription.

### Q54. Cupons one-time vs. recorrentes 🟢
**Pergunta:** Cupons são só na 1ª cobrança ou podem ser recorrentes?
**Por que importa:** Cupom recorrente afeta o preço de todas as renovações e o cálculo de comissão continuamente.
**Opções:** (a) só one_time no MVP; (b) one_time e recurring; (c) só percentual fixo.
**Recomendação:** (a) Só one_time no MVP; recurring depois. Cobre 90% dos casos de aquisição.

### Q55. Reconcile: Stanbase como fonte da verdade 🟡
**Pergunta:** O reconcile sobrescreve mudanças manuais no provider (ex.: cargo Discord editado à mão)? _Consolida com Q89, Q92 (integrações)._
**Por que importa:** Define se o cron reverte mudanças manuais ou as respeita.
**Opções:** (a) Stanbase sempre manda (reverte); (b) provider tem precedência (só alerta drift); (c) configurável.
**Recomendação:** (a) Stanbase manda SOMENTE para recursos geridos por mapeamento (corrige drift); mudanças manuais não-mapeadas são ignoradas (não toca cargos/grupos alheios).

### Q56. Perks custom/nicho no MVP 🟢
**Pergunta:** Perks que exigem condição além do tier (Steam, validação de sócio) entram no MVP?
**Por que importa:** Nascem `pending_requirement` e dependem de integrations avançadas e verification.
**Opções:** (a) MVP só perks derivados de tier; (b) incluir custom/nicho; (c) incluir como perk manual.
**Recomendação:** (a) MVP só perks derivados de tier; custom/nicho com requisito ficam para fase posterior.

### Q57. Drops/ingressos emitidos em downgrade/cancelamento 🟡
**Pergunta:** O que acontece com drops pendentes e ingressos já emitidos num downgrade/cancelamento?
**Por que importa:** Não se desfaz envio físico nem ingresso vendido; precisa de regra por tipo de perk (`is_revocable`).
**Opções:** (a) honrar tudo emitido, cancelar pendentes; (b) revogar tudo não-usado; (c) configurável por perk (`is_revocable`).
**Recomendação:** (c) Configurável via `is_revocable`, default: drop consumido e ingresso emitido honrados; pendentes cancelados.

---

## G. Passport (Apple/Google Wallet)

### Q58. Revogação visual do passe no celular 🟡
**Pergunta:** Quando o membership é revogado, o que o membro vê no passe já no celular?
**Por que importa:** Não há API para apagar o passe remotamente. Define a experiência de revogação.
**Opções:** (a) riscar/inativar visualmente (voided/INACTIVE) + status "Inativo" + QR para de validar; (b) só mudar status sem riscar; (c) só invalidar QR online.
**Recomendação:** (a) Riscar/inativar visualmente + status "Inativo" + QR para de validar online. Claro para membro e portaria, sem depender de push.

### Q59. Arte por tier vs. label-only 🟢
**Pergunta:** O tier muda a arte do passe ou só a label de texto sobre arte única da org?
**Por que importa:** Arte por-tier multiplica design/assets, complica cache de assinatura Apple e exige re-push a cada upgrade.
**Opções:** (a) label-only (MVP); (b) arte/cor por tier; (c) configurável.
**Recomendação:** (a) MVP label-only (arte única por org, tier como texto/cor de campo). Arte por-tier depois como opt-in.

### Q60. Validade (exp) do token do QR 🟡
**Pergunta:** Qual a janela de validade do token assinado no QR da carteirinha?
**Por que importa:** Exp curto "mata" o QR offline; exp longo dá janela de fraude se vazar print. Revalidação online sempre existe.
**Opções:** (a) horas (~12h) com rotação + revalidação online; (b) dias (~7d); (c) TOTP dinâmico já no MVP.
**Recomendação:** (a) ~12h + revalidação online sempre no MVP. TOTP dinâmico para alto risco pós-MVP.

### Q61. Foto no passe 🟡
**Pergunta:** A foto do membro aparece no passe? Em quais condições? _Consolida com Q44, Q66, Q120 (foto pública)._
**Por que importa:** Aumenta a prova de identidade mas é PII (LGPD/consentimento) e pesa no `.pkpass`.
**Opções:** (a) nunca no passe; (b) opcional por org + consentimento, default OFF; (c) sempre quando houver foto.
**Recomendação:** (b) Opcional por org com consentimento do membro, default desligado. Coerente com a minimização da rota pública.

### Q62. Tipo de passe Apple (storeCard vs. generic) 🟢
**Pergunta:** Usar `storeCard` ou `generic`? A org pode escolher?
**Por que importa:** `storeCard` sugere fidelidade (saldo, strip grande); `generic` é mais neutro.
**Opções:** (a) generic padrão; (b) storeCard padrão; (c) configurável.
**Recomendação:** (a) Padrão `generic` no MVP (mais neutro entre verticais); `storeCard` como opção no editor depois.

### Q63. Ingresso usado como lembrança 🟢
**Pergunta:** Após o evento, o ticket pass expira/some ou vira colecionável?
**Por que importa:** Afeta o estado used vs. expired e a percepção de valor (memorabilia).
**Opções:** (a) expira/recolhe logo após; (b) marca "Utilizado" e mantém como lembrança; (c) configurável por evento.
**Recomendação:** (b) Marcar "Utilizado" e manter o passe como lembrança por padrão; expiração técnica só muito depois. Reforça pertencimento.

### Q64. Revogação do passe ao expirar plano parcelado 🟢
**Pergunta:** Ao expirar `access_until` de plano parcelado sem renovação, o passe revoga imediatamente ou há grace?
**Por que importa:** Plano parcelado não tem renovação automática. Coerência com §13.3.2.
**Opções:** (a) revoga no fim sem grace; (b) mesmo grace de inadimplência; (c) mostrar "válido até {data}" e revogar na data.
**Recomendação:** (c) Mostrar "válido até {data}" no passe e revogar na data, sem grace (compra avulsa de acesso por período).

### Q65. Idiomas do passe 🟢
**Pergunta:** Em quais idiomas os passes são emitidos e como escolher o locale?
**Por que importa:** §30.5 define pt-BR/en-US/es. Wallet suporta `pass.strings`/`translatedValues` nativamente.
**Opções:** (a) pt-BR only no MVP; (b) os três seguindo idioma do membro; (c) seguir locale do device.
**Recomendação:** (c) Suportar os três via `pass.strings`/`translatedValues` seguindo o locale do device já no MVP (custo baixo, jeito nativo do Wallet).

### Q66. Re-push em massa ao trocar arte/marca 🟢
**Pergunta:** Trocar a arte/marca re-publica todos os passes automaticamente ou só no próximo push natural? _Consolida com Theming Q130._
**Por que importa:** Re-push em massa pode estourar cotas Google/APNs; passes velhos com arte antiga incomodam.
**Opções:** (a) re-push automático em massa; (b) botão manual "republicar passes" com backoff; (c) nunca em massa.
**Recomendação:** (b) Botão manual "republicar passes" orquestrado com fila/backoff, com aviso "isso reemite N passes". Re-push automático SÓ quando a arte/cor do card muda (detectado por diff dos campos do passe); mudanças que não afetam o passe não disparam nada.

### Q67. Emissão server-to-server e link de distribuição 🟢
**Pergunta:** No fluxo headless, um parceiro emite passes em nome do membro sem clique "Adicionar ao Wallet"? Pode enviar por e-mail/link?
**Por que importa:** Define se `issue()` exige sessão do membro ou aceita server-to-server; importante para onboarding em massa e modo headless.
**Opções:** (a) só o membro autenticado emite; (b) server-to-server + link de distribuição; (c) com flag/consentimento por org.
**Recomendação:** (b) Permitir server-to-server + link de distribuição (e-mail/SMS), pois o modo headless exige paridade total; registrar no audit log.

---

## H. Validação Pública & Check-in/Portaria

### Q68. Check-in offline no MVP 🔴
**Pergunta:** O check-in offline (portaria sem internet) entra no MVP ou na Fase 2?
**Por que importa:** Offline completo (manifesto assinado + outbox + sync com resolução de conflito) é o item XL e o maior risco técnico do domínio. _Consolida com Q63 (Passport offline)._
**Opções:** (a) MVP só online; (b) MVP com offline básico (valida local + outbox); (c) offline completo no MVP.
**Recomendação:** (a) MVP só online — a menos que exista cliente âncora com evento confirmado em local sem conectividade. Online cobre a maioria dos eventos urbanos. Para Passport: online por padrão com fallback offline na fase de check-in.

### Q69. Membro em grace passa na porta 🔴
**Pergunta:** Membro em grace/inadimplência (past_due) passa na porta ou é barrado?
**Por que importa:** A porta precisa saber se "pendência de pagamento" libera (amarelo) ou bloqueia. Coerência com a regra transversal de grace (Q40).
**Opções:** (a) durante grace = válido (amarelo) e entra; (b) entra só com override manual; (c) barrado.
**Recomendação:** (a) Durante o grace configurado = válido com aviso (amarelo) e entra; após o grace = barrado.

### Q70. Default de foto/nome na rota pública 🔴
**Pergunta:** Quais os defaults de campos públicos? A foto aparece em L1 (QR) por padrão? _Consolida com Q31, Q61, Q120._
**Por que importa:** É a fronteira LGPD da rota pública. Foto é o campo mais sensível e o mais útil contra fraude.
**Opções:** (a) conservador: L0 mostra tier+status+membro-desde, L1 nome abreviado, foto OFF; (b) foto ON em L1; (c) foto só em L2 (staff).
**Recomendação:** (a) Conservador: sem token só dados mínimos; nome em L1 como "João S."; foto OFF por padrão em L1, ON em L2 (staff). Org liga foto em L1 conscientemente, com consentimento na adesão + opt-in do membro (dupla porta).

### Q71. QR dinâmico (TOTP-like) no MVP 🟢
**Pergunta:** QR dinâmico anti-screenshot entra no MVP? Gerado pelo PWA ou pelo passe?
**Por que importa:** Defesa mais forte contra print compartilhado, mas Wallet tem suporte limitado a QR rotativo.
**Opções:** (a) sem dinâmico no MVP (estático + anti-reuso + foto bastam); (b) dinâmico via PWA; (c) dinâmico via Wallet.
**Recomendação:** (a) Sem dinâmico no MVP; estático + anti-reuso + foto na tela do operador cobrem o risco comum. Dinâmico via PWA como opt-in pós-MVP.

### Q72. Override manual de check-in negado 🟡
**Pergunta:** O operador pode forçar entrada de um check-in negado? Quem pode e exige justificativa?
**Por que importa:** Casos de borda na porta acontecem; sem override trava a fila, com override irrestrito o anti-fraude vira teatro.
**Opções:** (a) sem override; (b) só admin/owner com justificativa obrigatória e auditoria; (c) override livre.
**Recomendação:** (b) Override só para admin/owner (não operator comum), com motivo obrigatório e registro em audit log.

### Q73. Política padrão de reentrada 🟡
**Pergunta:** Default de reentrada em eventos (sai e volta)?
**Por que importa:** Define se o anti-reuso é "uma entrada" ou "pode reentrar". Festivais permitem; assento único não.
**Opções:** (a) default sem reentrada; (b) default com reentrada e cooldown; (c) sempre perguntar na criação.
**Recomendação:** (a) Default sem reentrada; org liga reentrada por evento com cooldown para evitar double-scan.

### Q74. Ingressos transferíveis/nominais 🟡
**Pergunta:** Ingressos são nominais ao membro ou transferíveis a um não-membro? _Consolida com Q66 (eventos)._
**Por que importa:** Determina se o check-in valida "a pessoa é membro válido" ou "este ingresso é válido". Afeta foto exibida, anti-fraude e modelo.
**Opções:** (a) sempre nominais; (b) transferíveis com novo titular (re-emite passe); (c) configurável por evento.
**Recomendação:** (a) MVP: nominais ao membro (a identidade do membro é a checagem). Transferência com renomeação, limitada e bloqueada para inelegível, como recurso pós-MVP por evento.

### Q75. Resposta da rota pública para membro anonimizado 🟡
**Pergunta:** Membro anonimizado/excluído por LGPD: a rota pública responde "não encontrado" ou "membro inativo"?
**Por que importa:** Privacidade vs. coerência. "Não encontrado" apaga o rastro; "inativo" preserva o ID sem vazar PII.
**Opções:** (a) "não encontrado"; (b) "membro inativo" (sem PII); (c) "não encontrado" após janela de retenção.
**Recomendação:** (b) "Membro inativo" sem qualquer PII (e revogar todos os tokens). Mantém o ID resolvível (não quebra QRs antigos), sem expor dado nem motivo.

---

## I. Eventos & Ingressos

### Q76. Não-membro vira member-lead na compra 🔴
**Pergunta:** Não-membro que compra ingresso vira member-lead (com Member ID, sem login) na compra, ou o ingresso fica anônimo?
**Por que importa:** Decisão estrutural de dados — muda o schema de tickets (`member_id` obrigatório vs. nullable) e o fluxo de compra pública. Habilita CRM, check-in nominal, Hall of Fame e funil "compareceu→vire membro".
**Opções:** (a) criar member-lead na compra (source=event, e-mail não obrigatório); (b) ticket anônimo, vira member só no cadastro; (c) híbrido (anônimo por padrão, lead se a org ligar).
**Recomendação:** (a) Criar member-lead na compra. Unifica CRM/check-in/Hall of Fame e habilita o funil de conversão (pilar de valor). Custo de IDs irrelevante (capacidade ~1,36 bi).

### Q77. Página pública de evento no MVP 🟡
**Pergunta:** A página pública (compra por não-membro, sem login) entra no MVP, ou só venda dentro da área logada?
**Por que importa:** Canal de aquisição viral e topo do funil. Adiciona hot path anônimo (cache, rate-limit, anti-leak).
**Opções:** (a) página pública no MVP (ticket types "public"); (b) só venda logada, pública na Fase 2; (c) pública só para eventos "public".
**Recomendação:** (a) Incluir a página pública para ticket types "public" já no MVP — é o motor de aquisição. Reusa o padrão de hot path/anti-leak da rota de validação.

### Q78. Ingresso pode ser parcelado 🟡
**Pergunta:** Ingresso pode ser parcelado? Em quais condições e com a mesma engine de juros?
**Por que importa:** Eventos de alto valor (camarote, festival) podem precisar de parcelamento. Afeta o motor de checkout.
**Opções:** (a) nunca parcela; (b) parcela acima de valor mínimo configurável por org, juros pass-through; (c) parcela livremente por evento.
**Recomendação:** (b) Default não parcela; habilitar por org para ingressos acima de um mínimo, reutilizando a engine de juros de billing.

### Q79. Quem reembolsa ingresso e em qual janela 🟡
**Pergunta:** Quem pode pedir reembolso de ingresso e dentro de qual janela?
**Por que importa:** Reembolso reverte split e tem impacto legal (CDC/arrependimento).
**Opções:** (a) só admin; (b) membro self-service até D-X, bloqueado após check-in; (c) sem reembolso (só cancelamento do evento).
**Recomendação:** (a)→(b) Default só-admin; toggle de self-service por org com janela configurável e bloqueio após check-in/used.

### Q80. Ingresso incluso por tier e acompanhante 🟢
**Pergunta:** Quantos ingressos inclusos por membro por evento e como modelar acompanhante?
**Por que importa:** Define `max_per_member`, contabilidade do incluso (R$0) e cálculo de capacidade.
**Opções:** (a) 1 incluso, acompanhante no preço normal; (b) 1 incluso + N acompanhantes no preço de membro; (c) configurável por perk/tier.
**Recomendação:** (a) 1 incluso por membro por evento (default), acompanhantes no lote de membro com desconto.

### Q81. Fonte de verdade do check-in em evento importado 🟡
**Pergunta:** Evento importado de Sympla/Ingresse: quem é a fonte de verdade do check-in? Os dois lados podem dar check-in simultaneamente?
**Por que importa:** Duas portas ativas quebram o anti-reuso (a pessoa entra na Sympla e na Stanbase).
**Opções:** (a) Stanbase é a única porta; (b) provedor é a porta (só importamos para CRM); (c) configurável por evento, nunca simultâneo.
**Recomendação:** (c) Configurável por evento, nunca as duas simultaneamente. Default: se importado, check-in da Stanbase desligado salvo a org migrar a porta para cá.

### Q82. Política de adiamento (postpone) 🟡
**Pergunta:** No adiamento, ingressos seguem válidos com reembolso opcional, ou exige re-confirmação ativa?
**Por que importa:** Adiamento mal tratado gera disputa. Afeta communication, passport e billing.
**Opções:** (a) seguem válidos, reembolso opcional até janela; (b) re-confirmação obrigatória; (c) sem reembolso.
**Recomendação:** (a) Ingressos seguem válidos com reembolso opcional dentro de uma janela após o aviso. Padrão de mercado, menos atrito.

### Q83. Drops/ativações exclusivas no MVP 🟢
**Pergunta:** Drops e ativações exclusivas entram no MVP ou na Fase 2+? _Consolida com Q108 (gift físico)._
**Por que importa:** Dependem de fulfillment maduro (gifts físicos, endereços, assets digitais) e gating por tier.
**Opções:** (a) drops no MVP; (b) Fase 2+; (c) só drops digitais no MVP.
**Recomendação:** (b) Fase 2+. MVP foca em criar evento + vender ingresso (vira pass) + check-in. Drops dependem de gifts/comunicação maduros (pós-MVP).

---

## J. Conteúdo Exclusivo (Gated)

### Q84. Modelagem do perk de conteúdo: coleção vs. lista 🔴
**Pergunta:** O perk "content" aponta para uma COLEÇÃO (itens entram nela) ou para uma LISTA enumerada de `content_item_ids` (§25.5)?
**Por que importa:** Define se publicar um VOD novo exige re-resolver entitlements de toda a base (lista) ou se "simplesmente aparece" (coleção).
**Opções:** (a) por coleção/tag; (b) por lista de IDs (literal do doc); (c) híbrido.
**Recomendação:** (a) Por coleção. Publicar conteúdo novo não deve re-resolver entitlements de toda a base; alinhar com tiers-perks e anotar a divergência do §25.5.

### Q85. Semântica de gating por múltiplos tiers 🔴
**Pergunta:** Conteúdo gated por múltiplos tiers é OR (qualquer um libera) ou há AND? "Tier mínimo" inclui os acima?
**Por que importa:** Define a lógica central do `evaluateAccess`. Reordenar tiers muda a referência de "mínimo".
**Opções:** (a) OR + açúcar `min_tier` por position (tiers acima incluídos); (b) só `min_tier`; (c) OR + AND configurável.
**Recomendação:** (a) OR como default + `min_tier` que inclui tiers acima na ordem `position`. Avisar que reordenar afeta gating por `min_tier`. Evitar AND no MVP.

### Q86. Gating na Stanbase vs. no provider 🔴
**Pergunta:** Para conteúdo externo (YouTube/Twitch/Vimeo), o gating é na Stanbase (embed unlisted/private) ou no provider (sync membership)?
**Por que importa:** Gating no provider é mais seguro mas exige conta/OAuth do membro; na Stanbase é provider-agnóstico mas "unlisted não é privado".
**Opções:** (a) MVP gating na Stanbase via embed unlisted; (b) MVP gating no provider; (c) por provider (Vimeo na Stanbase, YouTube/Twitch no provider).
**Recomendação:** (a) MVP gating na Stanbase via embed unlisted (Vimeo com domain-privacy é o mais forte). Gating no provider como refinamento pós-MVP. Conteúdo de altíssimo valor → Stanbase-hosted.

### Q87. Janela de acesso: absoluta vs. relativa 🟡
**Pergunta:** "VOD por 7 dias" é absoluta (todos perdem na mesma data) ou relativa por membro? Suportar os dois?
**Por que importa:** Relativa nunca expira para quem nunca abriu; absoluta é previsível.
**Opções:** (a) só absoluta; (b) só relativa; (c) ambas (admin escolhe por item).
**Recomendação:** (c) Suportar ambas, com ABSOLUTA como default. Relativa como opt-in para drip de cursos, deixando explícito qual modo está ativo.

### Q88. Nível de anti-pirataria no MVP 🟡
**Pergunta:** Aceitamos watermark + signed URL de TTL curto (dissuasório), ou exigimos DRM (Widevine/HLS) desde o início?
**Por que importa:** DRM/HLS têm custo alto (buy: Mux/Cloudflare Stream). Screenshot é impossível de bloquear no browser.
**Opções:** (a) MVP dissuasório (signed URL + watermark com Member ID); (b) MVP com DRM/HLS; (c) sem VOD hospedado no MVP.
**Recomendação:** (a) MVP dissuasório: progressive MP4 + signed URL renovável + watermark com Member ID. DRM/HLS pós-MVP só se houver demanda real.

### Q89. Conteúdo gated no grace period 🟡
**Pergunta:** Membro inadimplente em grace mantém acesso ao conteúdo gated, ou perde imediatamente? _Consolida com regra transversal Q40._
**Por que importa:** Manter no grace evita punir antes do prazo; cortar protege o conteúdo.
**Opções:** (a) mantém durante o grace; (b) perde imediatamente; (c) configurável por org.
**Recomendação:** (a) Mantém durante o grace (consistente com a máquina de estados de entitlement). Cortar só ao fim do grace.

### Q90. Acesso ao despublicar conteúdo em consumo 🟡
**Pergunta:** Ao arquivar/despublicar um conteúdo sendo consumido, cortamos na hora ou os grants vivos valem até expirar?
**Por que importa:** Cortar no meio frustra; deixar terminar mantém conteúdo "no ar" após a decisão (takedown legal exigiria corte imediato).
**Opções:** (a) nega novos /access mas honra grants vivos; (b) corte imediato; (c) admin escolhe no momento.
**Recomendação:** (a)+(c) Default: nega novos /access, honra grants vivos (TTL curto torna o corte rápido). Botão "remover imediatamente" para takedown legal.

### Q91. Conteúdo público (isca/teaser) e telemetria 🟢
**Pergunta:** Conteúdo público não-gated é um caso de uso? Registra consumo de não-membros?
**Por que importa:** Define se a biblioteca é funil de aquisição e implicações LGPD de rastrear anônimos.
**Opções:** (a) sim, `gating.mode='public'` + registrar consumo de logados; (b) não, 100% gated; (c) público sim, sem telemetria de não-membros.
**Recomendação:** (a)/(c) Suportar conteúdo público como isca de upsell; registrar consumo só de usuários logados/identificados (evita rastrear anônimo sem consentimento).

### Q92. Notificação de novo conteúdo 🟢
**Pergunta:** A notificação de "novo conteúdo publicado" é deste domínio (push/e-mail no `content.published`) ou de communication?
**Por que importa:** O membro precisa SABER que saiu conteúdo. Notificar só elegíveis exige cruzar publish com entitlements.
**Opções:** (a) MVP-light: `content.published` dispara notificação simples via communication; (b) campanha rica segmentada (pós-MVP); (c) fora de escopo.
**Recomendação:** (a) MVP-light: emitir `content.published` e disparar notificação simples aos elegíveis via communication. Campanha rica/segmentada depois.

---

## K. Comunidade & Canais

### Q93. Remoção de cargo/grupo no grace 🔴
**Pergunta:** Membro em grace (suspended): removemos o cargo/grupo imediatamente ou esperamos o grace acabar? _Consolida com regra transversal Q40._
**Por que importa:** Remover cedo irrita quem só atrasou 1 dia; tarde dá acesso grátis no canal mais valioso.
**Opções:** (a) remover só quando entitlement vai a revoked (fim do grace); (b) remover já em suspended; (c) configurável.
**Recomendação:** (a) Remover só ao fim do grace (entitlement revoked), não em suspended. Canal é o perk de maior atrito emocional; manter no grace reduz churn e chargeback. Configurável pós-MVP.

### Q94. Membro banido pelos mods mas pagando 🟡
**Pergunta:** Membro pagante banido no Discord/Telegram por conduta: o que acontece com membership e cobrança?
**Por que importa:** Conflito de soberania — a moderação é do dono, mas o membro continua pagando.
**Opções:** (a) manter cobrança + alertar o admin; (b) banir cancela membership automaticamente; (c) banir suspende cobrança.
**Recomendação:** (a) Manter cobrança + alerta forte ("membro pagante banido — revisar") e oferecer ao dono o botão de cancelar/reembolsar. Não automatizar cancelamento por ban (pode ser engano de mod).

### Q95. Re-adicionar membro que saiu manualmente 🟢
**Pergunta:** Membro que sai do Discord/grupo mas tem direito: re-adicionamos automaticamente?
**Por que importa:** Re-add à força é UX hostil e cria loop; nunca re-add deixa o membro perdido.
**Opções:** (a) nunca, mostrar "Reentrar"; (b) re-add sempre no reconcile; (c) configurável (canal "obrigatório").
**Recomendação:** (a) Default não re-adicionar (respeita a vontade) + botão "Reentrar". Flag "canal obrigatório" por canal para quem quer re-add.

### Q96. Cargos aditivos vs. exclusivos no upgrade 🟡
**Pergunta:** No upgrade, cargos/grupos são aditivos (tier superior herda os inferiores) ou exclusivos?
**Por que importa:** Define a forma do mapa tier→cargo e o diff de sync.
**Opções:** (a) sempre exclusivo (admin mapeia cada cargo); (b) sempre aditivo por position; (c) toggle por mapping, default exclusivo.
**Recomendação:** (c) Default exclusivo explícito (zero inferência mágica), com toggle "tiers superiores herdam" por org/tier para quem quer aditivo.

### Q97. Nível de automação do WhatsApp 🟡
**Pergunta:** WhatsApp (API Oficial) promete add/remove automático de grupo, ou convite/link com remoção assistida?
**Por que importa:** A Cloud API tem suporte limitado/evolutivo a gestão programática de grupos. §30.3 já fixou API Oficial.
**Opções:** (a) só entrar quando a API suportar add/remove confiável; (b) lançar com convite/link + remoção assistida; (c) usar Comunidades do WhatsApp.
**Recomendação:** (b) Validar a capacidade real da Cloud API antes do build; no MVP/Fase 2 entregar Discord+Telegram e tratar WhatsApp como convite/link + remoção assistida, evoluindo quando a API permitir. Não bloquear o domínio por WhatsApp.

### Q98. OAuth Discord: guilds.join vs. invite-link 🟡
**Pergunta:** Exigir o escopo `guilds.join` (auto-entrada com cargo) ou usar invite-link?
**Por que importa:** `guilds.join` automatiza tudo mas adiciona fricção/medo no consentimento OAuth.
**Opções:** (a) exigir `guilds.join` com fallback invite; (b) só invite-link; (c) configurável.
**Recomendação:** (a) Pedir `guilds.join` no OAuth com invite-link como fallback automático quando o membro não concede. Maximiza "cargo na hora" sem travar quem recusa.

### Q99. Múltiplas connections do mesmo provider 🟡
**Pergunta:** Uma org pode ter mais de uma connection do mesmo provider (2 servidores Discord separados)? _Consolida com Q90 (integrações)._
**Por que importa:** Quebra a unicidade `(org, provider)` e complica a UI de mapeamentos.
**Opções:** (a) 1 connection por (org, provider) com N guilds dentro (MVP); (b) N connections por provider.
**Recomendação:** (a) MVP: 1 connection por (org, provider), suportando multi-guild dentro dela. Modelar o schema permitindo N (unique inclui a conta externa), mas UI assume 1 por provider; liberar N quando houver demanda.

### Q100. Frequência do reconcile 🟡
**Pergunta:** Qual a frequência padrão do reconcile periódico e ele roda on-demand ao cancelar? _Consolida com Q91 (integrações)._
**Por que importa:** Reconcile é a única defesa contra drift. Muito frequente estoura rate limit; pouco frequente deixa janela de abuso.
**Opções:** (a) 24h + on-demand ao cancelar/downgrade; (b) 6h fixo; (c) configurável com teto.
**Recomendação:** (a) Reconcile completo diário (≤24h) em modo rate-limited + reconcile pontual on-demand ao cancelar/downgrade (remoção imediata). Default por capability: channel_sync 1-6h, payments diário, content_access 6-12h.

### Q101. Nudge de conta não vinculada (pending_link) 🟢
**Pergunta:** Notificamos proativamente o membro que pagou mas não vinculou a conta do canal?
**Por que importa:** Conta não vinculada é o maior gargalo de adoção ("paguei e não tenho acesso"). WhatsApp esbarra em template/opt-in.
**Opções:** (a) nudge pós-compra + lembrete após X dias; (b) só CTA passivo na área do membro; (c) configurável.
**Recomendação:** (a) Nudge pós-compra imediato + 1 lembrete após alguns dias se seguir pending_link, respeitando consentimento por canal. CTA passivo sempre visível. Envio via communication.

### Q102. Desvínculo da conta externa e cargo já concedido 🟢
**Pergunta:** Membro desvincula a conta (revoga OAuth) mas tem cargo: removemos o cargo?
**Por que importa:** Desvincular não é cancelar; o direito segue. Mas perdemos a referência `external_user_id`.
**Opções:** (a) manter o cargo e marcar pending_link com aviso; (b) remover o cargo; (c) manter mas avisar.
**Recomendação:** (a) Manter o cargo já concedido (membro tem direito) e marcar pending_link com aviso de que mudanças de tier não se refletirão até revincular.

---

## L. Comunicação, Campanhas & Presentes

### Q103. Custo do WhatsApp (e SMS) 🔴
**Pergunta:** Quem paga o custo do WhatsApp (cobrado por conversa pela Meta): embutido na comissão, repassado, ou cota grátis + excedente?
**Por que importa:** WhatsApp tem custo real por conversa, diferente de e-mail/push. Define se precisamos de billing de canal, cotas e hard caps.
**Opções:** (a) e-mail/push inclusos + WhatsApp embutido na comissão; (b) WhatsApp repassado como add-on; (c) cota grátis + excedente; (d) org traz a própria conta WhatsApp/BSP.
**Recomendação:** (c) E-mail e push inclusos; WhatsApp com cota grátis mensal por org + excedente com markup pequeno; org pode opcionalmente trazer o próprio BSP. Sempre mostrar estimativa e hard cap no compositor.

### Q104. WhatsApp no corte do MVP 🔴
**Pergunta:** WhatsApp entra no MVP de comunicação ou é fast-follow após e-mail/push?
**Por que importa:** Onboarding de BSP/Cloud API + aprovação de templates pela Meta leva dias/semanas. Define se o MVP depende dessa integração.
**Opções:** (a) WhatsApp no MVP (assume risco de prazo); (b) MVP só e-mail/push, WhatsApp fast-follow; (c) WhatsApp só transacional (utility) primeiro.
**Recomendação:** (b) MVP com e-mail + push; WhatsApp como fast-follow imediato. Iniciar o onboarding BSP/Meta em paralelo desde já (lead time longo), sem bloquear o lançamento.

### Q105. Lista de mensagens transacionais (base legal de contrato) 🔴
**Pergunta:** Quais mensagens são transacionais (base legal de contrato, ignoram opt-in de marketing) e o membro pode dar opt-out total delas? _Consolida com regra de opt-in (Q39 CRM)._
**Por que importa:** LGPD distingue marketing (consentimento) de transacional. Misturar gera bloqueio/ban no WhatsApp. Define o gate de envio.
**Opções:** (a) transacional sempre enviada com membership ativo (sem opt-out); (b) transacional com opt-out total; (c) membro escolhe canal mas não desliga conteúdo crítico.
**Recomendação:** (c) Transacional crítica (cobrança, falha de pagamento, segurança, ingresso) sempre enviada por base legal de contrato enquanto houver membership; membro escolhe o canal mas não desliga o conteúdo. Marketing sempre por opt-in (double opt-in para WhatsApp/SMS). Documentar a lista exata com o jurídico.

### Q106. Modelo de atribuição de conversão 🟡
**Pergunta:** Qual o modelo de atribuição e a janela padrão (ex.: 7 dias, last-touch)?
**Por que importa:** Liga campanha a receita na timeline do CRM. O modelo muda quanto crédito cada campanha recebe.
**Opções:** (a) last-touch 7 dias; (b) last-touch configurável por campanha; (c) multi-touch; (d) só se houve clique.
**Recomendação:** (a)→(b) Last-touch com janela padrão de 7 dias, configurável por campanha; conversão atribuída a quem recebeu E (preferencialmente) clicou na janela. Multi-touch depois.

### Q107. Provedor de e-mail e de push 🟡
**Pergunta:** Quais provedores definitivos de e-mail e push (custo, deliverability, DPA/LGPD)?
**Por que importa:** §30 item 7 em aberto. Afeta custo, features (warm-up, complaint loop, List-Unsubscribe) e DPA. Precisa estar definido antes do go-live (DNS, webhooks, contrato).
**Opções:** e-mail: Resend / SES / Postmark / SendGrid; push: Web Push (VAPID) / OneSignal / FCM.
**Recomendação:** E-mail: começar com Resend (DX) ou SES (custo em escala), Postmark como upgrade de deliverability. Push: Web Push/VAPID nativo no PWA (sem custo de terceiro). Fechar DPA com o provedor escolhido.

### Q108. Domínio de envio: Stanbase vs. org 🟡
**Pergunta:** E-mails saem do domínio da org (subdomínio com DKIM/SPF/DMARC) ou tudo do domínio Stanbase?
**Por que importa:** Deliverability depende de reputação. Domínio da org dá melhor entrega mas exige DNS por org; tudo Stanbase mistura reputação entre tenants.
**Opções:** (a) tudo Stanbase; (b) subdomínio dedicado por org; (c) híbrido (padrão Stanbase, org configura domínio próprio opcional).
**Recomendação:** (c) Híbrido: padrão sai de subdomínio Stanbase com pools/IP segmentados; orgs maiores configuram domínio próprio (alinha com white-label §24). Monitorar bounce/complaint por org e isolar reputação.

### Q109. Frequency capping 🟢
**Pergunta:** Qual o cap padrão de mensagens de marketing por membro por janela e é configurável por org?
**Por que importa:** Sem teto, várias campanhas bombardeiam o mesmo membro (fadiga → opt-out → dano de reputação).
**Opções:** (a) sem cap por padrão; (b) cap default conservador (ex.: 3/7 dias) configurável; (c) cap por tipo de mensagem.
**Recomendação:** (b) Cap default conservador (3-5 mensagens de marketing por membro por 7 dias), ajustável por org, com transacionais isentas. Mostrar no compositor quantos serão suprimidos.

### Q110. Agendamento por janela de fuso local 🟢
**Pergunta:** Campanha "às 9h locais" criada após esse horário: envia imediatamente ou no próximo dia válido?
**Por que importa:** Edge case de TZ que afeta a expectativa do dono sobre timing.
**Opções:** (a) enviar imediatamente para quem já passou (dentro da janela civilizada); (b) próximo dia válido; (c) org escolhe.
**Recomendação:** (a) Enviar imediatamente se ainda dentro da janela civilizada (ex.: antes das 20h locais); senão, próximo dia válido. Tornar visível no preview de agendamento.

### Q111. Presentes: cortesia vs. pago no MVP 🟢
**Pergunta:** Presentes no MVP são só cortesia (custo da org) ou já incluem gift pago pelo membro?
**Por que importa:** Gift pago adiciona cobrança/split Asaas, carrinho e edge cases de reembolso.
**Opções:** (a) só cortesia no MVP; (b) cortesia + gift pago; (c) cortesia no MVP, pago depois.
**Recomendação:** (a)/(c) Só cortesia no MVP (presentear superfã, §17). Gift pago entra depois reaproveitando o checkout de billing.

### Q112. Fulfillment de gift físico 🟢
**Pergunta:** A Stanbase faz logística do gift físico ou só orquestra (endereço, estados, rastreio manual)?
**Por que importa:** Determina se precisamos de integração com transportadora ou se o despacho é da org.
**Opções:** (a) Stanbase só orquestra; (b) integra com logística/transportadora; (c) marketplace de brindes.
**Recomendação:** (a) MVP: Stanbase orquestra (coleta endereço, estados, código de rastreio manual da org); logística e marketplace depois.

### Q113. Auto-pausa por bounce/complaint 🟢
**Pergunta:** Acima de qual taxa de bounce/complaint pausamos automaticamente os envios de uma org?
**Por que importa:** Bounce/complaint altos queimam a reputação de toda a plataforma (domínio compartilhado).
**Opções:** (a) auto-pausar acima de ~0,1% complaint / ~5% bounce e notificar; (b) só alertar; (c) pausar + exigir limpeza/reconfirmação.
**Recomendação:** (a)+(c) Auto-pausar a org acima dos thresholds de mercado, notificar o dono e exigir limpeza/reconfirmação de lista para reativar. Proteção da reputação compartilhada é inegociável.

---

## M. Camada de IA (IA-first)

### Q114. Confirmação de escrita por IA (copilot/MCP) 🔴
**Pergunta:** Quais ações o copilot/agente executa diretamente, quais exigem confirmação, e a confirmação é in-band ou out-of-band? _Consolida IA + MCP._
**Por que importa:** Define o blast-radius e o risco. Enviar para 5.000 membros, conceder cortesia paga ou anonimizar têm riscos muito diferentes. In-band é vulnerável a prompt injection.
**Opções:** (a) tudo proposto, humano confirma item a item; (b) IA executa baixo risco direto e propõe alto risco; (c) IA nunca escreve, só rascunha.
**Recomendação:** (b) Leitura executa direto; escrita vira proposta com confirmação. Híbrido no mecanismo: write de baixo impacto in-band; **destructive e financial sempre out-of-band** (humano logado no Admin). Ações financeiras, envio em massa (>100 membros) e anonimização exigem segunda confirmação. Nenhuma ação destrutiva é automática.

### Q115. Allowlist de tools do MCP 🔴
**Pergunta:** Quais grupos de endpoints /v1 podem ser tools MCP e quais ficam proibidos por padrão?
**Por que importa:** Cada tool é uma porta para a base; exposição cega amplia a superfície de ataque. Precisa de allowlist explícita antes de gerar o catálogo.
**Opções:** (a) só leitura + escrita não-destrutiva no MVP; (b) tudo com guardrails; (c) allowlist curada por endpoint.
**Recomendação:** (c) Allowlist curada (opt-in por endpoint). MVP: membros, CRM, segmentos, mensagens, passport, validação, métricas (read + write essenciais). **Proibir sempre via MCP:** gestão de API keys, webhooks, equipe, exclusão LGPD em massa. Financeiro (refund/cobrança) só pós-MVP.

### Q116. Escopo do opt-out de IA do membro 🔴
**Pergunta:** O opt-out do membro bloqueia só LLM/inferência, ou também churn score/segmentação local (sem LLM)? Qual a base legal do perfilamento? _Consolida IA + LGPD._
**Por que importa:** Define base legal (consentimento vs. legítimo interesse), RLS, filtros nos jobs e a comunicação de privacidade.
**Opções:** (a) opt-out só do LLM/inferência (analítico local por legítimo interesse); (b) opt-out total; (c) configurável por org.
**Recomendação:** (a) Default: opt-in explícito para envio ao LLM e inferência de perfil; analítico local (churn/segmentação sem LLM) por legítimo interesse com LIA documentada, com opt-out total disponível. Se a IA decidir sozinha algo com efeito relevante (ex.: cancelar acesso), exige consentimento/revisão humana.

### Q117. Autenticação do cliente MCP 🔴
**Pergunta:** Como o cliente MCP autentica no MVP: API key (org fixa), OAuth 2.1, ou ambos?
**Por que importa:** OAuth 2.1 Authorization Server é trabalhoso (consent, escolha de org, refresh) mas é o que clientes como Claude Desktop esperam. Depende do que a public-api já entregar.
**Opções:** (a) só API key no MVP, OAuth depois; (b) só OAuth; (c) ambos.
**Recomendação:** (a)→(c) API key no MVP (universal, org fixa pela credencial). OAuth 2.1 com escolha de org no consent entra junto se a public-api já oferecer; senão, logo depois.

### Q118. Provedor de embeddings 🟡
**Pergunta:** Qual provedor de embeddings (Anthropic não oferece endpoint)?
**Por que importa:** Sem embeddings não há similaridade de membros (sugestão de perk colaborativa, busca semântica). Adiciona sub-processador (DPA/LGPD).
**Opções:** (a) Voyage AI gerenciado; (b) open-source self-hosted; (c) outro gerenciado (OpenAI/Cohere); (d) adiar embeddings.
**Recomendação:** (a) Voyage AI gerenciado no MVP (qualidade/baixa fricção), atrás de um adapter para troca futura; se a exigência de minimizar sub-processadores for forte, self-hosted.

### Q119. Visibilidade de scores/segmentos ao membro 🟡
**Pergunta:** Churn score, segmentos e perfil inferido são visíveis ao membro ou só admin-facing?
**Por que importa:** Privacidade e risco reputacional (descobrir que é "em risco"). Define o que a member-app expõe.
**Opções:** (a) admin-facing (membro nunca vê); (b) membro vê só atributos inferidos que pode corrigir; (c) versão positiva (badges sim, "em risco" não).
**Recomendação:** (a)+(b) Admin-facing por padrão; o membro só vê e pode corrigir atributos inferidos sobre si (transparência LGPD), nunca o churn score nem labels de risco.

### Q120. Modelo de custo da IA para a org 🟡
**Pergunta:** O custo de tokens está incluso no 7,99% ou há limite/cobrança por uso?
**Por que importa:** §3 diz "IA-first incluso", mas tokens têm custo variável; copilot e geração em massa podem corroer a margem.
**Opções:** (a) totalmente incluso sem limite; (b) incluso com fair-use/budget cap por org; (c) add-on pago acima de cota.
**Recomendação:** (b) Incluso com fair-use cap generoso (capacidades baratas sempre on; geração intensiva e copilot com cota mensal). Preserva a headline "tudo incluso" sem expor a margem.

### Q121. Thresholds e janelas dos labels de segmentação 🟡
**Pergunta:** Quais os thresholds default (dormindo, em risco, superfã, mínimo de base para ML)? _Consolida com Q30 (lifecycle)._
**Por que importa:** Define quem cai em cada bucket; errar gera spam de alertas ou buckets vazios. Varia por vertical.
**Opções:** (a) defaults únicos de plataforma; (b) defaults por vertical ajustáveis; (c) configuráveis por org.
**Recomendação:** (b) Defaults por vertical (dormindo 60d, em risco churn≥0.7 com histerese, superfã top 10%/RFM 4+, mín. 50 membros ativos para ML), ajustáveis por org.

### Q122. Auto-preenchimento de atributos por IA 🟡
**Pergunta:** A IA pode preencher automaticamente atributos vazios, ou só sugerir para aprovação?
**Por que importa:** Auto-preenchimento grava hipóteses como dados; aprovação manual tem fricção. Define se dado inferido dispara automações.
**Opções:** (a) auto-preenche acima de confiança alta, marcado como inferido e reversível; (b) sempre sugere, nunca grava sem aprovação; (c) auto-preenche mas nunca usa como gatilho.
**Recomendação:** (a)+(c) Auto-preenche apenas campos vazios e não-sensíveis acima de confiança alta, marcado `source=ai_inferred` e reversível; nunca sobrescreve dado declarado; dado inferido não dispara ação financeira sem revisão.

### Q123. Idiomas da geração de IA 🟡
**Pergunta:** Em que idiomas a geração de IA (copy, perguntas) opera no MVP?
**Por que importa:** Geração multi-idioma na voz da marca exige exemplos/validação por idioma. Define escopo do brand_voice e golden-sets.
**Opções:** (a) só pt-BR no MVP; (b) pt-BR + en-US + es; (c) seguindo a config da org/membro.
**Recomendação:** (a) pt-BR no MVP (com brand_voice já modelando o campo de idiomas); en-US e es na fase de i18n completo, para não diluir a qualidade da voz da marca.

### Q124. Sugestões de IA no dashboard: 1 clique ou confirmação 🟡
**Pergunta:** Os cards de IA no dashboard executam a ação com 1 clique ou abrem fluxo pré-preenchido com confirmação?
**Por que importa:** 1 clique é poderoso mas arriscado (disparo indevido em massa). _Liga com Q114._
**Opções:** (a) sempre fluxo pré-preenchido com confirmação; (b) 1 clique para ações leves, confirmação para custo/envio; (c) 1 clique para tudo com undo.
**Recomendação:** (a) Sempre abrir fluxo pré-preenchido com confirmação. Ações com envio/dinheiro nunca em 1 clique cego.

### Q125. trusted_writes por API key 🟢
**Pergunta:** O dono pode marcar uma API key como `trusted_writes` (automação sem confirmar cada write)? Até que nível?
**Por que importa:** Automações legítimas ficam inviáveis se cada escrita exige confirmação; afrouxar demais elimina o guardrail.
**Opções:** (a) nunca afrouxar; (b) trusted_writes só para write não-destrutivo; (c) afrouxar tudo.
**Recomendação:** (b) Permitir `trusted_writes` por API key apenas para write não-destrutivo; destructive e financial sempre confirmam. Default false.

### Q126. Log de PII nos argumentos de tools 🟢
**Pergunta:** Como logar PII nos argumentos das tools MCP auditadas: mascarar, hashear ou não logar?
**Por que importa:** Auditar é exigido, mas argumentos têm PII; logar em claro fere minimização LGPD.
**Opções:** (a) em claro; (b) mascarar por default; (c) hashear; (d) só o nome da tool.
**Recomendação:** (b) Mascarar PII por default (nome/email/telefone parcialmente ocultos), configurável por org (masked/hashed/none).

### Q127. Copilot interno vs. MCP externo 🟢
**Pergunta:** O copilot interno e os agentes externos compartilham o mesmo MCP/guardrails, ou o copilot tem caminho privilegiado?
**Por que importa:** Decide se há uma ou duas implementações de "IA que age na base".
**Opções:** (a) mesmo MCP e guardrails; (b) copilot com caminho privilegiado.
**Recomendação:** (a) Mesmo MCP e guardrails; o copilot interno é mais um cliente, compartilhando o `<PendingActionInbox/>`. Evita duas implementações divergentes.

---

## N. Framework de Integrações

### Q128. Falha de credencial da org pausa syncs (não revoga membros) 🔴
**Pergunta:** Quando o token da org (ex.: Discord) expira e todos os membros podem perder cargo no próximo reconcile, quem é notificado e o que acontece?
**Por que importa:** Incidente de alto impacto — falha de credencial da ORG não deve punir membros que pagaram.
**Opções:** (a) notificar só o admin + PAUSAR syncs até reconectar (não revogar membros); (b) notificar admin e membros; (c) reconectar silenciosamente antes de notificar.
**Recomendação:** (a) Pausar syncs (não revogar acessos por falha de credencial da org) + notificar o admin com urgência. Membros só são afetados por decisões de membership, nunca por token da org expirado.

### Q129. Comportamento de revoke com provider degradado 🟡
**Pergunta:** Membro perde direito mas a integração está fora do ar e não conseguimos remover o acesso: o que fazer?
**Por que importa:** Buraco de segurança/receita — o membro que cancelou continua com acesso enquanto o provider está instável.
**Opções:** (a) enfileirar revoke com retry agressivo + reconcile (acesso persiste temporariamente); (b) bloquear/avisar admin; (c) ação manual de emergência (kick forçado).
**Recomendação:** (a) Enfileirar com retry agressivo + reconcile; expor no painel de saúde os revokes pendentes. O gap temporário é inevitável com provider fora do ar; tornar visível e auditável.

### Q130. Connector de nicho: membro ou admin conecta 🟡
**Pergunta:** Conectar conta de nicho (Steam/Riot) é responsabilidade do membro ou do admin?
**Por que importa:** Define em qual app a tela vive, o fluxo OAuth (token do membro vs. org) e como o atributo destrava o perk.
**Opções:** (a) membro conecta a própria conta; (b) admin conecta uma API key da org; (c) ambos.
**Recomendação:** (a) Membro conecta a própria conta para `niche_verify` (o atributo é dele); a org configura apenas o mapeamento atributo→perk. Steam/Riot são pós-MVP.

### Q131. SLA da postura "a gente conecta" 🟢
**Pergunta:** "Não vê sua ferramenta? a gente conecta" implica SLA de prazo, ou é só captura de demanda?
**Por que importa:** Cria expectativa do cliente. Sem clareza vira dívida.
**Opções:** (a) sem SLA — captura de demanda + Zapier como fallback; (b) SLA informal por volume de votos; (c) connectors sob demanda pagos.
**Recomendação:** (a) Sem SLA explícito no MVP: capturar via `connector_requests` (votável) e oferecer Zapier/Webhooks como caminho universal imediato. Avaliar serviço pago depois.

### Q132. Retenção de payloads de webhooks de entrada 🟢
**Pergunta:** Quanto tempo retemos os payloads crus de webhooks de entrada (`inbound_events`) que podem ter PII?
**Por que importa:** LGPD (minimização/retenção). Reter muito = risco; pouco = perde replay/debug.
**Opções:** (a) 7 dias; (b) 30 dias com cifragem do raw_payload; (c) 90 dias com cifragem.
**Recomendação:** (b) 30 dias com cifragem do `raw_payload` quando contiver PII, expurgo automático; extensão pontual para investigação de incidente.

### Q133. Catálogo de connectors por org/plano 🟢
**Pergunta:** O catálogo é igual para todas as orgs, ou o superadmin habilita/oculta por org?
**Por que importa:** §20 diz "todas as integrações grátis em qualquer plano", mas connectors beta/de risco podem ser liberados seletivamente.
**Opções:** (a) catálogo idêntico para todos; (b) superadmin controla por org via flag; (c) todos têm, beta exige opt-in.
**Recomendação:** (a)+(c) Catálogo idêntico para connectors "available"; connectors "beta" exigem opt-in/flag por org controlado pelo superadmin. Mantém a promessa e permite rollout seguro.

---

## O. API REST Pública, OpenAPI & Webhooks

### Q134. Valores monetários na API: centavos inteiros 🟡
**Pergunta:** Valores na API pública são centavos inteiros (`6000` = R$60,00), decimal ou string? Multi-moeda no MVP?
**Por que importa:** Contrato difícil de mudar (breaking change). Centavos evitam erros de float. Afeta DTOs e SDK.
**Opções:** (a) centavos inteiros + `currency` (padrão Stripe); (b) decimal 2 casas; (c) string decimal.
**Recomendação:** (a) Centavos inteiros + campo `currency` (BRL no MVP). Padrão da indústria, elimina erro de float, é o que o SDK/MCP esperam. Multi-moeda fora do MVP (Brasil-first).

### Q135. Modelo de credencial multi-tenant para parceiros 🟡
**Pergunta:** Parceiro multi-org usa OAuth client-credentials com grant por org, ou API key por org?
**Por que importa:** Define a arquitetura de credenciais e a segurança. Grant por org dá revogação ao dono; API key espalha segredos.
**Opções:** (a) OAuth client-credentials + grant por org; (b) API key por org; (c) ambos (API key no MVP, OAuth na Fase 4).
**Recomendação:** (c) OAuth client-credentials com grant por org como modelo oficial multi-org (Fase 4). No MVP, parceiro single-org usa API key. Nunca incentivar guardar API keys de vários donos.

### Q136. Política de deprecação/sunset da API 🟢
**Pergunta:** Qual a janela de sunset prometida aos integradores?
**Por que importa:** Promessa de estabilidade que afeta a confiança de quem constrói. Define headers Deprecation/Sunset e job de notificação.
**Opções:** (a) janela fixa generosa (6-12 meses) + aviso ativo; (b) janela curta (90 dias); (c) caso a caso.
**Recomendação:** (a) Janela mínima de 6 meses entre deprecated e sunset em /v1, com aviso por e-mail e headers Deprecation/Sunset, e changelog público.

### Q137. Rate limit e fail-open/closed 🟢
**Pergunta:** Quais os limites padrão por API key e, em glitch do contador, fail-open ou fail-closed?
**Por que importa:** Equilíbrio entre proteger a plataforma e não derrubar clientes legítimos.
**Opções:** (a) limite único generoso + fail-open com teto absoluto; (b) limites por tier + fail-closed; (c) limite baixo conservador.
**Recomendação:** (a) Limite único generoso (ex.: 600 rpm/burst 60) igual para todos, fail-open com teto absoluto de segurança; introduzir tiers de quota só quando houver parceiro grande.

### Q138. Paridade API ↔ front como gate de release 🟡
**Pergunta:** A regra de paridade total ("tudo que o front faz é possível via API") é gate obrigatório desde o MVP ou meta?
**Por que importa:** Gate aumenta o escopo de cada feature (endpoint /v1 junto). Meta ganha velocidade mas arrisca dívida.
**Opções:** (a) gate obrigatório desde o MVP; (b) meta, cobertura completa até a Fase 4; (c) paridade só para core de membro no MVP.
**Recomendação:** (c)→(b) Paridade como meta com gate apenas para capacidades core de membro (assinar/cancelar tier, ver membro, emitir passport, validar) no MVP; paridade total como gate a partir da Fase 4.

### Q139. Adoção uniforme de emit_domain_event 🔴
**Pergunta:** Os domínios produtores adotam `emit_domain_event` desde já (Fases 1-2), mesmo antes do app Zapier existir?
**Por que importa:** O motor de entrega só tem valor se o outbox for populado. Decisão de governança cross-domínio — CRM/timeline e futuros webhooks dependem da mesma fonte de eventos.
**Opções:** (a) adoção obrigatória desde a Fase 1; (b) só quando webhooks de saída entrarem (Fase 4); (c) híbrido (outbox desde já, entrega na Fase 4).
**Recomendação:** (a)/(c) Adotar `emit_domain_event` nos produtores desde que cada domínio entra (outbox sempre populado); a entrega externa pode ficar dark até a Fase 4.

### Q140. Ordering de webhooks 🟢
**Pergunta:** Garantia de ordem: best-effort unordered (com sequence no envelope) basta no MVP, ou ordering serial opt-in por chave?
**Por que importa:** Ordering serial introduz head-of-line blocking e complexidade no worker.
**Opções:** (a) best-effort unordered + sequence; (b) ordering serial opt-in por `ordering_key`; (c) serial só pós-MVP.
**Recomendação:** (a)→(c) Best-effort unordered no MVP com sequence/occurred_at no envelope e documentação explícita; ordering serial opt-in pós-MVP.

### Q141. Auto-disable de endpoint de webhook 🟢
**Pergunta:** Após quanto tempo de falha contínua desativamos um endpoint? 410 Gone desativa na hora?
**Por que importa:** Agressivo demais derruba integração por instabilidade; frouxo demais polui logs.
**Opções:** (a) 5 dias + notificação, 410 desativa na hora; (b) 3 dias; (c) 7 dias; (d) nunca auto-desativa.
**Recomendação:** (a) Auto-disable após 5 dias de falha contínua com notificação; 410 Gone desativa imediatamente; sempre com replay em massa ao reativar.

### Q142. Schedule de retries de webhook 🟢
**Pergunta:** Quantas tentativas e em que janela antes da DLQ?
**Por que importa:** Curto perde eventos de quem teve manutenção; longo atrasa a percepção de falha.
**Opções:** (a) 8 tentativas / ~10h; (b) ~24h; (c) configurável por endpoint.
**Recomendação:** (a) Default 8 tentativas em ~10h (imediato, 30s, 2min, 10min, 30min, 1h, 3h, 6h, com jitter), respeitando Retry-After; configurável por endpoint pós-MVP.

### Q143. Payload thin vs. fat 🟢
**Pergunta:** Webhooks usam thin events (ids + essenciais) ou fat events (objeto completo)? Teto de tamanho?
**Por que importa:** Thin vaza menos PII mas força chamada à API; fat infla o POST e expõe PII.
**Opções:** (a) thin por default + resource_url; (b) fat por default; (c) configurável por endpoint.
**Recomendação:** (a) Thin events por default com `data_truncated` + `resource_url` acima de 256 KB; opção fat por endpoint pós-MVP.

### Q144. Retenção do log de entregas 🟢
**Pergunta:** Quantos dias guardamos sucesso, falha e DLQ de `webhook_deliveries`?
**Por que importa:** Debug do dono vs. PII (response snippet) e custo de storage.
**Opções:** (a) sucesso 30d, DLQ 90d; (b) sucesso 90d, DLQ 180d; (c) sucesso 7d, DLQ 30d.
**Recomendação:** (a) Sucesso 30 dias, DLQ 90 dias, snippet limitado a ~2KB; eventos is_pii com expurgo mais curto.

### Q145. Limite de endpoints de webhook por org 🟢
**Pergunta:** Quantos endpoints por org e qual teto de eventos/minuto?
**Por que importa:** Sem limite, fan-out alto gera carga e custo de egress; limite baixo frustra integradores.
**Opções:** (a) 50 endpoints/org, sem teto rígido; (b) 10/org; (c) limites por plano.
**Recomendação:** (a) 50 endpoints por org no MVP, sem teto rígido (controlado pelo breaker por endpoint); como o modelo é all-in, não amarrar a plano.

### Q146. App oficial Zapier/Make 🟢
**Pergunta:** Quando publicar o app Zapier/Make?
**Por que importa:** Fallback universal de integração (§19), mas publicar antes da API estável gera retrabalho.
**Opções:** (a) publicar junto com a plataforma de devs (Fase 4); (b) infra REST Hooks no MVP, app após parceiros validarem; (c) terceirizar/atrasar.
**Recomendação:** (b) Infra de REST Hooks no MVP; publicar o app oficial Zapier na Fase 4 após a API estabilizar com 1-2 parceiros.

---

## P. Design System & Theming (white-label)

### Q147. Gate de contraste WCAG na publicação 🟡
**Pergunta:** Quando a cor de marca falha no contraste AA, bloqueamos a publicação ou permitimos com aviso?
**Por que importa:** Tensão entre fidelidade de marca e acessibilidade. Bloquear frustra; permitir cega o fã com baixa visão e cria risco jurídico.
**Opções:** (a) bloquear duro abaixo de AA; (b) bloquear abaixo de 3:1, avisar entre 3:1 e AA; (c) nunca bloquear; (d) bloquear no texto, permitir crua em decorativos.
**Recomendação:** (b)+(d) Bloquear abaixo de 3:1 em texto + avisar entre 3:1 e AA, com a cor de marca crua SEMPRE permitida em superfícies decorativas (o sistema deriva `*-contrast`).

### Q148. Liberdade de customização de tipografia 🟢
**Pergunta:** Lista curada de fontes, upload self-hosted, ou ambos?
**Por que importa:** Upload livre traz risco de licença, peso (woff2 gigante), glifos faltando (pt/es) e quebra de layout.
**Opções:** (a) só lista curada; (b) curada no MVP + upload pós-MVP com validação de licença; (c) upload livre.
**Recomendação:** (b) Lista curada no MVP, upload self-hosted pós-MVP com aceite de licença. Cobre 95% dos casos sem risco jurídico nem de qualidade.

### Q149. Marca da org no admin 🟢
**Pergunta:** Qual o limite da marca da org no admin (não-tematizável)? Só logo no header, ou cor de acento em chips?
**Por que importa:** §10 diz "igual pra todo mundo", mas o dono pode esperar ver "sua cara".
**Opções:** (a) só logo no header; (b) logo + 1 cor de acento em elementos pontuais; (c) admin totalmente neutro.
**Recomendação:** (b) Logo da org no header + reuso da cor da org apenas em chips de tier/avatares (onde o dado já é da org), nunca no chrome/navegação.

### Q150. Dark mode obrigatório ou opcional 🟢
**Pergunta:** Dark mode é obrigatório (claro+escuro) ou opcional por org?
**Por que importa:** Manter ambos exige curadoria em dobro; opcional simplifica mas perde a expectativa de UX moderna.
**Opções:** (a) sempre os dois; (b) opcional via `dark_enabled`; (c) sempre os dois, escuro 100% auto-derivado.
**Recomendação:** (b)+(c) Opcional por org (`dark_enabled`), com auto-derivação OKLCH como assistente. Default: dark ligado com derivação automática, org pode desligar.

### Q151. i18n do tema/strings do card 🟢
**Pergunta:** As labels do member card e passes são traduzidas pela Stanbase ou a org customiza por idioma?
**Por que importa:** Se a org editar strings, multiplica a superfície de tradução e o risco de texto quebrado.
**Opções:** (a) strings de sistema da Stanbase, org só muda visual; (b) org customiza rótulos-chave por idioma; (c) org customiza qualquer string.
**Recomendação:** (a)→(b) Strings de sistema pela Stanbase nos 3 idiomas; org customiza apenas um conjunto pequeno e controlado de rótulos de marca (nome do programa, saudações) com fallback automático se faltar tradução.

### Q152. Ownership da biblioteca de componentes 🟢
**Pergunta:** A biblioteca base (`packages/ui`) é escopo do design-system ou esforço compartilhado?
**Por que importa:** Define o esforço (L vs. XL) e quem entrega os ~30 componentes.
**Opções:** (a) tudo em design-system; (b) base/neutros aqui, feature nos domínios; (c) biblioteca mínima aqui, cada domínio cria os seus.
**Recomendação:** (b) Componentes base/neutros e de identidade (Button, Input, Card, MemberCard) no design-system; componentes de feature ricos (TierCheckout, Leaderboard) vivem nos domínios respectivos consumindo o `ui`.

### Q153. Customização visual do front hosted 🟡
**Pergunta:** Quanto a org customiza: só tokens (allowlist) ou layout/CSS livre?
**Por que importa:** Define se theming é seguro (sem XSS/defacement) ou vira page-builder. Mais liberdade = mais risco e custo de suporte.
**Opções:** (a) só tokens controlados; (b) tokens + blocos de conteúdo editáveis na landing; (c) CSS/HTML livre.
**Recomendação:** (b) Tokens controlados + blocos de conteúdo editáveis na landing (texto/imagem/ordem), nunca CSS/HTML arbitrário. Mantém branding forte sem virar page-builder nem abrir XSS.

---

## Q. Admin App & Member App

### Q154. KYC do Asaas bloqueante no onboarding 🔴
**Pergunta:** O wizard de onboarding deixa avançar com o passo de pagamento (Asaas/KYC) pendente, ou bloqueia antes de publicar?
**Por que importa:** KYC pode demorar. Bloquear trava o "monte em um dia"; não bloquear arrisca publicar tiers e não conseguir receber.
**Opções:** (a) não bloquear, marca "pendente", checkout fica "em breve" até KYC ok; (b) bloquear publicação até KYC; (c) permitir página "soft" (lista de espera) sem KYC.
**Recomendação:** (a) Não bloquear o wizard, mas o badge "pronto para vender" (e o checkout real) só acende com Asaas ativo — o dono monta tudo no mesmo dia e a venda libera quando o KYC sai.

### Q155. Limite síncrono vs. job para ações em massa 🟢
**Pergunta:** Acima de quantos registros uma ação em massa vira job assíncrono?
**Por que importa:** Muito baixo = burocrático para ações triviais; muito alto = browser travando e timeouts.
**Opções:** (a) síncrono até 200, job acima; (b) até 500; (c) sempre job; (d) até 1000.
**Recomendação:** (a) Síncrono até ~200 registros, job acima — equilibra resposta imediata e robustez para massa.

### Q156. Frequência do snapshot de métricas do dashboard 🟢
**Pergunta:** Com que frequência o snapshot de métricas é recalculado e quanto atraso é aceitável?
**Por que importa:** Frequente custa compute; esparso faz o dono desconfiar após uma venda.
**Opções:** (a) a cada 15 min + "atualizar agora"; (b) a cada 1 hora; (c) Realtime para contadores leves, snapshot 15min para pesados; (d) tempo real sempre.
**Recomendação:** (a)+(c) Snapshot a cada 15 min com "atualizar agora" por card, e Realtime só para contadores leves (novos membros/check-ins do dia).

### Q157. Visões salvas compartilhadas no MVP 🟢
**Pergunta:** Filtros/visões salvas podem ser compartilhados com a equipe desde o MVP ou começam pessoais?
**Por que importa:** Visões compartilhadas exigem decidir quem cria/edita/exclui e o que acontece quando o autor sai.
**Opções:** (a) só pessoais no MVP; (b) pessoais + compartilhadas, qualquer admin edita; (c) compartilhadas com controle de quem edita.
**Recomendação:** (a) Pessoais no MVP. Compartilhadas (scope=org) na Fase 2, com permissão de gerir visões da org.

### Q158. Responsividade do admin no MVP 🟢
**Pergunta:** Quanto do admin funciona em mobile/tablet no MVP — só portaria/consulta ou o painel inteiro?
**Por que importa:** Responsividade plena dos 14 módulos é caro.
**Opções:** (a) só portaria + consulta responsivos; (b) painel inteiro; (c) portaria mobile-first + leitura responsiva, edição desktop.
**Recomendação:** (c) Portaria mobile-first + leitura responsiva (dashboard, perfil, alertas) no MVP; edição pesada (editor de tiers, estúdio de campanha) desktop-first e responsiva pós-MVP.

### Q159. Idiomas do shell do admin no MVP 🟢
**Pergunta:** O admin suporta só pt-BR ou já pt-BR/en-US/es no MVP?
**Por que importa:** i18n completo desde o MVP custa tempo. _Liga com Q1._
**Opções:** (a) pt-BR only com infra i18n; (b) pt-BR + en-US; (c) os três.
**Recomendação:** (a) pt-BR no MVP com a infra de i18n já montada (chaves, não strings hardcoded); en-US/es traduzidos pós-MVP.

### Q160. Troca de org em rota não disponível 🟢
**Pergunta:** Ao trocar de org numa rota específica (ex.: /eventos), para onde vamos se a nova org não tem a permissão/recurso?
**Por que importa:** Detalhe que, se mal resolvido, gera tela em branco/403 a cada troca.
**Opções:** (a) sempre cair no dashboard; (b) tentar rota equivalente, senão dashboard; (c) manter rota com 403 amigável.
**Recomendação:** (b) Tentar a rota equivalente; se não permitida, cair suavemente no dashboard (sem 403 áspero).

### Q161. Self-service de assinatura na área do membro 🟡
**Pergunta:** O membro faz self-service de upgrade/downgrade/cancelar/pausar, ou só assina?
**Por que importa:** Muda telas e fluxos (proração, dunning visível). Afeta o escopo de telas e a carga de suporte.
**Opções:** (a) self-service completo no MVP; (b) só assinar + ver status, mudanças via suporte; (c) upgrade e cancelar no MVP, pausa/downgrade depois.
**Recomendação:** (b)→(c) MVP: assinar + ver status + cancelar self-service (reduz fricção legal e suporte). Upgrade/downgrade com proração logo depois. Evita construir UI de proração no caminho crítico.

### Q162. Web Push no MVP 🟢
**Pergunta:** Web Push faz parte do MVP ou e-mail + Realtime bastam?
**Por que importa:** Web Push (iOS exige PWA instalada + Safari 16.4+) tem custo e UX de instalação que pode atrasar o MVP.
**Opções:** (a) sem Web Push no MVP (e-mail + Realtime in-app); (b) só Android/desktop no MVP; (c) completo no MVP.
**Recomendação:** (a) Sem Web Push no MVP. Transacionais por e-mail + Realtime in-app. Push (com a complexidade do iOS) na fase pós-MVP.

### Q163. Embeds/SDK e modo headless no MVP 🟢
**Pergunta:** Embeds/SDK (modo híbrido) e headless entram no MVP ou na Fase 4?
**Por que importa:** Os 4 embeds (`<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`) com iframe + postMessage são esforço L e exigem API pública estável.
**Opções:** (a) só na Fase 4; (b) adiantar `<TierCheckout/>` e `<VerifyBadge/>` para parceiros early; (c) tudo no MVP.
**Recomendação:** (a) Seguir o roadmap: embeds/SDK na Fase 4, após a API pública estável. No MVP focar 100% no front hosted.

### Q164. Acesso visível ao membro durante grace 🟡
**Pergunta:** Em atraso (grace/dunning), o que o membro vê: tudo até o fim do grace ou perks já cortados? _Consolida com regra transversal Q40._
**Por que importa:** Define a máquina de estados de UX e o gating durante inadimplência.
**Opções:** (a) acesso total até o fim do grace + banner; (b) cortar premium imediatamente, manter card; (c) cortar tudo no primeiro atraso.
**Recomendação:** (a) Acesso total durante o grace com banner persistente de regularização; corte de entitlements/conteúdo/Wallet/Discord só ao fim do grace.

---

## R. Hall of Fame & Gamificação

### Q165. Compactação na vitrine pública (anti-dedução) 🔴
**Pergunta:** Membros opt-out deixam "buraco" anônimo na numeração ou a lista compacta e renumera só os visíveis?
**Por que importa:** Mostrar buracos permite deduzir que existe alguém em 2º (vazamento por dedução de PII).
**Opções:** (a) compactar (renumera só visíveis); (b) mostrar gap anônimo; (c) configurável.
**Recomendação:** (a) Compactar na vitrine pública (anti-dedução), mostrando ao próprio membro sua posição real e privada na área dele.

### Q166. Default de privacidade do destaque público 🔴
**Pergunta:** O membro entra opted-out (precisa ativar para aparecer) ou opted-in?
**Por que importa:** LGPD favorece opt-in explícito, mas opt-out-default enche a vitrine. Decisão regulatória que trava o go-live do destaque.
**Opções:** (a) opted-out default (opt-in explícito); (b) opted-in com aviso e opção de sair; (c) opted-in só com apelido.
**Recomendação:** (a) Opted-out default (opt-in explícito) — conformidade LGPD; incentivar opt-in com gamificação/convite.

### Q167. Subir de tier por XP: shadow perks vs. upgrade comercial 🟡
**Pergunta:** Subir de tier por XP é reconhecimento (shadow perks, assinatura intacta) ou upgrade comercial real (muda assinatura/preço)?
**Por que importa:** Tier-up comercial automático mexe em billing/proração sem ação do membro e conflita com "1 membership por org".
**Opções:** (a) shadow perks (entitlement source=gamification, assinatura intacta); (b) tier-up comercial real; (c) XP não sobe tier.
**Recomendação:** (a) Shadow perks — reconhecimento sem mexer em cobrança; "virar Founder de verdade" segue o caminho comercial normal.

### Q168. Perks por XP: revogáveis ou permanentes 🟡
**Pergunta:** Quando o XP cai abaixo do limiar (estorno/virada de temporada), os perks destravados são revogados ou permanentes?
**Por que importa:** Define se entitlements de gamificação são "marca d'água alta" ou "enquanto XP ≥ X".
**Opções:** (a) permanentes; (b) revogáveis se atrelados a XP corrente; (c) configurável por perk.
**Recomendação:** (c) Configurável por perk, default permanente para perks por marco e revogável para perks atrelados a XP sazonal corrente.

### Q169. Métrica de gasto do ranking 🟡
**Pergunta:** O ranking de gasto usa bruto pago ou líquido da org? Juros de parcelamento contam? _Consolida com Q29 (LTV)._
**Por que importa:** Justiça e percepção do ranking; juros pass-through é receita da Stanbase, não mérito do membro.
**Opções:** (a) bruto pago; (b) líquido da org; (c) bruto excluindo juros.
**Recomendação:** (c) Bruto pago excluindo juros de parcelamento (`customer_interest`) — mede o mérito do membro sem inflar por financiamento.

### Q170. Reembolso estorna pontos e/ou badge 🟢
**Pergunta:** Reembolso/chargeback estorna pontos/posição? Badge já conquistado por gasto é revogado?
**Por que importa:** Estornar a métrica viva é coerente; revogar badge quebra "badge é permanente".
**Opções:** (a) estorna métrica mas mantém badge; (b) estorna tudo, inclusive badge; (c) não estorna nada.
**Recomendação:** (a) Estornar a métrica/ranking de gasto (linha negativa no ledger), mas manter o badge conquistado — separar marco permanente de métrica viva.

### Q171. Antiguidade com gap (cancelou e voltou) 🟢
**Pergunta:** Antiguidade conta desde o primeiro ingresso ou só o período ativo atual?
**Por que importa:** Afeta justiça do ranking e badges de tempo ("1 ano de casa").
**Opções:** (a) desde o primeiro joined_at; (b) só o período ativo atual; (c) total descontando gaps acima de N dias.
**Recomendação:** (a)→(c) Desde o primeiro joined_at, com opção de descontar gaps acima de N dias (config) — premia lealdade sem ignorar abandono longo.

### Q172. Badges retroativos 🟢
**Pergunta:** Badge cujo critério muitos já cumprem vale retroativamente ou só pra frente?
**Por que importa:** Define se há job de backfill. Veteranos esperam reconhecimento imediato.
**Opções:** (a) sempre retroativo; (b) sempre só pra frente; (c) escolha por badge.
**Recomendação:** (c) Escolha por badge na criação, default "retroativo" para marcos (antiguidade/presença) e "pra frente" para campanha.

### Q173. Empate em vagas premiadas 🟢
**Pergunta:** Empate em "Top 3": todos os empatados ganham (share) ou desempate corta para 3 (resolve)?
**Por que importa:** Define quantos prêmios são concedidos e o custo.
**Opções:** (a) resolve; (b) share; (c) configurável por ranking.
**Recomendação:** (c) Configurável por ranking, default "resolve" para não estourar o nº de prêmios previsto.

### Q174. Temporadas/reset sazonal 🟢
**Pergunta:** Temporadas têm cadência fixa global ou cada org define? O que zera vs. persiste?
**Por que importa:** Define a UX e a expectativa ("seu XP da temporada zerou").
**Opções:** (a) cada org configura; (b) cadência fixa de plataforma; (c) sem temporada no início.
**Recomendação:** (a)→(c) Cada org configura (manual/mensal/trimestral/anual); badges e XP all-time sempre persistem, só XP/ranking sazonal zera. Começar só com all-time no MVP.

### Q175. XP por indicação (referral) 🟢
**Pergunta:** Crédito de XP por referral ocorre no cadastro do indicado ou só quando vira pagante? Self-referral bloqueado?
**Por que importa:** Referral é o vetor de fraude mais comum em gamificação.
**Opções:** (a) só quando vira pagante (self-referral bloqueado, cap/cooldown); (b) no cadastro; (c) referral fora de escopo.
**Recomendação:** (a)/(c) Só quando o indicado vira pagante, com self-referral bloqueado e cap/cooldown — se referral entrar no escopo; senão, fora do MVP.

### Q176. Sinais e pesos de engajamento 🟢
**Pergunta:** Quais sinais entram no engajamento e com que pesos default (check-in, conteúdo, mensagem, login, abertura)?
**Por que importa:** Métrica mais gameável e subjetiva; pesos definem a percepção de justiça.
**Opções:** (a) pesar mais sinais com custo real (check-in/conteúdo) e menos os baratos; (b) todos iguais; (c) 100% configurável sem default.
**Recomendação:** (a) Default ponderado (check-in/conteúdo altos, login/clique baixos com caps agressivos), totalmente recalibrável via sliders com simulação.

---

## S. Super-admin Stanbase (interno)

### Q177. Aprovação de impersonation (4-eyes vs. auditada) 🔴
**Pergunta:** Impersonation exige aprovação prévia (4-eyes)/consentimento do owner, ou basta ser 100% auditada + notificar? _Consolida com Q188 (acesso de suporte)._
**Por que importa:** Maior vetor de risco do domínio; equilíbrio entre fricção do suporte e controle contra abuso interno.
**Opções:** (a) sem aprovação prévia, auditada + notifica owner; (b) 4-eyes para suporte L1; (c) consentimento explícito do owner.
**Recomendação:** (a) MVP: sem aprovação prévia, 100% auditada + notificação ao owner com kill-switch. **Acesso de suporte por ticket com expiração (just-in-time)**, sempre auditado e visível à org. 4-eyes/consentimento como opção pós-MVP por papel/risco.

### Q178. Ações bloqueadas durante impersonation 🔴
**Pergunta:** Quais ações ficam bloqueadas por padrão na impersonation e como se desbloqueia? (excluir base, anonimizar em massa, sacar payout, transferir posse)
**Por que importa:** Sem bloqueio, um erro/ataque sob disfarce do owner destrói/esvazia uma org.
**Opções:** (a) bloquear todas destrutivas/financeiras, unlock caso-a-caso com motivo e scope alto; (b) bloquear só irreversíveis; (c) não bloquear, confiar na auditoria.
**Recomendação:** (a) Bloquear destrutivas/financeiras por default; permitir unlock explícito com motivo e scope elevado (superadmin/finance).

### Q179. Acesso de membros pagantes em suspensão dura da org 🔴
**Pergunta:** Na suspensão dura de uma org (inadimplência/abuso/moderação), os membros que pagaram mantêm acesso até o fim do período ou cortam na hora? O que o passport mostra?
**Por que importa:** Suspender a org pune fãs que pagaram de boa-fé. Cortar acesso pago gera reembolsos, chargebacks e dano reputacional.
**Opções:** (a) manter acesso pago até o fim + mensagem neutra de indisponibilidade; (b) cortar e reembolsar; (c) configurável por motivo (fraude corta, inadimplência mantém).
**Recomendação:** (a) Manter acesso pago até o fim do período + mensagem neutra (não "inativo"); estado intermediário "restricted" bloqueia novas cobranças/saques mas preserva o fã.

### Q180. Matriz de liability de reembolso pela plataforma 🔴
**Pergunta:** Qual a política default de quem absorve o estorno (org/Stanbase/split) em cada cenário? A Stanbase pode adiantar com `platform_balance` negativo? _Consolida com Q47 (chargeback)._
**Por que importa:** Impacto direto na margem e na relação com o dono. Sem política, vira decisão manual.
**Opções:** (a) matriz por cenário (fraude/abandono = org; erro da plataforma = Stanbase; chargeback = conforme culpa); (b) sempre debitar a org; (c) sempre Stanbase absorve.
**Recomendação:** (a) Matriz por cenário: erro nosso = Stanbase; org sumiu/fraude = org (adiantando com `platform_balance` negativo se sem saldo); chargeback = conforme culpa.

### Q181. Auto-suspensão por risco 🟢
**Pergunta:** A suspensão por risco (chargeback alto, KYC parado) pode ser 100% automática ou exige confirmação humana?
**Por que importa:** Automação reduz exposição a fraude, mas suspender uma org legítima por falso positivo causa dano grave.
**Opções:** (a) job enfileira candidatos, suspensão confirmada por humano; (b) auto-suspender só fraude flagrante; (c) auto-suspender em todos os gatilhos.
**Recomendação:** (a)→(b) Default: job enfileira candidatos para revisão humana; permitir auto-suspensão apenas para fraude flagrante com regra muito estrita.

### Q182. Impersonation silenciosa para investigação 🟢
**Pergunta:** Existe impersonation silenciosa (sem notificar o owner) para investigar fraude do próprio owner? Restrita a quais papéis?
**Por que importa:** Notificar avisa o suspeito; impersonation invisível mina a confiança se vazar.
**Opções:** (a) sempre notificar; (b) silencioso restrito a trust_safety/superadmin com justificativa reforçada; (c) silencioso para qualquer staff.
**Recomendação:** (b) Notificação padrão sempre; modo silencioso só para trust_safety/superadmin com justificativa reforçada, auditoria extra e revisão posterior.

### Q183. k-anonimato em métricas cross-tenant 🟢
**Pergunta:** Qual o limiar de supressão para métricas agregadas e quais rankings cross-tenant são permitidos?
**Por que importa:** Agregados pequenos podem re-identificar um membro; define a fronteira de privacidade do painel interno.
**Opções:** (a) suprimir células < 5 membros, permitir ranking de orgs, proibir ranking de membros cross-tenant; (b) suprimir < 10, só totais; (c) sem supressão.
**Recomendação:** (a) Suprimir células com menos de 5 membros; permitir ranking por org (org não é PII); proibir qualquer ranking/identificação de membro cross-tenant.

### Q184. RBAC interno (papéis e scopes) 🟢
**Pergunta:** Quem do time interno tem cada papel (support, finance, trust_safety, engineering, superadmin) e quais ações exigem scope elevado/4-eyes?
**Por que importa:** Define os gates de quem suspende, reembolsa, revela PII, muda flag financeira.
**Opções:** (a) papéis fixos com scopes pré-definidos; (b) scopes 100% granulares por pessoa; (c) só um papel superadmin no MVP.
**Recomendação:** (a) Adotar os 5 papéis com scopes pré-definidos no MVP; reservar ações financeiras/suspensão para finance/trust_safety/superadmin; granularidade fina pós-MVP.

### Q185. Project Supabase do painel interno 🟢
**Pergunta:** O painel interno usa o mesmo Supabase project (allowlist por domínio) ou um project separado?
**Por que importa:** Superfície de ataque, isolamento de credenciais e custo.
**Opções:** (a) mesmo project + allowlist corporativa + MFA; (b) project separado; (c) mesmo no MVP, separar ao escalar.
**Recomendação:** (a)→(c) MVP: mesmo project com allowlist de domínio corporativo + MFA obrigatório e domínio dedicado; avaliar project separado quando o time/risco crescer.

---

## T. Segurança & LGPD

### Q186. Self-service de exclusão LGPD vs. aprovação da org 🔴
**Pergunta:** Quando o titular pede exclusão no front, a Stanbase executa automaticamente ou a org (controladora) aprova primeiro?
**Por que importa:** Define se o membro tem self-service real. Afeta UX, prazo legal (15 dias) e quem responde juridicamente.
**Opções:** (a) self-service total (Stanbase só executa); (b) aprovação da org obrigatória; (c) híbrido (export self-service; exclusão notifica a org com janela para impugnar).
**Recomendação:** (c) Híbrido: export self-service imediato (baixo risco) e exclusão com notificação à org + janela curta (ex.: 7 dias) para impugnar por motivo legítimo, senão executa. Cumpre o direito do titular sem tirar a org da posição de controladora.

### Q187. Retenção financeira após anonimização e CPF no MVP 🔴
**Pergunta:** Qual o prazo de retenção do registro financeiro após anonimização? Capturamos CPF para NF no MVP? _Consolida com Q50 (NF) e edge case audit/financeiro da Fundação._
**Por que importa:** O edge case central (anonimização × histórico financeiro) depende de prazo concreto. CPF é PII; se não emitimos NF no MVP, capturá-lo é tratamento sem finalidade clara.
**Opções:** (a) 5 anos e NÃO capturar CPF no MVP; (b) reter conforme cada org definir; (c) capturar CPF já no MVP antecipando NFS-e.
**Recomendação:** (a) Reter financeiro por 5 anos (parâmetro de plataforma, ajustável) e NÃO capturar CPF no MVP — minimização. Anonimização remove PII do perfil mas mantém Member ID e registros financeiros despersonalizados. Audit_logs operacionais com retenção menor (12-24 meses). CPF só quando a NFS-e entrar (pós-MVP). Confirmar prazos com jurídico.

### Q188. Tratamento de menores de idade 🟡
**Pergunta:** Bloquear cadastro de < 13, exigir consentimento parental, ou deixar a org declarar e assumir?
**Por que importa:** Verticais de torcida/gamer têm menores. Consentimento parental é caro; bloqueio exclui público; deixar com a org pode não bastar perante a ANPD.
**Opções:** (a) bloquear cadastro direto de < 13; (b) fluxo de consentimento parental; (c) org declara público e produto aplica defaults conservadores.
**Recomendação:** (c)+(a) MVP: org declara público (`audience_is_minor`) + defaults conservadores (sem Hall público/foto pública para menores identificados) + bloqueio de cadastro direto de < 13 quando a data de nascimento revelar; consentimento parental formal pós-MVP. Data de nascimento opcional.

### Q189. Consentimento de marketing na importação de bases 🟡
**Pergunta:** Bases importadas: herdam "consentido=true", exigem double opt-in, ou importam como "unknown"?
**Por que importa:** Herdar consentimento duvidoso importa risco legal; exigir double opt-in de toda base gera atrito.
**Opções:** (a) importar como "unknown" + double opt-in antes do 1º marketing; (b) confiar na declaração da org; (c) "unknown" + 1 e-mail transacional de regularização.
**Recomendação:** (a)+(c) Importar como `unknown`, a org declara a base legal no audit, o primeiro contato de marketing exige opt-in (double opt-in recomendado), permitindo mensagem transacional de boas-vindas. Protege a Stanbase como operadora.

### Q190. Export consolidado cross-org 🟡
**Pergunta:** O export de portabilidade é estritamente por org, ou um membro em N orgs pode pedir um export consolidado?
**Por que importa:** Identidades são separadas por org; export consolidado cruzaria controladoras independentes e revelaria que a pessoa é membro de outra comunidade.
**Opções:** (a) sempre por org; (b) consolidado pela conta auth do titular; (c) por org por padrão, consolidado só se o titular acionar sabendo do risco.
**Recomendação:** (a) Sempre por org. Cruzar orgs feriria o isolamento entre controladoras independentes. Cada org responde pelo seu export. Coerente com identidades separadas.

---

## U. Observabilidade, QA & Operação

### Q191. Consentimento de analytics de produto 🔴
**Pergunta:** Analytics de comportamento é opt-out (legítimo interesse) ou opt-in explícito? _Consolida Member App + Observabilidade._
**Por que importa:** Define o que coletamos sem consentimento e o volume de dados de funil que CRM/IA consomem. Afeta o banner e o events-ingest.
**Opções:** (a) opt-in explícito; (b) opt-out (agregado/pseudônimo por legítimo interesse); (c) híbrido (essencial/segurança sempre; agregado anônimo por legítimo interesse; identificado só com opt-in).
**Recomendação:** (c) Híbrido: essencial/segurança tem base legal própria e sempre roda; analytics agregado e pseudônimo (first-party, sem cookies de terceiros) por legítimo interesse documentado; vínculo a `member_id` (identificado) e qualquer terceiro/cross-site só com opt-in. Validar com DPO.

### Q192. Ownership e visibilidade dos dados de analytics 🔴
**Pergunta:** O dono vê só a sua org; a Stanbase vê agregado anonimizado cross-org?
**Por que importa:** Define isolamento multi-tenant dos eventos, base legal do uso cross-org pela Stanbase e o que entra na DPA. Impacta RLS de `product_events`.
**Opções:** (a) dono vê a sua org, Stanbase vê agregado anonimizado cross-org (legítimo interesse); (b) Stanbase não usa cross-org sem consentimento do dono; (c) dado nunca sai da org.
**Recomendação:** (a) Dono vê a sua org (RLS por `org_id`); Stanbase usa apenas agregados anonimizados cross-org por legítimo interesse, previsto em contrato/DPA. Nunca expor PII de uma org a outra.

### Q193. Cobertura de on-call no lançamento 🟢
**Pergunta:** On-call 24/7 com paging ou só horário comercial + best-effort?
**Por que importa:** Define se faz sentido criar alertas P1 que acordam alguém. Afeta o alert-dispatcher e o roteamento.
**Opções:** (a) 24/7 com paging; (b) horário comercial + best-effort (só Slack fora); (c) sem on-call no v0.
**Recomendação:** (b) Horário comercial + best-effort fora no v0, com P1 apenas para queda total dos serviços de receita (checkout, verify pública). Expandir conforme o time cresce.

### Q194. SLOs oficiais por serviço crítico 🟢
**Pergunta:** Quais os alvos oficiais de disponibilidade/latência (API, checkout, verify, frescor de sync/push)?
**Por que importa:** O SLO define o que vira alerta. Alto demais gera fadiga; baixo demais gera cegueira.
**Opções:** (a) adotar os alvos propostos e calibrar com dados (modo observação primeiro); (b) SLOs conservadores no v0; (c) não formalizar SLO no v0.
**Recomendação:** (a) Rodar em modo observação por algumas semanas (medir sem alertar), calibrar limiares com dados reais e só então ligar paging com os alvos do plano como teto inicial.

### Q195. SLA contratual com donos (enterprise) 🟢
**Pergunta:** Há SLA com uptime garantido e alertas dedicados por org já no MVP?
**Por que importa:** Determina se precisamos de SLOs por org e alerta por tenant (custo de cardinalidade de métricas).
**Opções:** (a) sem SLA formal no v0 (status page basta); (b) SLA só para tier enterprise futuro; (c) SLA desde o lançamento.
**Recomendação:** (a)→(b) Sem SLA formal no v0; status page de plataforma + banner de saúde por org no admin. SLO/alerta por org como feature enterprise posterior.

### Q196. Incidente de tenant único vs. status page pública 🟢
**Pergunta:** Quando um problema que afeta uma org vira incidente público vs. fica só como banner no admin daquela org?
**Por que importa:** Evita assustar 1000 donos por um problema de 1, ou esconder um que já afeta muitos.
**Opções:** (a) só vira público se afetar serviço core compartilhado; (b) vira público se > X% das orgs do mesmo connector; (c) tudo de tenant fica no admin.
**Recomendação:** (a)+(b) Status page pública cobre apenas serviços core da Stanbase; degradação de provider externo vira incidente público só acima de um limiar (ex.: 25% das orgs daquele connector). Caso individual = banner no admin da org.

### Q197. Retenção de telemetria 🟢
**Pergunta:** Qual a retenção de cada superfície (logs, traces, webhook attempts, product_events, métricas)?
**Por que importa:** Retenção define custo do sink e exposição LGPD (logs e product_events podem conter PII).
**Opções:** (a) logs 30d / traces 14d / attempts 30d / product_events conforme consentimento / métricas 13 meses; (b) mais curta para conter custo; (c) mais longa para forense.
**Recomendação:** (a) Logs 30d quente / traces 14d amostrado / webhook attempts 30d / product_events conforme consentimento (expurgo na revogação) / métricas agregadas 13 meses. Tudo particionado com drop de partição.

### Q198. Jornadas e cadência do canário sintético 🟢
**Pergunta:** Quais jornadas o canário (tenant `__canary__`) exercita em produção e com que frequência?
**Por que importa:** Única defesa contra quebras silenciosas (ex.: certificado de passe expirado), mas checkout/emissão têm custo.
**Opções:** (a) verify + health-deep contínuos (1-5min), checkout sandbox + emitir passe a cada 15-60min; (b) tudo a cada poucos minutos; (c) só pós-deploy.
**Recomendação:** (a) Verify e health-deep contínuos (1-5min, baratos); checkout sandbox e emissão de passe a cada 15-30min e como smoke obrigatório pós-deploy. Excluir `__canary__` de toda métrica de negócio.

### Q199. Gates de teste bloqueantes de merge/deploy 🟢
**Pergunta:** Quais testes bloqueiam merge/deploy e qual o piso de cobertura (especialmente financeiro)?
**Por que importa:** Define a disciplina de CI e a velocidade. RLS bloquear merge é quase inegociável (segurança multi-tenant).
**Opções:** (a) unit+RLS+contract bloqueiam merge, e2e bloqueia promote, carga informa; (b) só RLS bloqueia; (c) tudo bloqueia incluindo carga e cobertura rígida.
**Recomendação:** (a) Unit+RLS+contract bloqueiam merge (RLS inegociável); e2e smoke bloqueia promote a prod; carga informa; piso de cobertura maior só em módulos financeiros e de identidade (Member ID, juros, proração).

### Q200. Retenção de logs de auditoria de plataforma 🟢
**Pergunta:** Quanto tempo retemos os logs de auditoria de plataforma (impersonation, reveal de PII, suspensões, reembolsos) e em que regime?
**Por que importa:** Compliance/LGPD e investigação dependem disso. _Liga com Q187._
**Opções:** (a) append-only, retenção longa (5 anos para financeiro/PII); (b) curta (1 ano); (c) por tipo de ação.
**Recomendação:** (a)+(c) Append-only e imutável; retenção alinhada ao prazo legal financeiro (sugerido 5 anos) para ações sensíveis; definir por tipo de ação; alinhar com security-lgpd.

---

_Fim do documento. Total: 200 perguntas consolidadas em 21 temas._
