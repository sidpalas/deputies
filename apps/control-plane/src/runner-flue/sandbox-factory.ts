import { createSandboxSessionEnv } from "@flue/sdk/sandbox";
import type {
  FileStat,
  SandboxApi,
  SandboxFactory,
  SessionEnv,
} from "@flue/sdk/sandbox";
import type { SandboxHandle } from "../sandbox/types.js";

export function sandboxHandleToFlueFactory(
  handle: SandboxHandle,
  cleanup?: () => Promise<void>,
): SandboxFactory {
  return {
    async createSessionEnv({
      cwd,
    }: {
      id: string;
      cwd?: string;
    }): Promise<SessionEnv> {
      return createSandboxSessionEnv(
        new SandboxHandleApi(handle),
        cwd ?? handle.workspacePath,
      );
    },
  };
}

class SandboxHandleApi implements SandboxApi {
  constructor(private readonly handle: SandboxHandle) {}

  async readFile(path: string): Promise<string> {
    return this.requireFs().readFile(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.requireFs().readFileBuffer(path);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.requireFs().writeFile(path, content);
  }

  async stat(path: string): Promise<FileStat> {
    return this.requireFs().stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    return this.requireFs().readdir(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.requireFs().exists(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.requireFs().mkdir(path, options);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    await this.requireFs().rm(path, options);
  }

  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const input: Parameters<SandboxHandle["exec"]>[0] = { command };
    if (options?.cwd) input.cwd = options.cwd;
    if (options?.env) input.env = options.env;
    if (options?.timeout !== undefined) input.timeoutMs = options.timeout * 1000;
    const result = await this.handle.exec(input);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  private requireFs() {
    if (!this.handle.fs) {
      throw new Error(
        `Sandbox provider "${this.handle.provider}" does not expose filesystem operations`,
      );
    }
    return this.handle.fs;
  }
}
