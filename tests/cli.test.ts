import { describe, expect, it, vi } from 'vitest';
import { buildCli } from '../src/cli.js';
import type { WebServerOptions } from '../src/web.js';

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
