import { Pool } from 'pg';
import { AiProviderSetting, AiProviderName, AI_PROVIDER_NAMES, DEFAULT_AI_PROVIDER_SETTING } from '@alt/shared';

export async function getAiProviderSetting(pool: Pool): Promise<AiProviderSetting> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'ai_provider'`
  );
  if (rows.length === 0) return DEFAULT_AI_PROVIDER_SETTING;
  try {
    const parsed = JSON.parse(rows[0].value);
    const provider: AiProviderName = AI_PROVIDER_NAMES.includes(parsed.provider) ? parsed.provider : 'gemini';
    const fallbacks: AiProviderName[] = Array.isArray(parsed.fallbacks)
      ? parsed.fallbacks.filter((f: unknown): f is AiProviderName => AI_PROVIDER_NAMES.includes(f as AiProviderName))
      : [];
    return { provider, fallbacks };
  } catch {
    return DEFAULT_AI_PROVIDER_SETTING;
  }
}

export async function setAiProviderSetting(pool: Pool, setting: AiProviderSetting): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ai_provider', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(setting)]
  );
}

export async function getTeamAiProviderSetting(pool: Pool, teamId: string): Promise<AiProviderSetting | null> {
  const { rows } = await pool.query<{ provider: string; fallbacks: string[] }>(
    `SELECT provider, fallbacks FROM team_ai_providers WHERE team_id = $1`,
    [teamId]
  );
  if (rows.length === 0) return null;
  const provider: AiProviderName = AI_PROVIDER_NAMES.includes(rows[0].provider as AiProviderName)
    ? (rows[0].provider as AiProviderName)
    : 'gemini';
  const fallbacks: AiProviderName[] = Array.isArray(rows[0].fallbacks)
    ? rows[0].fallbacks.filter((f): f is AiProviderName => AI_PROVIDER_NAMES.includes(f as AiProviderName))
    : [];
  return { provider, fallbacks };
}

export async function setTeamAiProviderSetting(pool: Pool, teamId: string, setting: AiProviderSetting): Promise<void> {
  await pool.query(
    `INSERT INTO team_ai_providers (team_id, provider, fallbacks, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (team_id) DO UPDATE SET provider = $2, fallbacks = $3, updated_at = NOW()`,
    [teamId, setting.provider, setting.fallbacks]
  );
}

export async function clearTeamAiProviderSetting(pool: Pool, teamId: string): Promise<void> {
  await pool.query(`DELETE FROM team_ai_providers WHERE team_id = $1`, [teamId]);
}

export async function getEffectiveAiProviderSetting(pool: Pool, teamId?: string | null): Promise<AiProviderSetting> {
  if (teamId) {
    const teamSetting = await getTeamAiProviderSetting(pool, teamId);
    if (teamSetting) return teamSetting;
  }
  return getAiProviderSetting(pool);
}
