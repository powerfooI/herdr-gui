export type FileExplorerEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  mtime_ms: number;
  hidden: boolean;
};

export type FileListResult = {
  root: string;
  path: string;
  entries: FileExplorerEntry[];
  truncated: boolean;
};

export type FilePreviewDecoded = {
  text: string | null;
  binary: boolean;
  mime_type?: string | null;
  image_data_url?: string;
};

export type FilePreviewResult = FilePreviewDecoded & {
  root: string;
  path: string;
  size: number;
  mtime_ms: number;
  truncated: boolean;
};

export type FileDownloadResult = {
  filename: string;
  path: string;
  size: number;
  body: BodyInit;
  contentType: string;
};

export type FileUploadResult = {
  path: string;
  size: number;
  overwritten: boolean;
};

export type FileDeleteResult = {
  path: string;
  type: FileExplorerEntry["type"];
};

export type FileResolution = {
  candidate: string;
  path: string;
};

export type GitDiffKind =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch";

export type GitDiffMode = "working" | "branch-main";

export type GitDiffEntry = {
  path: string;
  old_path?: string;
  kind: GitDiffKind;
  status: string;
  additions?: number;
  deletions?: number;
  generated?: boolean;
};

export type RunProcessWithCodeTimeout = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;
