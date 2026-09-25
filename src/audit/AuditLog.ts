import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 감사 로그 (project.md §5.6).
 *
 * `context.globalStorageUri` 하위에 JSONL로 남긴다. vscode에 의존하지 않아
 * 확장 호스트 없이 테스트할 수 있다.
 *
 * 기록 대상은 툴 호출만이 아니다. **차단·거부·만료처럼 아무 일도 일어나지
 * 않은 사건**이 오히려 중요하다. 사용자가 나중에 "GPT가 뭘 시도했나"를
 * 되짚을 수 있어야 한다.
 */

export type AuditEventKind =
  | 'tool_call'
  | 'path_denied'
  | 'approval_denied'
  | 'approval_expired'
  | 'expired_choice'
  | 'disk_write'
  | 'command_execution'
  | 'auth_failure'
  | 'server';

export interface AuditEvent {
  readonly kind: AuditEventKind;
  readonly tool?: string;
  /** 인자 요약. 전체 인자를 남기지 않는다 — 파일 내용이 통째로 들어갈 수 있다. */
  readonly detail?: string;
  readonly ok?: boolean;
  readonly durationMs?: number;
  readonly message?: string;
}

interface AuditRecord extends AuditEvent {
  readonly ts: string;
}

const MAX_DETAIL_LENGTH = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ROTATED_SUFFIX = '.1';

export interface AuditLogOptions {
  readonly directory: string;
  readonly onError?: (message: string) => void;
}

export class AuditLog {
  private readonly filePath: string;
  /** 쓰기를 직렬화한다. 병렬로 append하면 줄이 섞인다. */
  private tail: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(private readonly options: AuditLogOptions) {
    this.filePath = path.join(options.directory, 'audit.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * 기록을 큐에 넣는다. 호출자를 블로킹하지 않는다 —
   * 감사 로그 때문에 툴 응답이 늦어지면 안 된다.
   */
  append(event: AuditEvent): void {
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      ...event,
      ...(event.detail === undefined ? {} : { detail: truncate(event.detail) }),
      ...(event.message === undefined ? {} : { message: truncate(event.message) })
    };

    this.tail = this.tail
      .then(() => this.write(record))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.options.onError?.(`Failed to write the audit log: ${reason}`);
      });
  }

  /** 큐에 쌓인 기록이 모두 디스크에 닿을 때까지 기다린다. */
  async flush(): Promise<void> {
    await this.tail;
  }

  private async write(record: AuditRecord): Promise<void> {
    if (!this.ready) {
      await fs.mkdir(this.options.directory, { recursive: true });
      this.ready = true;
    }

    await this.rotateIfNeeded();
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** 무한정 커지지 않게 한 세대만 보관한다. */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size < MAX_FILE_BYTES) {
        return;
      }
    } catch {
      return; // 아직 파일이 없다
    }

    await fs.rm(`${this.filePath}${ROTATED_SUFFIX}`, { force: true });
    await fs.rename(this.filePath, `${this.filePath}${ROTATED_SUFFIX}`);
  }
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_DETAIL_LENGTH)}...(${value.length} chars)`;
}
