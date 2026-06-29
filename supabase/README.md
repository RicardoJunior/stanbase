# Stanbase — Supabase backend

Real backend for the prototype: Postgres schema + RLS (multi-tenant by `org_id`)
and Edge Functions (Deno) — including the **Asaas checkout** + **webhook**.

```
supabase/
├── config.toml
├── migrations/            # schema + RLS (aligned to app/src/types/domain.ts)
└── functions/
    ├── _shared/           # cors, response, billing (authoritative), asaas client, supabase client
    ├── checkout/          # POST: Asaas customer + payment + installments + split → pending tx
    ├── asaas-webhook/     # Asaas events → confirm/refund/overdue (updates tx/sub/member)
    └── v1/                # public API: /v1/health, /v1/public/verify/{memberId}
```

## Deploy (você roda — precisa do seu login/projeto)

```bash
# 1. Autenticar e linkar o projeto (use `! supabase ...` no chat para rodar interativo)
supabase login
supabase link --project-ref <SEU_PROJECT_REF>

# 2. Aplicar o schema + RLS
supabase db push

# 3. Secrets das functions (copie o exemplo e preencha)
cp supabase/functions/.env.example supabase/functions/.env   # edite ASAAS_API_KEY etc.
supabase secrets set --env-file supabase/functions/.env

# 4. Deploy das functions
supabase functions deploy checkout
supabase functions deploy asaas-webhook
supabase functions deploy v1
```

Depois:
- **Asaas → Integrações → Webhooks:** aponte para `https://<ref>.supabase.co/functions/v1/asaas-webhook`
  e use o mesmo `ASAAS_WEBHOOK_TOKEN`.
- **Front-end:** em `app/.env`, defina `VITE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1`.
  O checkout passa a chamar `…/checkout` de verdade (Pix gera QR; cartão usa o checkout do Asaas).

## Claims de org no JWT (RLS)

As policies usam `app.current_org()`, que lê `org_id` dos claims do JWT. Configure o
**Custom Access Token Hook** (Auth → Hooks) para injetar `org_id`/`role`/`account_id`
do `org_users` no token, e reemita o token ao trocar de org no seletor do admin.
As Edge Functions usam a **service role** (bypassa RLS) e filtram `org_id` explicitamente.

## Modo do front-end
Sem `VITE_FUNCTIONS_URL`, o app roda no modo protótipo (store local em `localStorage`),
útil para demo offline. Com a URL definida, o caminho de pagamento usa o backend real.
A migração completa de cada tela (leituras via `supabase-js`) é o próximo passo — a fachada
`app/src/lib/api.ts` foi desenhada para essa troca.
