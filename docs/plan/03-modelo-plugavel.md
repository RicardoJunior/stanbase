## 03. Princípio central — Perks & Integrações como sistema de plugins

> Esta é a decisão arquitetural que atravessa todo o produto. Os domínios **09 (Tiers & Perks)**, **19 (Framework de Integrações)** e **24 (Admin)** a detalham; o **§85 (Oportunidades de Integração)** é o backlog vivo dela. Aqui fica o princípio, claro e amplo.

### 03.1 A ideia

Na Stanbase, **um benefício é um plugin**. O dono do membership monta cada plano **escolhendo benefícios de um catálogo e atrelando ao tier** — e muitos desses benefícios são **integrações** (um canal/cargo exclusivo no Discord, um grupo de WhatsApp, um evento exclusivo, um benefício validado na Steam ou na Riot, conteúdo gated no YouTube, um desconto na loja…). Outros não dependem de integração (brinde, badge, desconto manual).

Dois objetivos que **não** se sacrificam mutuamente:

- **Fácil para o dono (self-service, sem código):** conectar uma integração é um clique de OAuth; conceder o benefício é arrastar o perk para o tier e preencher um formulário curto.
- **Fácil para a Stanbase (extensível):** adicionar um provider novo é **registrar um connector + um perk-type** no catálogo — sem refatorar a plataforma. O item novo passa a aparecer para **todas as orgs**.

### 03.2 O contrato de um "perk-type" (o que faz o plugin funcionar)

Cada **tipo de perk** declara três coisas. É isso que torna o sistema configurável **e** simples:

| Declaração | O que é | Exemplo (Discord) |
|---|---|---|
| **Integração requerida** (opcional) | Qual connector precisa estar conectado para o perk funcionar | `discord` (capability `channel_sync`) |
| **Config-schema** | Os campos que o dono preenche — **renderizados como formulário** no admin | "servidor", "cargo a conceder", "canal" |
| **Provision / Deprovision hooks** | O que fazer quando o membro **ganha** o direito e quando **perde** | grant → atribui o cargo; revoke → remove o cargo |

Quando o membro entra num tier, o **entitlement** correspondente é materializado e o **provision hook** roda (via o framework de integrações, §19); quando sai/cancela/fica inadimplente além do grace, o **deprovision hook** remove o acesso e o passport reflete a mudança.

### 03.3 As peças (resumo — detalhe em §19)

```
Catálogo de Connectors (global)         Catálogo de Perk-types (global)
        │  declara auth/capabilities             │  declara integração + config-schema + hooks
        ▼                                         ▼
  Connection (por org, OAuth/token cifrado)  Perk (instância configurada da org)
        │                                         │  atribuído a 1..N tiers (acúmulo por padrão)
        └──────────────► Mapping ◄────────────────┘
                            │ tier → recurso externo
                            ▼
                      Entitlement (por membro)  ──provision/deprovision──►  Provider externo
```

### 03.4 Regras de produto já decididas

- **Acúmulo por padrão:** tiers superiores herdam os perks dos inferiores (VIP = tudo de Membro + os extras de VIP). Um perk pode ser marcado como **exclusivo** de um tier.
- **Múltiplas instâncias do mesmo tipo:** ex.: dois grupos de WhatsApp diferentes em tiers diferentes — cada perk no tier é uma instância configurada.
- **Falha externa não tira direito:** instabilidade do provider degrada o sync (com retry/reconcile), mas **não revoga** o entitlement do membro (ver §09 e §19).
- **Connect-on-demand:** *"não vê sua ferramenta? a gente conecta pra você"* — há um caminho explícito para solicitar um connector que ainda não existe.

### 03.5 Por que isso é estratégico

É o que faz a mesma engine **"vestir qualquer comunidade"** (gamer, torcida, clube de carro, balada, creator, empresa) sem código sob medida, e transforma cada nova parceria/integração em **valor imediato para toda a base** — um backlog que cresce sem dívida técnica. O catálogo de expansão (~186 integrações mapeadas em ondas) está no **§85**.
