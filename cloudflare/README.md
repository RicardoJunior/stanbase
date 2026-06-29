# Stanbase — hosting (Cloudflare) + custom domains

**Decisões de infra:**
- **App (front)** servido pelo **Cloudflare Pages** (build do Vite em `app/dist`).
- **Domínio próprio por membership** via **Cloudflare for SaaS (Custom Hostnames)**.
- **Backend + DB** no **Supabase Cloud** (ver `supabase/README.md`).

## 1. Servir o app no Cloudflare Pages

```bash
cd app
npm run build                 # gera app/dist (inclui public/_redirects → SPA fallback)
npx wrangler pages deploy dist --project-name stanbase
```

Variáveis de ambiente do Pages (produção): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_FUNCTIONS_URL` (= `https://<ref>.supabase.co/functions/v1`).
SPA routing: `app/public/_redirects` (`/* /index.html 200`) já incluso.

## 2. Domínio próprio por membership (Cloudflare for SaaS)

Modelo: a zona da plataforma (ex.: `stanbase.app`) tem um **fallback origin** proxied
(ex.: `cname.stanbase.app` → projeto Pages). Cada membership aponta um **CNAME** do seu
domínio (`membros.suacomunidade.com`) para esse alvo; a Stanbase registra o **custom hostname**
e o Cloudflare emite o **SSL** automaticamente.

Fluxo (casa com a tabela `custom_domains`, §23.1.8):
1. Org adiciona o domínio no admin → status `pending_dns`, mostramos o CNAME alvo.
2. Org cria o CNAME no provedor dela.
3. A Stanbase chama a API do Cloudflare:
   ```
   POST https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/custom_hostnames
   Authorization: Bearer {CF_API_TOKEN}
   { "hostname": "membros.suacomunidade.com",
     "ssl": { "method": "http", "type": "dv", "settings": { "min_tls_version": "1.2" } } }
   ```
   → guarda `cf_hostname_id`; status vira `ssl_issued` → `active` quando o cert emite.
4. Renovação do cert é automática (Cloudflare).

Provisionamento roda numa **Edge Function** (`functions/domains`, a ser adicionada no passe
pós-workflow) chamada pelo admin — a chave `CF_API_TOKEN` nunca vai ao browser.

### Secrets necessárias (Edge Function)
```
CF_API_TOKEN=...        # token com permissão SSL and Certificates: Edit + Zone: Read
CF_ZONE_ID=...          # zona da plataforma (stanbase.app)
CF_FALLBACK_ORIGIN=cname.stanbase.app
```

> Enquanto o domínio próprio não está `active`, `org.stanbase.app/<slug>` (ou `/m/<slug>`)
> sempre funciona como fallback.
