export const CHANGE_SCHEMA_VERSION = "1.0.0" as const;

export type GitChangeMode = "working-tree" | "compare" | "github-pr";

export type LocalGitChangeMode = Exclude<GitChangeMode, "github-pr">;

export type GitFileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked";

export interface GitChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface GitChangedFile {
  id: string;
  path: string;
  previousPath?: string;
  status: GitFileChangeStatus;
  statusCode: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  binary: boolean;
  patchAvailable?: boolean;
  additions: number | null;
  deletions: number | null;
  hunks: readonly GitChangeHunk[];
}

export interface GitRevisionReference {
  requested: string;
  resolved: string | null;
}

export interface GitChangeComparison {
  mode: GitChangeMode;
  base: GitRevisionReference;
  head: GitRevisionReference;
  mergeBase: string | null;
}

export interface GitChangeStatistics {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  truncated: boolean;
}

export interface GitChangeSet {
  comparison: GitChangeComparison;
  files: readonly GitChangedFile[];
  statistics: GitChangeStatistics;
  warnings: readonly string[];
}

export interface GitChangeSourceDefinition {
  id: string;
  label: string;
  description: string;
  transport: "loopback-http";
  modes: readonly GitChangeMode[];
  readOnly: true;
  remoteFetch: boolean;
}

export interface RegisteredGitChangeSource extends GitChangeSourceDefinition {
  contributedBy: string;
}

export type NodeChangeImpactKind =
  | "direct"
  | "container"
  | "dependent"
  | "file";

export interface NodeChangeImpact {
  id: string;
  nodeId: string;
  fileId: string;
  kind: NodeChangeImpactKind;
  confidence: "exact" | "inferred";
  hunkIndexes: readonly number[];
  reason: string;
}
