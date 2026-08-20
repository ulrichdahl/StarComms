import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, redactMember } from './config.js';

const tmpDirs: string[] = [];

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'starbridge-cfg-'));
  tmpDirs.push(dir);
  const path = join(dir, 'fleet.yaml');
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

const validYaml = `
fleet:
  - nato: alfa
    application_id: "123456789012345678"
    token_env: SB_TOKEN_ALFA
    controller: true
  - nato: bravo
    application_id: "234567890123456789"
    token_env: SB_TOKEN_BRAVO
`;

const validEnv = {
  SB_TOKEN_ALFA: 'aaa.bbb.ccc',
  SB_TOKEN_BRAVO: 'ddd.eee.fff',
};

describe('loadConfig', () => {
  it('accepts a minimal valid config and resolves tokens from env', () => {
    const cfg = loadConfig(writeConfig(validYaml), validEnv);
    expect(cfg.fleet).toHaveLength(2);
    expect(cfg.fleet[0]).toMatchObject({
      nato: 'alfa', applicationId: '123456789012345678', token: 'aaa.bbb.ccc', controller: true,
    });
    expect(cfg.fleet[1]?.controller).toBe(false);
  });

  it('sorts the fleet by NATO order regardless of yaml order', () => {
    const yaml = `
fleet:
  - nato: charlie
    application_id: "345678901234567890"
    token_env: SB_TOKEN_C
  - nato: alfa
    application_id: "123456789012345678"
    token_env: SB_TOKEN_A
    controller: true
  - nato: bravo
    application_id: "234567890123456789"
    token_env: SB_TOKEN_B
`;
    const cfg = loadConfig(writeConfig(yaml), {
      SB_TOKEN_A: 't1', SB_TOKEN_B: 't2', SB_TOKEN_C: 't3',
    });
    expect(cfg.fleet.map((m) => m.nato)).toEqual(['alfa', 'bravo', 'charlie']);
  });

  it('fails loud when the named env var is missing', () => {
    expect(() => loadConfig(writeConfig(validYaml), { SB_TOKEN_ALFA: 'x' })).toThrow(/SB_TOKEN_BRAVO/);
  });

  it('rejects a fleet with no controller', () => {
    const yaml = validYaml.replace('controller: true', '');
    expect(() => loadConfig(writeConfig(yaml), validEnv)).toThrow(/exactly one member must have controller/);
  });

  it('rejects a fleet with two controllers', () => {
    const yaml = validYaml.replace('token_env: SB_TOKEN_BRAVO', 'token_env: SB_TOKEN_BRAVO\n    controller: true');
    expect(() => loadConfig(writeConfig(yaml), validEnv)).toThrow(/found 2/);
  });

  it('rejects duplicate NATO names', () => {
    const yaml = `
fleet:
  - nato: alfa
    application_id: "111111111111111111"
    token_env: T1
    controller: true
  - nato: alfa
    application_id: "222222222222222222"
    token_env: T2
`;
    expect(() => loadConfig(writeConfig(yaml), { T1: 'a', T2: 'b' })).toThrow(/duplicate nato/);
  });

  it('rejects duplicate application ids', () => {
    const yaml = `
fleet:
  - nato: alfa
    application_id: "111111111111111111"
    token_env: T1
    controller: true
  - nato: bravo
    application_id: "111111111111111111"
    token_env: T2
`;
    expect(() => loadConfig(writeConfig(yaml), { T1: 'a', T2: 'b' })).toThrow(/duplicate application_id/);
  });

  it('rejects unknown NATO names', () => {
    const yaml = `
fleet:
  - nato: mike
    application_id: "111111111111111111"
    token_env: T1
    controller: true
`;
    expect(() => loadConfig(writeConfig(yaml), { T1: 'a' })).toThrow(/is not one of/);
  });

  it('rejects a non-snowflake application_id', () => {
    const yaml = `
fleet:
  - nato: alfa
    application_id: "not-a-snowflake"
    token_env: T1
    controller: true
`;
    expect(() => loadConfig(writeConfig(yaml), { T1: 'a' })).toThrow(/snowflake/);
  });

  it('applies documented defaults when no defaults block is present', () => {
    const cfg = loadConfig(writeConfig(validYaml), validEnv);
    expect(cfg.defaults).toMatchObject({
      locale: 'en',
      cueDurationMs: 1200,
      openTimeoutMs: 5000,
      silenceCloseMs: 2000,
      maxHoldMs: 60_000,
      closeCueEnabled: true,
    });
  });

  it('overrides defaults from the yaml', () => {
    const yaml = validYaml + `
defaults:
  locale: da
  cue_duration_ms: 900
  close_cue_enabled: false
`;
    const cfg = loadConfig(writeConfig(yaml), validEnv);
    expect(cfg.defaults.locale).toBe('da');
    expect(cfg.defaults.cueDurationMs).toBe(900);
    expect(cfg.defaults.closeCueEnabled).toBe(false);
  });
});

describe('redactMember', () => {
  it('strips the token', () => {
    const cfg = loadConfig(writeConfig(validYaml), validEnv);
    const redacted = redactMember(cfg.fleet[0]!) as Record<string, unknown>;
    expect(redacted.token).toBeUndefined();
    expect(redacted.nato).toBe('alfa');
  });
});
