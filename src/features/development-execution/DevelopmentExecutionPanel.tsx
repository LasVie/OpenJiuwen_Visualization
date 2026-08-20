import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Clock3,
  FileCode2,
  FlaskConical,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DevelopmentExecution,
  DevelopmentTestProfile,
} from "../../adapters/development-execution";
import type { DevelopmentAnalysisProjection } from "../development-assistant/model";
import { DevelopmentExecutionCanvas } from "./DevelopmentExecutionCanvas";
import type { DevelopmentExecutionStep } from "./model";
import type { DevelopmentExecutionController } from "./use-development-execution";

interface DevelopmentExecutionPanelProps {
  open: boolean;
  projection: DevelopmentAnalysisProjection;
  controller: DevelopmentExecutionController;
  onClose: () => void;
  magnetEnabled: boolean;
  magnetStrength: number;
}

const statusLabel: Record<DevelopmentExecution["status"], string> = {
  previewed: "等待审批",
  applying: "正在隔离应用",
  applied: "已隔离应用",
  testing: "正在运行测试",
  tested: "测试通过",
  test_failed: "测试未通过",
  committing: "正在本地提交",
  committed: "本地提交完成",
  failed: "操作失败",
  rolled_back: "已回滚",
};

function shortDigest(value: string | null | undefined, length = 12) {
  return value ? value.slice(0, length) : "—";
}

function displayDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function canApply(execution: DevelopmentExecution) {
  return execution.status === "previewed" || execution.status === "failed";
}

function canRunTest(execution: DevelopmentExecution) {
  return ["applied", "tested", "test_failed"].includes(execution.status);
}

function canPrepareCommit(execution: DevelopmentExecution) {
  if (!canRunTest(execution)) return false;
  return !execution.testProfiles.length || execution.lastTest?.status === "passed";
}

function actionDigest(
  execution: DevelopmentExecution,
  step: DevelopmentExecutionStep,
  profile: DevelopmentTestProfile | undefined,
  commitApproval: string | undefined,
) {
  if (step === "apply") return execution.approvals.applySha256;
  if (step === "test") return profile?.planSha256 ?? "";
  if (step === "commit") return commitApproval ?? "";
  if (step === "rollback") return execution.approvals.rollbackSha256;
  return "";
}

function StatusPill({ execution }: { execution: DevelopmentExecution }) {
  const failure = ["failed", "test_failed"].includes(execution.status);
  const complete = ["tested", "committed", "rolled_back"].includes(execution.status);
  return (
    <em className={`development-execution-status development-execution-status--${failure ? "error" : complete ? "complete" : "active"}`}>
      {controllerBusyStatus(execution.status) ? <LoaderCircle size={12} className="spin" /> : complete ? <Check size={12} /> : <Clock3 size={12} />}
      {statusLabel[execution.status]}
    </em>
  );
}

function controllerBusyStatus(status: DevelopmentExecution["status"]) {
  return ["applying", "testing", "committing"].includes(status);
}

export function DevelopmentExecutionPanel({
  open,
  projection,
  controller,
  onClose,
  magnetEnabled,
  magnetStrength,
}: DevelopmentExecutionPanelProps) {
  const [unifiedDiff, setUnifiedDiff] = useState("");
  const [selectedStep, setSelectedStep] = useState<DevelopmentExecutionStep>("review");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [confirmedDigest, setConfirmedDigest] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const execution = controller.execution;
  const selectedProfile = useMemo(
    () => execution?.testProfiles.find((profile) => profile.id === selectedProfileId)
      ?? execution?.testProfiles[0],
    [execution, selectedProfileId],
  );
  const expectedDigest = execution
    ? actionDigest(
        execution,
        selectedStep,
        selectedProfile,
        controller.commitPreview?.approvalSha256,
      )
    : "";
  const confirmed = Boolean(expectedDigest) && confirmedDigest === expectedDigest;

  useEffect(() => {
    setUnifiedDiff("");
    setSelectedStep("review");
    setSelectedProfileId("");
    setCommitMessage("");
    setConfirmedDigest("");
  }, [projection]);

  useEffect(() => {
    if (!execution) return;
    if (
      selectedProfileId &&
      execution.testProfiles.some((profile) => profile.id === selectedProfileId)
    ) return;
    setSelectedProfileId(execution.testProfiles[0]?.id ?? "");
  }, [execution, selectedProfileId]);

  useEffect(() => {
    setConfirmedDigest("");
  }, [execution?.previewSha256, execution?.approvals.rollbackSha256, expectedDigest]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    void controller.refresh();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [controller.refresh, open]);

  useEffect(() => {
    if (!execution) return;
    if (execution.status === "previewed") setSelectedStep("review");
    else if (execution.status === "applied") {
      setSelectedStep(execution.testProfiles.length ? "test" : "commit");
    } else if (["tested", "test_failed"].includes(execution.status)) setSelectedStep("test");
    else if (execution.status === "committed") setSelectedStep("commit");
    else if (execution.status === "rolled_back") setSelectedStep("rollback");
  }, [execution?.id, execution?.status]);

  if (!open) return null;

  async function preview() {
    const next = await controller.preview(unifiedDiff);
    if (next) setSelectedStep("review");
  }

  async function apply() {
    if (!execution || !confirmed) return;
    const next = await controller.apply(expectedDigest);
    if (next) setSelectedStep(next.testProfiles.length ? "test" : "commit");
  }

  async function runTest() {
    if (!selectedProfile || !confirmed) return;
    const next = await controller.runTest(selectedProfile, expectedDigest);
    if (next?.lastTest?.status === "passed") setSelectedStep("commit");
  }

  async function prepareCommit() {
    const next = await controller.previewCommit(commitMessage);
    if (next) setConfirmedDigest("");
  }

  async function commit() {
    if (!confirmed) return;
    const next = await controller.commit(expectedDigest);
    if (next) setSelectedStep("commit");
  }

  async function rollback() {
    if (!confirmed) return;
    const next = await controller.rollback(expectedDigest);
    if (next) setSelectedStep("rollback");
  }

  function selectStep(step: DevelopmentExecutionStep) {
    setSelectedStep(step);
    setConfirmedDigest("");
  }

  function newExecution() {
    controller.reset();
    setUnifiedDiff("");
    setSelectedStep("review");
    setCommitMessage("");
    setConfirmedDigest("");
  }

  return (
    <div
      className="development-execution-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !controller.busy) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="development-execution-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="development-execution-title"
      >
        <header className="development-execution-panel__header">
          <span className="development-execution-panel__icon"><GitBranch size={19} /></span>
          <span>
            <small>CONTROLLED LOCAL EXECUTION · PER ACTION APPROVAL</small>
            <strong id="development-execution-title">受控开发执行</strong>
          </span>
          {execution ? <StatusPill execution={execution} /> : null}
          <button type="button" onClick={() => void controller.refresh()} aria-label="刷新执行记录">
            <RefreshCw size={16} className={controller.connection === "loading" ? "spin" : ""} />
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭受控开发执行">
            <X size={17} />
          </button>
        </header>

        <div className="development-execution-assurance">
          <ShieldCheck size={16} />
          <span><strong>源 checkout 始终受保护</strong><small>写入只发生在本工具创建的隔离 branch / worktree；测试命令不可自定义；commit 不会 push。</small></span>
          <code>{projection.repository.revision.slice(0, 12)}</code>
        </div>

        {controller.error ? (
          <div className="development-execution-error" role="alert">
            <AlertTriangle size={15} />
            <span>{controller.error}</span>
            <button type="button" onClick={controller.clearError} aria-label="关闭执行错误"><X size={14} /></button>
          </div>
        ) : null}

        <div className="development-execution-panel__body" aria-busy={controller.busy}>
          <main className="development-execution-main">
            {execution ? (
              <>
                <section className="development-execution-summary">
                  <span><small>EXECUTION</small><code>{execution.id.slice(-12)}</code></span>
                  <span><small>BRANCH</small><code>{execution.branchName}</code></span>
                  <span><small>BASE</small><code>{shortDigest(execution.repository.baseRevision)}</code></span>
                  <span><small>PATCH</small><code>{shortDigest(execution.patchSha256)}</code></span>
                </section>
                <DevelopmentExecutionCanvas
                  execution={execution}
                  selectedStep={selectedStep}
                  onSelectStep={selectStep}
                  magnetEnabled={magnetEnabled}
                  magnetStrength={magnetStrength}
                />
                <section className="development-execution-detail">
                  <header>
                    <span>
                      {selectedStep === "review" ? <ClipboardCheck size={16} />
                        : selectedStep === "apply" ? <GitBranch size={16} />
                          : selectedStep === "test" ? <FlaskConical size={16} />
                            : selectedStep === "commit" ? <GitCommitHorizontal size={16} />
                              : selectedStep === "rollback" ? <RotateCcw size={16} />
                                : <ShieldCheck size={16} />}
                      <strong>{selectedStep === "review" ? "完整 Diff 审查"
                        : selectedStep === "apply" ? "隔离应用审批"
                          : selectedStep === "test" ? "白名单测试审批"
                            : selectedStep === "commit" ? "本地 Commit 审批"
                              : selectedStep === "rollback" ? "精确回滚审批"
                                : "Source checkout 不变量"}</strong>
                    </span>
                    <em>{selectedStep.toUpperCase()}</em>
                  </header>

                  {selectedStep === "review" ? (
                    <>
                      <div className="development-execution-file-grid">
                        {execution.files.map((file) => (
                          <article key={file.path}>
                            <FileCode2 size={14} />
                            <code>{file.path}</code>
                            <span>+{file.additions}</span><em>-{file.deletions}</em>
                          </article>
                        ))}
                      </div>
                      <pre className="development-execution-diff" tabIndex={0}>{execution.unifiedDiff ?? "列表仅包含脱敏元数据；点击记录后会从本机数据库读取完整 Diff。"}</pre>
                      <div className="development-execution-next">
                        <span><ShieldCheck size={14} /><b>此处只完成只读校验，尚未创建 branch 或 worktree。</b></span>
                        <button type="button" onClick={() => selectStep("apply")} disabled={!canApply(execution)}>进入 Apply 审批</button>
                      </div>
                    </>
                  ) : selectedStep === "apply" ? (
                    <>
                      <p className="development-execution-explainer">服务将从精确 base revision 创建 <code>{execution.branchName}</code>，并只允许上述 {execution.files.length} 个路径进入隔离 worktree。</p>
                      <ApprovalDigest label="APPLY APPROVAL SHA-256" value={execution.approvals.applySha256} />
                      <Confirmation
                        checked={confirmed}
                        disabled={!canApply(execution) || controller.busy}
                        onChange={(checked) => setConfirmedDigest(checked ? expectedDigest : "")}
                      >我已逐行检查完整 Diff，并确认在隔离 branch / worktree 中应用。</Confirmation>
                      <ActionButton busy={controller.phase === "applying"} disabled={!canApply(execution) || !confirmed || controller.busy} onClick={() => void apply()}>
                        创建隔离状态并应用
                      </ActionButton>
                    </>
                  ) : selectedStep === "test" ? (
                    <>
                      {execution.testProfiles.length ? (
                        <>
                          <label className="development-execution-field">
                            <span>服务端固定测试 Profile</span>
                            <select value={selectedProfile?.id ?? ""} onChange={(event) => {
                              setSelectedProfileId(event.target.value);
                              setConfirmedDigest("");
                            }} disabled={!canRunTest(execution) || controller.busy}>
                              {execution.testProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                            </select>
                          </label>
                          {selectedProfile ? (
                            <section className="development-execution-command">
                              <span><small>COMMAND</small><code>{selectedProfile.command}</code></span>
                              <span><small>WORKDIR</small><code>{selectedProfile.workingDirectory}</code></span>
                              <span><small>TIMEOUT</small><code>{selectedProfile.timeoutSeconds}s</code></span>
                            </section>
                          ) : null}
                          <ApprovalDigest label="TEST PLAN SHA-256" value={selectedProfile?.planSha256 ?? ""} />
                          <Confirmation
                            checked={confirmed}
                            disabled={!canRunTest(execution) || controller.busy}
                            onChange={(checked) => setConfirmedDigest(checked ? expectedDigest : "")}
                          >我确认执行上方固定命令；目标仓代码会在隔离 worktree 中运行。</Confirmation>
                          <ActionButton busy={controller.phase === "testing"} disabled={!canRunTest(execution) || !confirmed || controller.busy} onClick={() => void runTest()}>
                            运行所选测试
                          </ActionButton>
                        </>
                      ) : (
                        <p className="development-execution-explainer">服务未在仓库中识别到固定测试 Profile。本步骤不会运行任意命令，可直接进入 Commit 预览。</p>
                      )}
                      {execution.lastTest ? (
                        <section className={`development-execution-test-result development-execution-test-result--${execution.lastTest.status}`}>
                          <header><strong>{execution.lastTest.label}</strong><em>{execution.lastTest.status} · {execution.lastTest.durationMs} ms · exit {execution.lastTest.exitCode ?? "—"}</em></header>
                          {execution.lastTest.trackedSideEffects.length ? <p><AlertTriangle size={13} />检测到 tracked side effects：{execution.lastTest.trackedSideEffects.join(", ")}</p> : null}
                          <OutputBlock label="STDOUT" value={execution.lastTest.stdout} />
                          <OutputBlock label="STDERR" value={execution.lastTest.stderr} />
                        </section>
                      ) : null}
                    </>
                  ) : selectedStep === "commit" ? (
                    <>
                      {execution.commitSha ? (
                        <section className="development-execution-commit-complete">
                          <Check size={18} /><span><strong>本地 branch 已提交</strong><code>{execution.commitSha}</code><small>没有 push；源 checkout 未切换分支。</small></span>
                        </section>
                      ) : (
                        <>
                          <label className="development-execution-field">
                            <span>单行 Commit message</span>
                            <input value={commitMessage} maxLength={160} onChange={(event) => {
                              setCommitMessage(event.target.value.replace(/[\r\n]/g, " "));
                              controller.clearCommitPreview();
                              setConfirmedDigest("");
                            }} placeholder="feat: describe the reviewed change" disabled={!canPrepareCommit(execution) || controller.busy} />
                          </label>
                          <button className="development-execution-preview-button" type="button" onClick={() => void prepareCommit()} disabled={!canPrepareCommit(execution) || !commitMessage.trim() || controller.busy}>
                            {controller.phase === "commit-previewing" ? <LoaderCircle size={14} className="spin" /> : <ClipboardCheck size={14} />}
                            生成 Commit 审批预览
                          </button>
                          {controller.commitPreview ? (
                            <section className="development-execution-commit-preview">
                              <dl>
                                <div><dt>MESSAGE</dt><dd>{controller.commitPreview.message}</dd></div>
                                <div><dt>BRANCH</dt><dd><code>{controller.commitPreview.branchName}</code></dd></div>
                                <div><dt>STAGED DIFF</dt><dd><code>{controller.commitPreview.stagedDiffSha256}</code></dd></div>
                                <div><dt>PUSH</dt><dd><b>false</b></dd></div>
                              </dl>
                              <ApprovalDigest label="COMMIT APPROVAL SHA-256" value={controller.commitPreview.approvalSha256} />
                              <Confirmation
                                checked={confirmed}
                                disabled={controller.busy}
                                onChange={(checked) => setConfirmedDigest(checked ? expectedDigest : "")}
                              >我确认 message、branch 与 staged diff 摘要；仅创建本地 commit，不 push。</Confirmation>
                              <ActionButton busy={controller.phase === "committing"} disabled={!confirmed || controller.busy} onClick={() => void commit()}>
                                创建本地 Commit
                              </ActionButton>
                            </section>
                          ) : null}
                          {!canPrepareCommit(execution) && execution.testProfiles.length ? <p className="development-execution-blocked"><AlertTriangle size={14} />至少一个最近的白名单测试必须通过，才可生成 Commit 预览。</p> : null}
                        </>
                      )}
                    </>
                  ) : selectedStep === "rollback" ? (
                    <>
                      <p className="development-execution-explainer development-execution-explainer--danger">回滚只删除本工具拥有且未被外部推进的精确 branch / worktree。若分支已经在外部变化，服务会拒绝删除。</p>
                      <ApprovalDigest label="ROLLBACK APPROVAL SHA-256" value={execution.approvals.rollbackSha256} />
                      <Confirmation
                        checked={confirmed}
                        disabled={!execution.policy.rollbackAvailable || controller.busy}
                        onChange={(checked) => setConfirmedDigest(checked ? expectedDigest : "")}
                      >我确认删除本次执行生成的隔离状态；源 checkout 与其他分支不在删除范围内。</Confirmation>
                      <ActionButton danger busy={controller.phase === "rolling-back"} disabled={!execution.policy.rollbackAvailable || !confirmed || controller.busy} onClick={() => void rollback()}>
                        精确回滚生成状态
                      </ActionButton>
                    </>
                  ) : (
                    <section className="development-execution-source-invariant">
                      <ShieldCheck size={28} />
                      <span><strong>{execution.repository.path}</strong><p>HEAD 固定为 <code>{execution.repository.baseRevision}</code>；受控执行不会切换此 checkout、不会写文件、不会 push。</p></span>
                    </section>
                  )}
                  <ExecutionAudit execution={execution} />
                </section>
              </>
            ) : (
              <section className="development-execution-create">
                <header><ClipboardCheck size={20} /><span><small>STEP 01 · READ-ONLY VALIDATION</small><strong>粘贴并审查完整 unified diff</strong></span></header>
                <p>预览只使用临时 Git index 校验路径、base revision 和 patch 结构；不会创建 branch 或 worktree。完整 Diff 只进入本机执行数据库。</p>
                {projection.repository.dirty ? (
                  <div className="development-execution-blocked"><AlertTriangle size={15} />当前 source checkout 是 dirty 状态。V1 要求 clean HEAD，不能生成执行预览。</div>
                ) : null}
                <label className="development-execution-diff-input">
                  <span>完整 unified diff <em>{unifiedDiff.length.toLocaleString("zh-CN")} chars</em></span>
                  <textarea value={unifiedDiff} onChange={(event) => setUnifiedDiff(event.target.value)} spellCheck={false} placeholder={"diff --git a/path/to/file b/path/to/file\nindex ...\n--- a/path/to/file\n+++ b/path/to/file\n@@ ..."} />
                </label>
                <section className="development-execution-preview-contract">
                  <span><Check size={13} />最多 512 KiB / 12 个文本文件</span>
                  <span><Check size={13} />拒绝删除、重命名、二进制与越界路径</span>
                  <span><Check size={13} />revision 必须精确匹配 clean HEAD</span>
                </section>
                <button type="button" className="development-execution-primary" onClick={() => void preview()} disabled={!unifiedDiff.trim() || projection.repository.dirty || controller.busy || controller.connection === "disabled"}>
                  {controller.phase === "previewing" ? <LoaderCircle size={15} className="spin" /> : <ClipboardCheck size={15} />}
                  生成只读执行预览
                </button>
              </section>
            )}
          </main>

          <aside className="development-execution-history">
            <header>
              <span><History size={15} /><strong>本机执行记录</strong></span>
              <em>{controller.executions.length}{controller.total > controller.executions.length ? ` / ${controller.total}` : ""}</em>
            </header>
            <button type="button" className="development-execution-new" onClick={newExecution} disabled={controller.busy}>
              <Plus size={14} />新建执行预览
            </button>
            <div className="development-execution-history__list">
              {controller.connection === "loading" && !controller.executions.length ? (
                <p className="development-execution-history__empty"><LoaderCircle size={18} className="spin" />正在读取本机索引</p>
              ) : controller.connection === "offline" && !controller.executions.length ? (
                <p className="development-execution-history__empty"><AlertTriangle size={18} />本地服务未连接</p>
              ) : !controller.executions.length ? (
                <p className="development-execution-history__empty"><History size={20} />还没有执行记录</p>
              ) : controller.executions.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === execution?.id ? "development-execution-history-item development-execution-history-item--active" : "development-execution-history-item"}
                  onClick={() => void controller.load(item.id)}
                  disabled={controller.busy}
                >
                  <span><strong>{item.repository.name}</strong><em>{statusLabel[item.status]}</em></span>
                  <code>{item.branchName}</code>
                  <small>{displayDate(item.updatedAtMs)} · {item.statistics.files} files · {shortDigest(item.patchSha256, 8)}</small>
                </button>
              ))}
            </div>
            <section className="development-execution-history__policy">
              <ShieldCheck size={14} />
              <span><strong>LOCAL ONLY</strong><small>Diff、测试输出和审批事件存于本机 SQLite，不进入 Git 日志或远程服务。</small></span>
            </section>
          </aside>
        </div>
      </aside>
    </div>
  );
}

function ApprovalDigest({ label, value }: { label: string; value: string }) {
  return (
    <section className="development-execution-digest">
      <span>{label}</span>
      <code>{value || "—"}</code>
    </section>
  );
}

function Confirmation({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={checked ? "development-execution-confirmation development-execution-confirmation--checked" : "development-execution-confirmation"}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="development-execution-confirmation__box">{checked ? <Check size={12} /> : null}</span>
      <span>{children}</span>
    </label>
  );
}

function ActionButton({
  busy,
  disabled,
  danger = false,
  onClick,
  children,
}: {
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={danger ? "development-execution-action development-execution-action--danger" : "development-execution-action"} disabled={disabled} onClick={onClick}>
      {busy ? <LoaderCircle size={15} className="spin" /> : danger ? <RotateCcw size={15} /> : <Check size={15} />}
      {busy ? "操作进行中…" : children}
    </button>
  );
}

function OutputBlock({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <details className="development-execution-output"><summary>{label}</summary><pre>{value}</pre></details>;
}

function ExecutionAudit({ execution }: { execution: DevelopmentExecution }) {
  const events = execution.events ?? [];
  if (!events.length) return null;
  return (
    <details className="development-execution-audit">
      <summary><History size={13} />本机执行事件 <em>{events.length}</em></summary>
      <div>
        {events.map((event) => (
          <article key={event.id}>
            <time>{new Intl.DateTimeFormat("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            }).format(new Date(event.timestampMs))}</time>
            <code>{event.action}</code>
            <strong>{event.outcome}</strong>
            <span>{event.detailCode}</span>
          </article>
        ))}
      </div>
    </details>
  );
}
