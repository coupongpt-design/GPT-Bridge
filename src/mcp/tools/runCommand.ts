import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { newRequestId } from '../../approval/vscodeGate';
import { errorResult, textResult, type ToolContext, type ToolResult } from './types';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 1800;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const RUN_COMMAND_DESCRIPTION = `Run one local process in the current VS Code workspace.

This tool is intentionally conservative:
- It is registered only when gptBridge.commandExecution.enabled is true.
- The executable must be a bare name such as "git", "python", "pytest", "adb",
  or "powershell.exe"; absolute/relative executable paths are rejected.
- The executable must appear in gptBridge.commandExecution.allowedExecutables.
- cwd must be a workspace-relative directory and cannot escape through symlinks.
- The process is started directly with shell=false, so arguments are not interpreted
  by cmd.exe / sh. To use PowerShell intentionally, allow "powershell.exe" (or
  "pwsh.exe") and pass its flags through args.
- The user is ALWAYS asked to approve the exact command, even when file edits use
  session or pattern auto-approval.
- stdout/stderr are bounded and the process is terminated on timeout.

Important: a permitted executable still runs with the VS Code extension host user's
OS privileges. It may modify files outside the workspace, start processes, access
devices or use the network if that executable and its arguments permit it. The
approval prompt is therefore a security boundary, not a sandbox.

When to use: tests, git inspection, build commands, adb diagnostics and other
explicitly requested local development/QA commands.
When not to use: long-running servers or interactive commands that wait for input.

Parameters
  command             Bare executable name.
  args                Argument array. Default [].
  cwd                 Workspace-relative working directory. Default ".".
  timeout_seconds     1..1800. Default 120.
  max_output_bytes    Combined capture budget per stdout/stderr stream,
                      1024..1048576. Default 131072.`;

export const runCommandSchema = {
  command: z
    .string()
    .min(1)
    .max(128)
    .describe('Bare executable name, for example "git", "pytest", "adb" or "powershell.exe"'),
  args: z
    .array(z.string().max(32768))
    .max(256)
    .optional()
    .describe('Arguments passed directly to the executable. Default []'),
  cwd: z
    .string()
    .optional()
    .describe('Workspace-relative working directory. Default "."'),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe('Timeout in seconds. Default 120, maximum 1800'),
  max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(MAX_OUTPUT_BYTES)
    .optional()
    .describe('Maximum captured bytes for each of stdout and stderr. Default 131072')
};

export interface RunCommandArgs {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  timeout_seconds?: number | undefined;
  max_output_bytes?: number | undefined;
}

interface Capture {
  readonly parts: string[];
  bytes: number;
  truncated: boolean;
}

function normalizeExecutable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function commandPreview(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function quoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:=+@%-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function appendCapture(capture: Capture, chunk: string, limit: number): void {
  if (capture.bytes >= limit) {
    capture.truncated = true;
    return;
  }

  const encoded = Buffer.from(chunk, 'utf8');
  const remaining = limit - capture.bytes;
  if (encoded.length <= remaining) {
    capture.parts.push(chunk);
    capture.bytes += encoded.length;
    return;
  }

  capture.parts.push(encoded.subarray(0, remaining).toString('utf8'));
  capture.bytes = limit;
  capture.truncated = true;
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      });
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
    return;
  }

  child.kill('SIGKILL');
}

export async function runCommandTool(
  ctx: ToolContext,
  args: RunCommandArgs
): Promise<ToolResult> {
  const command = args.command.trim();
  if (!EXECUTABLE_NAME.test(command)) {
    return errorResult(
      'command must be a bare executable name containing only letters, digits, ".", "_" or "-".'
    );
  }

  const configured = ctx.config().commandAllowedExecutables;
  const allowed = new Set(configured.map((entry) => normalizeExecutable(entry.trim())));
  if (!allowed.has(normalizeExecutable(command))) {
    const shown = configured.length === 0 ? '(none configured)' : configured.join(', ');
    return errorResult(
      `Executable "${command}" is not allowed. Configure gptBridge.commandExecution.allowedExecutables. Current: ${shown}`
    );
  }

  const resolved = await ctx.guard.resolve(args.cwd ?? '.');
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.absolute);
  } catch {
    return errorResult(`Working directory not found: ${resolved.relative || '.'}`);
  }
  if (!stat.isDirectory()) {
    return errorResult(`Working directory is not a directory: ${resolved.relative || '.'}`);
  }

  const commandArgs = args.args ?? [];
  const preview = commandPreview(command, commandArgs);
  const cwdDisplay = resolved.relative || '.';
  const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxOutputBytes = args.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const decision = await ctx.approve(
    {
      id: newRequestId(),
      tool: 'run_command',
      relPath: cwdDisplay,
      summary: preview.length > 300 ? `${preview.slice(0, 297)}...` : preview,
      diskImmediate: true,
      alwaysConfirm: true
    },
    {
      original: undefined,
      proposed:
        `cwd: ${cwdDisplay}\n` +
        `command: ${preview}\n` +
        `timeout_seconds: ${timeoutSeconds}\n`
    }
  );

  if (decision !== 'approved') {
    return errorResult(
      decision === 'expired'
        ? 'The approval window expired, so the command was not run.'
        : 'The user rejected the command.'
    );
  }

  const stdout: Capture = { parts: [], bytes: 0, truncated: false };
  const stderr: Capture = { parts: [], bytes: 0, truncated: false };
  const started = Date.now();
  let timedOut = false;

  const child = spawn(command, commandArgs, {
    cwd: resolved.absolute,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => appendCapture(stdout, chunk, maxOutputBytes));
  child.stderr.on('data', (chunk: string) => appendCapture(stderr, chunk, maxOutputBytes));

  const timeout = setTimeout(() => {
    timedOut = true;
    void terminateProcess(child);
  }, timeoutSeconds * 1000);

  let exitCode: number | null;
  let signal: NodeJS.Signals | null;

  try {
    ({ code: exitCode, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }));
      }
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to start command "${command}": ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - started;
  const stdoutText = stdout.parts.join('');
  const stderrText = stderr.parts.join('');
  const rendered =
    `command: ${preview}\n` +
    `cwd: ${cwdDisplay}\n` +
    `exit_code: ${exitCode === null ? 'null' : exitCode}\n` +
    `signal: ${signal ?? 'none'}\n` +
    `timed_out: ${timedOut}\n` +
    `duration_ms: ${durationMs}\n` +
    `stdout_truncated: ${stdout.truncated}\n` +
    `stderr_truncated: ${stderr.truncated}\n\n` +
    `stdout:\n${stdoutText.length === 0 ? '(empty)' : stdoutText}\n\n` +
    `stderr:\n${stderrText.length === 0 ? '(empty)' : stderrText}`;

  if (timedOut) {
    return errorResult(`Command timed out after ${timeoutSeconds}s.\n${rendered}`);
  }
  if (exitCode !== 0) {
    return errorResult(rendered);
  }
  return textResult(rendered);
}
