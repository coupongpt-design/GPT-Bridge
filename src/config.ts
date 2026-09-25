import * as vscode from 'vscode';
import { isLang, type Lang } from './i18n';

export const CONFIG_SECTION = 'gptBridge';

export type ApprovalMode = 'always' | 'session' | 'pattern';
export type TunnelProvider = 'cloudflare' | 'none';

export interface BridgeConfig {
  readonly port: number;
  readonly autoStart: boolean;
  readonly tunnelProvider: TunnelProvider;
  readonly tunnelHostname: string | undefined;
  readonly approvalMode: ApprovalMode;
  readonly autoApprovePatterns: readonly string[];
  readonly approvalTimeoutSeconds: number;
  readonly autoSave: boolean;
  readonly denyExtraPatterns: readonly string[];
  readonly maxReadBytes: number;
  readonly commandExecutionEnabled: boolean;
  readonly commandAllowedExecutables: readonly string[];
  readonly language: Lang;
}

function isApprovalMode(value: string): value is ApprovalMode {
  return value === 'always' || value === 'session' || value === 'pattern';
}

function isTunnelProvider(value: string): value is TunnelProvider {
  return value === 'cloudflare' || value === 'none';
}

/** 빈 문자열 설정은 '미지정'으로 취급한다. */
function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArray(value: readonly unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * 설정을 읽어 타입이 확정된 형태로 반환한다.
 *
 * settings.json은 사용자가 직접 편집할 수 있어 enum 값이 스키마를 벗어날 수
 * 있다. 잘못된 값은 조용히 기본값으로 되돌린다 — 특히 approvalMode가 깨졌을 때
 * 자동 승인 쪽으로 넘어가면 안 되므로 always로 떨어뜨린다.
 */
export function readConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);

  const rawApprovalMode = cfg.get<string>('approval.mode', 'always');
  const rawProvider = cfg.get<string>('tunnel.provider', 'none');
  const rawLanguage = cfg.get<string>('language', 'en');

  return {
    port: cfg.get<number>('port', 3737),
    autoStart: cfg.get<boolean>('autoStart', false),
    tunnelProvider: isTunnelProvider(rawProvider) ? rawProvider : 'none',
    tunnelHostname: normalizeOptional(cfg.get<string>('tunnel.hostname', '')),
    approvalMode: isApprovalMode(rawApprovalMode) ? rawApprovalMode : 'always',
    autoApprovePatterns: stringArray(cfg.get<unknown[]>('approval.autoApprovePatterns', [])),
    approvalTimeoutSeconds: cfg.get<number>('approval.timeoutSeconds', 90),
    autoSave: cfg.get<boolean>('autoSave', false),
    denyExtraPatterns: stringArray(cfg.get<unknown[]>('deny.extraPatterns', [])),
    maxReadBytes: cfg.get<number>('maxReadBytes', 1048576),
    commandExecutionEnabled: cfg.get<boolean>('commandExecution.enabled', false),
    commandAllowedExecutables: stringArray(
      cfg.get<unknown[]>('commandExecution.allowedExecutables', [
        'git', 'node', 'npm', 'npx', 'python', 'python3', 'py', 'pytest', 'adb'
      ])
    ),
    // 알 수 없는 값은 영어로 떨어뜨린다. 기본 언어가 비는 것보다 낫다.
    language: isLang(rawLanguage) ? rawLanguage : 'en'
  };
}

/** gptBridge.* 설정이 바뀌었을 때만 콜백을 호출한다. */
export function onConfigChange(listener: (config: BridgeConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      listener(readConfig());
    }
  });
}
