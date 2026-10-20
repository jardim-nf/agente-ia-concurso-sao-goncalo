// Entrega ao navegador os dados públicos do Supabase (Project URL e chave anon),
// lidos das variáveis de ambiente da Vercel. Nada secreto passa por aqui.
export function GET() {
  const cfg = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  };
  return new Response(`window.APP_CONFIG = ${JSON.stringify(cfg)};\n`, {
    headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}
