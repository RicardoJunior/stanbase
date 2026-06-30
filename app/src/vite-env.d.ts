/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FUNCTIONS_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Org API key (x-api-key) for the `/v1-*` resource functions (integrations). */
  readonly VITE_ORG_API_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
