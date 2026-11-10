import type { MergeChoices, MergePlan } from './deckMerge.js';
import { z } from 'zod';

export type GitAction = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'reset' | 'restore' | 'stash' | 'stash-pop';
export interface PresentationBranch { id: string; family: string; deckId: string; name: string; head: string }
export interface PresentationCommit { id: string; parents: string[]; message: string; author: string; date: string }
export interface PresentationRef { name: string; commit: string }
export interface PresentationGraph {
  branch: PresentationBranch;
  branches: PresentationBranch[];
  commits: PresentationCommit[];
  tags: PresentationRef[];
  recovery: PresentationRef[];
  stashes: PresentationRef[];
  dirty: boolean;
  changedFiles: string[];
}
export interface GitFileConflict { path: string; ours: string | null; theirs: string | null }
export interface GitPreview {
  token: string;
  action: GitAction;
  target: string;
  source: string;
  message: string;
  plan: MergePlan;
  files: string[];
  fileConflicts: GitFileConflict[];
  steps: number;
}
export type PresentationGitRequest =
  | { command: 'status' | 'log' }
  | { command: 'commit'; message: string }
  | { command: 'branch'; name: string; revision?: string }
  | { command: 'tag'; name: string; revision?: string }
  | { command: 'preview'; action: GitAction; revision?: string }
  | { command: 'apply'; token: string; choices?: MergeChoices; files?: Record<string, 'local' | 'remote'> }
  | { command: 'abort'; token: string }
  | { command: 'diff'; revision: string };
export type PresentationGitResponse =
  | { graph: PresentationGraph }
  | { preview: GitPreview }
  | { deckId: string }
  | { ok: true; commit?: string };

const label = z.string().trim().min(1).max(200);
const side = z.enum(['local', 'remote']);
export const PresentationGitRequestSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('status') }), z.object({ command: z.literal('log') }),
  z.object({ command: z.literal('commit'), message: label }),
  z.object({ command: z.literal('branch'), name: label, revision: label.optional() }),
  z.object({ command: z.literal('tag'), name: label, revision: label.optional() }),
  z.object({ command: z.literal('preview'), action: z.enum(['merge', 'cherry-pick', 'revert', 'rebase', 'reset', 'restore', 'stash', 'stash-pop']), revision: label.optional() }),
  z.object({ command: z.literal('apply'), token: z.string().uuid(), choices: z.record(side).optional(), files: z.record(side).optional() }),
  z.object({ command: z.literal('abort'), token: z.string().uuid() }),
  z.object({ command: z.literal('diff'), revision: label }),
]);
