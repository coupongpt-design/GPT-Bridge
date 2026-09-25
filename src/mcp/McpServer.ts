import * as vscode from 'vscode';
import type { ApprovalGate } from '../approval/ApprovalGate';
import type { AuditLog } from '../audit/AuditLog';
import type { PendingPreview } from '../approval/vscodeGate';
import { readConfig, type BridgeConfig } from '../config';
import { t } from '../i18n';
import type { SecretStore } from '../secrets';
import type { BridgeStateStore } from '../state';
import { ensureCloudflared } from '../tunnel/binary';
import { TunnelManager } from '../tunnel/TunnelManager';
import { PathGuard } from '../workspace/PathGuard';
import { ReadTracker } from '../workspace/readTracker';
import { Ripgrep, resolveRgPath } from '../workspace/ripgrep';
import { McpHttpServer, MCP_ENDPOINT, PortInUseError } from './http';
import { createConfiguredServer } from './registry';
import type { ActivityEntry, ToolContext } from './tools/types';

export interface BridgeServerDeps {
  readonly log: vscode.LogOutputChannel;
  readonly store: BridgeStateStore;
  readonly secrets: SecretStore;
  readonly extensionPath: string;
  /** cloudflared 바이너리를 두는 곳 (context.globalStorageUri). */
  readonly storageDir: string;
  readonly onActivity: (entry: ActivityEntry) => void;
  readonly approvalGate: ApprovalGate;
  readonly audit: AuditLog;
  /** 'Diff 보기'용 내용 보관소. 요청 id로 키를 잡는다. */
  readonly previews: Map<string, PendingPreview>;
}

/**
 * MCP 서버 생명주기. 확장 쪽 관심사(워크스페이스, 설정, 상태, 알림)를
 * vscode 비의존 계층(McpHttpServer)에 연결한다.
 */
export class BridgeServer implements vscode.Disposable {
  private http: McpHttpServer | undefined;
  private tunnel: TunnelManager | undefined;
  private token: string | undefined;
  private starting = false;
  /** 세션 동안의 읽기 이력. 서버를 껐다 켜면 초기화된다. */
  private readonly reads = new ReadTracker();

  constructor(private readonly deps: BridgeServerDeps) {}

  get isRunning(): boolean {
    return this.http?.isRunning === true;
  }

  get port(): number | undefined {
    return this.http?.port;
  }

  async start(): Promise<void> {
    if (this.isRunning || this.starting) {
      this.deps.log.info('The server is already running');
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      const message = 'No workspace folder is open. Open a folder first.';
      this.deps.store.update({ status: 'error', message });
      void vscode.window.showErrorMessage(`GPT Bridge: ${message}`);
      return;
    }

    this.starting = true;
    this.deps.store.update({ status: 'starting', message: undefined });

    try {
      const config = readConfig();
      const guard = new PathGuard({
        root: folder.uri.fsPath,
        extraDenyPatterns: config.denyExtraPatterns
      });
      const root = await guard.realRoot();

      const rgPath = resolveRgPath(this.deps.extensionPath);
      if (rgPath === undefined) {
        this.deps.log.warn(
          'The ripgrep binary was not found. list_directory / search_text will be disabled.'
        );
        void vscode.window.showWarningMessage(
          t('server.rgMissing')
        );
      } else {
        this.deps.log.info(`ripgrep: ${rgPath}`);
      }

      // 읽기 이력은 서버가 살아 있는 동안 유지된다. 무상태 HTTP 계층과 달리
      // 이건 세션 개념이 있어야 의미가 있다 — 같은 대화 안에서의 반복을 잡는 것이므로.
      this.reads.reset();

      const ctx: ToolContext = {
        guard,
        root,
        config: (): BridgeConfig => readConfig(),
        log: this.deps.log,
        rg: rgPath === undefined ? undefined : new Ripgrep(rgPath),
        reads: this.reads,
        onBlocked: (tool, reason, requestedPath) => {
          // 차단된 접근 시도는 조용히 실패시키지 않는다 (project.md §5.5).
          this.deps.log.warn(`Blocked - ${tool}(${requestedPath}): ${reason}`);
          this.deps.audit.append({
            kind: 'path_denied',
            tool,
            detail: requestedPath,
            ok: false,
            message: reason
          });
          void vscode.window.showWarningMessage(
            t('server.blocked', `${tool} "${requestedPath}" (${reason})`)
          );
        },
        onActivity: (entry) => {
          this.deps.audit.append({
            kind: 'tool_call',
            tool: entry.tool,
            detail: entry.detail,
            ok: entry.ok,
            durationMs: entry.durationMs
          });
          this.deps.onActivity(entry);
        },
        approve: async (request, preview) => {
          this.deps.previews.set(request.id, preview);
          try {
            const decision = await this.deps.approvalGate.request(request);

            if (decision === 'denied') {
              this.deps.audit.append({
                kind: 'approval_denied',
                tool: request.tool,
                detail: request.relPath,
                ok: false
              });
            } else if (decision === 'expired') {
              this.deps.audit.append({
                kind: 'approval_expired',
                tool: request.tool,
                detail: request.relPath,
                ok: false
              });
            } else if (request.tool === 'run_command') {
              this.deps.audit.append({
                kind: 'command_execution',
                tool: request.tool,
                detail: `${request.relPath}: ${request.summary}`,
                ok: true
              });
            } else if (request.diskImmediate) {
              // 디스크에 즉시 반영되는 작업은 별도로 남긴다 (§4.2.1).
              this.deps.audit.append({
                kind: 'disk_write',
                tool: request.tool,
                detail: request.relPath,
                ok: true
              });
            }

            return decision;
          } finally {
            // 만료된 요청의 모달이 아직 떠 있을 수 있으므로 바로 지우지 않는다.
            // 그때 'Diff 보기'를 눌러도 게이트가 선택을 버리지만, 미리보기가
            // 비어 있으면 사용자에게 혼란스러운 빈 창이 뜬다.
            setTimeout(() => this.deps.previews.delete(request.id), 5 * 60_000);
          }
        }
      };

      this.token = await this.deps.secrets.ensureAuthToken();

      const http = new McpHttpServer({
        port: config.port,
        getToken: () => this.token,
        createServer: () => createConfiguredServer(ctx),
        log: {
          info: (message) => this.deps.log.info(message),
          warn: (message) => this.deps.log.warn(message),
          error: (message) => this.deps.log.error(message)
        },
        onAuthFailure: (reason, remoteAddress) => {
          this.deps.log.warn(`Auth failure (${reason}) - ${remoteAddress ?? 'unknown address'}`);
          this.deps.audit.append({
            kind: 'auth_failure',
            detail: remoteAddress ?? 'unknown address',
            ok: false,
            message: reason
          });
        }
      });

      const port = await http.start();
      this.http = http;
      this.deps.store.update({ status: 'running', port, message: undefined });
      this.deps.audit.append({ kind: 'server', detail: `started port=${port}`, ok: true });
      this.deps.log.info(`Local endpoint: http://127.0.0.1:${port}${MCP_ENDPOINT}`);

      if (config.tunnelProvider === 'cloudflare') {
        // 터널 실패는 서버 실패가 아니다. 로컬 엔드포인트는 계속 살아 있다.
        void this.startTunnel(port);
      } else {
        this.deps.log.info('Tunnel provider is none - the server is reachable locally only.');
      }
    } catch (error) {
      await this.stop();

      if (error instanceof PortInUseError) {
        const message = t('server.portInUse', error.port);
        this.deps.store.update({ status: 'error', message });
        const choice = await vscode.window.showErrorMessage(
          `GPT Bridge: ${message}`,
          t('server.openSettings')
        );
        if (choice === t('server.openSettings')) {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'gptBridge.port');
        }
        return;
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.deps.store.update({ status: 'error', message: reason });
      this.deps.log.error(`Failed to start the server: ${reason}`);
      void vscode.window.showErrorMessage(t('server.startFailed', reason));
    } finally {
      this.starting = false;
    }
  }

  /**
   * 터널 기동. 바이너리 확보(해시 검증 포함) → cloudflared 실행 → URL 파싱.
   * 어느 단계에서 실패해도 로컬 서버는 그대로 둔다.
   */
  private async startTunnel(port: number): Promise<void> {
    try {
      const binPath = await ensureCloudflared({
        storageDir: this.deps.storageDir,
        log: {
          info: (message) => this.deps.log.info(message),
          warn: (message) => this.deps.log.warn(message)
        }
      });

      const config = readConfig();
      const token = await this.deps.secrets.getTunnelToken();

      const tunnel = new TunnelManager({
        binPath,
        localPort: port,
        token,
        hostname: config.tunnelHostname,
        log: {
          info: (message) => this.deps.log.info(message),
          warn: (message) => this.deps.log.warn(message),
          error: (message) => this.deps.log.error(message)
        },
        onStatus: (status, url, message) => {
          if (status === 'connected') {
            this.deps.store.update({ status: 'tunneled', tunnelUrl: url, message });
            if (url !== undefined) {
              this.deps.log.info(`Tunnel connected: ${url}${MCP_ENDPOINT}`);
            }
            return;
          }
          if (status === 'failed') {
            // 서버 자체는 살아 있으므로 running으로 되돌린다.
            this.deps.store.update({ status: 'running', tunnelUrl: undefined, message });
            void vscode.window.showWarningMessage(
              t('server.tunnelFailed', message ?? 'unknown reason')
            );
            return;
          }
          if (status === 'stopped' && this.http !== undefined) {
            this.deps.store.update({ status: 'running', tunnelUrl: undefined });
          }
        }
      });

      this.tunnel = tunnel;
      const url = await tunnel.start();

      if (url !== undefined && token === undefined) {
        // Quick Tunnel은 재시작마다 URL이 바뀐다. 사용자가 알아야 한다.
        this.deps.log.warn(
          'A Quick Tunnel URL changes on every restart. Prefer a Named Tunnel for regular use.'
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`Failed to start the tunnel: ${reason}`);
      this.deps.store.update({ message: `Tunnel failed: ${reason}` });
      void vscode.window.showWarningMessage(
        t('server.tunnelFailed', reason)
      );
    }
  }

  async stop(): Promise<void> {
    // 서버가 실제로 떠 있었을 때만 기록한다. 이 메서드는 시작 실패 후의 정리와
    // dispose()에서도 불리는데, 그때까지 남기면 뜬 적 없는 서버의 종료가 찍히거나
    // 같은 종료가 두 번 찍혀 "이 시점에 서버가 살아 있었나"를 되짚을 수 없게 된다.
    const wasRunning = this.http !== undefined;

    // 세션 자동 승인은 서버를 내리면 해제한다. 기획안은 확장 리로드 시
    // 해제를 요구하지만, 서버를 껐다 켠 것도 새 세션으로 보는 편이 안전하다.
    this.deps.approvalGate.resetSession();

    const tunnel = this.tunnel;
    this.tunnel = undefined;
    if (tunnel !== undefined) {
      await tunnel.stop();
    }

    const http = this.http;
    this.http = undefined;
    if (http !== undefined) {
      await http.stop();
    }
    this.deps.store.update({ status: 'stopped', port: undefined, tunnelUrl: undefined });

    if (wasRunning) {
      this.deps.audit.append({ kind: 'server', detail: 'stopped', ok: true });
    }
  }

  /** 토큰 재발급 시 호출. 실행 중이면 즉시 새 토큰만 유효해진다. */
  async refreshToken(): Promise<void> {
    if (this.isRunning) {
      this.token = await this.deps.secrets.getAuthToken();
      this.deps.log.warn('Auth token refreshed. The previous token is invalid immediately.');
    }
  }

  dispose(): void {
    void this.stop();
  }
}
