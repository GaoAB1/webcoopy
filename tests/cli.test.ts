import { describe, expect, it, vi } from 'vitest';
import { buildCli } from '../src/cli.js';
import type { WebServerOptions } from '../src/web.js';
import { defaultAdapters } from '../src/pipeline.js';

/**
 * Regression coverage for the Docker startup bug:
 * the `web` compose service passed no `--web` flag, so the CLI fell through to
 * the pipeline branch and exited with "no URLs provided".
 */
describe('cli --web dispatch', () => {
  it('starts the web server without requiring URLs', async () => {
    const startWebServer = vi.fn(async (_options: WebServerOptions) => ({
      port: 3000,
      close: async () => {}
    }));
    const program = buildCli({ startWebServer });

    // Avoid commander's process.exit() on parse completion.
    program.exitOverride();
    // Keep the process alive handler from hanging the test.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);

    await program.parseAsync(['node', 'webcopy', '--web']);

    expect(startWebServer).toHaveBeenCalledTimes(1);
    expect(startWebServer.mock.calls[0][0]).toMatchObject({ port: 3000 });

    exitSpy.mockRestore();
    onSpy.mockRestore();
  });

  it('forwards --host 0.0.0.0 so Docker port mapping is reachable', async () => {
    const startWebServer = vi.fn(async (_options: WebServerOptions) => ({
      port: 3000,
      close: async () => {}
    }));
    const program = buildCli({ startWebServer });
    program.exitOverride();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);

    await program.parseAsync([
      'node', 'webcopy', '--web', '--host', '0.0.0.0', '--port', '3000'
    ]);

    expect(startWebServer).toHaveBeenCalledTimes(1);
    const options = startWebServer.mock.calls[0][0];
    expect(options.host).toBe('0.0.0.0');
    expect(options.port).toBe(3000);

    exitSpy.mockRestore();
    onSpy.mockRestore();
  });

  it('still errors when neither URLs nor --file are given (non-web mode)', async () => {
    const runPipeline = vi.fn(async (_urls: string[], _options: unknown) => []);
    const program = buildCli({ runPipeline: runPipeline as never });
    program.exitOverride();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    await program.parseAsync(['node', 'webcopy']);

    expect(runPipeline).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);

    process.exitCode = prevExitCode;
    errSpy.mockRestore();
  });
});

/**
 * `--doctor` exists to settle "I pulled the image but the fix isn't in"
 * confusion: it reports which extraction paths the running build supports,
 * derived from the live adapter objects rather than a hard-coded string.
 */
describe('cli --doctor', () => {
  /**
   * The capability probe is internal to cli.ts, so reproduce the same
   * behaviour here: feed each adapter an SPA shell carrying an SSR payload and
   * see whether markdown comes back.
   */
  function supportsSsrPayload(adapter: { extract: unknown }): boolean {
    const probe =
      '<html><head><title>probe</title></head><body>' +
      '<script>window.__NUXT__=(function(a){return {article:{article_info:{mark_content:"probe-body"}}};})(0);</script>' +
      '</body></html>';
    const r = (adapter as {
      extract: (u: string, h: string, p: string) => { markdown?: string } | undefined;
    }).extract('https://juejin.cn/post/1', probe, '');
    return typeof r?.markdown === 'string';
  }

  it('reports the juejin adapter as SSR-payload capable', () => {
    const juejin = defaultAdapters().list().find((a) => a.name === 'juejin');
    expect(juejin).toBeDefined();
    // If this fails, the running build predates the Nuxt payload support.
    expect(supportsSsrPayload(juejin!)).toBe(true);
  });

  it('runs --doctor without touching the network or writing files', async () => {
    const program = buildCli();
    program.exitOverride();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'webcopy', '--doctor']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('webcopy');
    expect(output).toContain('juejin');
    expect(output).toContain('ssr-payload+dom');

    logSpy.mockRestore();
  });
});
