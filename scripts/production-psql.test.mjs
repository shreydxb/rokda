import { describe, expect, it } from 'vitest';
import { runProductionPsql } from './production-psql.mjs';

// The release check reads production's catalog and cron jobs with psql over
// SUPABASE_DB_URL (outside review, F-02). The password must never reach argv
// or a log: CI logs for this repository are public.

const PASSWORD = 's3cret-pa55';
const DB_URL = `postgresql://postgres.abcdefghijklmnopqrst:${PASSWORD}@aws-0-region.pooler.supabase.com:5432/postgres`;

function fakePsql({ status = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status, stdout, stderr };
  };
  return { spawn, calls };
}

describe('runProductionPsql', () => {
  it('passes the password in PGPASSWORD, never in the arguments', () => {
    const { spawn, calls } = fakePsql({ stdout: 'ok\n' });
    const result = runProductionPsql({ dbUrl: DB_URL, projectRef: 'abcdefghijklmnopqrst', args: ['-At', '-c', 'select 1'], spawn, env: {} });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('psql');
    expect(calls[0].args.join(' ')).not.toContain(PASSWORD);
    expect(calls[0].args[0]).toContain('pooler.supabase.com');
    expect(calls[0].args.slice(1)).toEqual(['-v', 'ON_ERROR_STOP=1', '-At', '-c', 'select 1']);
    expect(calls[0].env.PGPASSWORD).toBe(PASSWORD);
  });

  it('redacts the password from anything psql prints, and keeps its exit status', () => {
    const { spawn } = fakePsql({ status: 2, stdout: `echo ${PASSWORD}`, stderr: `could not connect with ${PASSWORD}` });
    const result = runProductionPsql({ dbUrl: DB_URL, projectRef: 'abcdefghijklmnopqrst', args: [], spawn, env: {} });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stderr).not.toContain(PASSWORD);
    expect(result.stderr).toContain('***');
  });

  it('refuses a connection to another project than SUPABASE_PROJECT_REF names', () => {
    const { spawn, calls } = fakePsql();
    expect(() => runProductionPsql({ dbUrl: DB_URL, projectRef: 'zzzzzzzzzzzzzzzzzzzz', args: [], spawn, env: {} })).toThrow(/Refusing/);
    expect(calls).toHaveLength(0);
  });

  it('refuses to run without a connection string, rather than reading a local database', () => {
    const { spawn, calls } = fakePsql();
    expect(() => runProductionPsql({ dbUrl: '', projectRef: 'abcdefghijklmnopqrst', args: [], spawn, env: {} })).toThrow(/SUPABASE_DB_URL/);
    expect(calls).toHaveLength(0);
  });

  it('reports psql that could not start as a failure', () => {
    const spawn = () => ({ status: null, error: new Error(`spawn psql ENOENT ${PASSWORD}`) });
    const result = runProductionPsql({ dbUrl: DB_URL, projectRef: 'abcdefghijklmnopqrst', args: [], spawn, env: {} });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).not.toContain(PASSWORD);
  });
});
