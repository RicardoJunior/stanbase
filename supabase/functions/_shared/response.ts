import { corsHeaders } from "./cors.ts";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const ok = (data: unknown) => json(data, 200);
export const created = (data: unknown) => json(data, 201);

/** Consistent error envelope (§21.1). */
export const error = (code: string, message: string, status = 400, details?: unknown) =>
  json({ error: { code, message, details } }, status);

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}
