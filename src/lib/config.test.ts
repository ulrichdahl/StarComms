import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, redactMember } from './config.js';

const tmpDirs: string[] = [];

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'starcomms-cfg-'));
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
controller:
  application_id: "999999999999999999"
  token_env: SB_TOKEN_CONTROLLER
fleet:
  - nato: alfa
    application_id: "123456789012345678"
    token_env: SB_TOKEN_ALFA
  - nato: bravo
    application_id: "234567890123456789"
    token_env: SB_TOKEN_BRAVO
`;

const validEnv = {
  SB_TOKEN_CONTROLLER: 'zzz.yyy.xxx',
  SB_TOKEN_ALFA: 'aaa.bbb.ccc',
  SB_TOKEN_BRAVO: 'ddd.eee.fff',
};

describe('loadConfig', () => {
  it('accepts a minimal valid config and resolves tokens from env', () => {
    const cfg = loadConfig(writeConfig(validYaml), validEnv);
    expect(cfg.controller).toMatchObject({
      applicationId: '999999999999999999',
      token: 'zzz.yyy.xxx',
    });
    expect(cfg.fleet).toHaveLength(2);
    expect(cfg.fleet[0]).toMatchObject({
      nato: 'alfa', applicationId: '123456789012345678', token: 'aaa.bbb.ccc',
    });
    // Squad members no longer carry a controller flag; the controller is
    // a separate application (CLAUDE.md "Divergence from spec").
    expect((cfg.fleet[0] as Record<string, unknown>).controller).toBeUndefined();
  });

  it('sorts the fleet by NATO order regardless of yaml order', () => {
    const yaml = `
controller:
  application_id: "999999999999999999"
  token_env: SB_TOKEN_CONTROLLER
fleet:
  - nato: charlie
    application_id: "345678901234567890"
    token_env: SB_TOKEN_C
  - nato: alfa
    application_id: "123456789012345678"
    token_env: SB_TOKEN_A
  - nato: bravo
    application_id: "234567890123456789"
    token_env: SB_TOKEN_B
`;
    const cfg = loadConfig(writeConfig(yaml), {
      SB_TOKEN_CONTROLLER: 'z', SB_TOKEN_A: 't1', SB_TOKEN_B: 't2', SB_TOKEN_C: 't3',
    });
    expect(cfg.fleet.map((m) => m.nato)).toEqual(['alfa', 'bravo', 'charlie']);
  });

  it('fails loud when a fleet env var is missing', () => {
    expect(() => loadConfig(writeConfig(validYaml), {
      SB_TOKEN_CONTROLLER: 'z', SB_TOKEN_ALFA: 'x',
    })).toThrow(/SB_TOKEN_BRAVO/);
  });

  it('fails loud when the controller env var is missing', () => {
    expect(() => loadConfig(writeConfig(validYaml), {
      SB_TOKEN_ALFA: 'a', SB_TOKEN_BRAVO: 'b',
    })).toThrow(/SB_TOKEN_CONTROLLER/);
  });

  it('rejects a config with no controller block', () => {
    const yaml = validYaml.replace(/controller:\n  application_id:.*\n  token_env:.*\n/, '');
    expect(() => loadConfig(writeConfig(yaml), validEnv)).toThrow(/controller: block missing/);
  });

  it('rejects a squad member that carries the old controller flag', () => {
    const yaml = validYaml.replace(
      'token_env: SB_TOKEN_ALFA',
      'token_env: SB_TOKEN_ALFA\n    controller: true',
    );
    expect(() => loadConfig(writeConfig(yaml), validEnv)).toThrow(/no longer supported/);
  });

  it('rejects duplicate NATO names', () => {
    const yaml = `
controller:
  application_id: "999999999999999999"
  token_env: T0
fleet:
  - nato: alfa
    application_id: "111111111111111111"
    token_env: T1
  - nato: alfa
    application_id: "222222222222222222"
    token_env: T2
`;
    expect(() => loadConfig(writeConfig(yaml), { T0: 'z', T1: 'a', T2: 'b' })).toThrow(/duplicate nato/);
  });

  it('rejects an application_id shared with the controller', () => {
    const yaml = `
controller:
  application_id: "111111111111111111"
  token_env: T0
fleet:
  - nato: alfa
    application_id: "111111111111111111"
    token_env: T1
`;
    expect(() => loadConfig(writeConfig(yaml), { T0: 'z', T1: 'a' })).toThrow(/already used/);
  });

  it('rejects duplicate application ids between squad members', () => {
    const yaml = `
controller:
  application_id: "999999999999999999"
  token_env: T0
fleet:
  - nato: alfa
    application_id: "111111111111111111"
    token_env: T1
  - nato: bravo
    application_id: "111111111111111111"
    token_env: T2
`;
    expect(() => loadConfig(writeConfig(yaml), { T0: 'z', T1: 'a', T2: 'b' })).toThrow(/already used/);
  });

  it('rejects unknown NATO names', () => {
    const yaml = `
controller:
  application_id: "999999999999999999"
  token_env: T0
fleet:
  - nato: mike
    application_id: "111111111111111111"
    token_env: T1
`;
    expect(() => loadConfig(writeConfig(yaml), { T0: 'z', T1: 'a' })).toThrow(/is not one of/);
  });

  it('rejects a non-snowflake application_id', () => {
    const yaml = `
controller:
  application_id: "999999999999999999"
  token_env: T0
fleet:
  - nato: alfa
    application_id: "not-a-snowflake"
    token_env: T1
`;
    expect(() => loadConfig(writeConfig(yaml), { T0: 'z', T1: 'a' })).toThrow(/snowflake/);
  });

  it('applies documented defaults when no defaults block is present', () => {
    const cfg = loadConfig(writeConfig(validYaml), validEnv);
    expect(cfg.defaults).toMatchObject({
      locale: 'en',
      cueDurationMs: 1200,
      ringIntervalMs: 4_000,
      ringMaxMs: 20_000,
      hailSilenceCloseMs: 10_000,
      hailMaxHoldMs: 1_800_000,
    });
  });

  it('overrides defaults from the yaml', () => {
    const yaml = validYaml + `
defaults:
  locale: da
  cue_duration_ms: 900
  hail_silence_close_ms: 15000
`;
    const cfg = loadConfig(writeConfig(yaml), validEnv);
    expect(cfg.defaults.locale).toBe('da');
    expect(cfg.defaults.cueDurationMs).toBe(900);
    expect(cfg.defaults.hailSilenceCloseMs).toBe(15_000);
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
