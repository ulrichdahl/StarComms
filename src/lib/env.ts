/** Environment loading. Node 22 loads .env natively; no dotenv dependency. */

let loaded = false;

export function loadEnv(file = '.env'): void {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env present — env may come from the container or the shell.
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return v.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer, got ${raw}`);
  return n;
}

export function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number, got ${raw}`);
  return n;
}
