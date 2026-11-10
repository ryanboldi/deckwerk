# Presentation branches

Open a server presentation and choose **Branches** (or **File → Branches** on a narrow screen). The server picker has the same button beside each presentation. `/history.html?deck=<name>` opens its graph directly from another device.

Each branch is an ordinary presentation folder with its own slides, media and agent instructions. Forks share slide IDs and Git ancestry. Editing a fork never edits the base. A fork starts private to its creator, even when the original was shared.

1. Open your base presentation. Enter a checkpoint message and click **Checkpoint**.
2. Select that checkpoint, enter a branch name such as `VPO-Jane-Street`, and click **Fork here**. The new presentation opens immediately.
3. Edit each presentation normally. Once history is initialized, the server saves changed tracked presentations as an automatic checkpoint every minute. Named checkpoints mark meaningful changes. An unchanged deck creates no commit.
4. To bring base changes into an audience talk, open the audience talk's Branches dialog. Choose **Merge**, enter the base branch name, then **Preview operation**. This imports committed changes. Checkpoint source edits first if necessary.
5. Review the slide and file changes, resolve conflicts, then apply. A recovery point is saved before files change. Another edit after preview makes the preview stale and requires reviewing again.

The graph shows up to 150 recent commits, branch tips, and merge parents. Each branch and selected checkpoint has a PDF link. PDFs render lazily from immutable Git snapshots, use the final build of each visible slide, and are cached by commit hash. Opening the same hash always returns the same PDF, even after the presentation changes. A tag such as `ready-to-present` pins a checkpoint. Download that PDF before travelling or presenting.

## Git operations

- **Checkpoint / log / diff:** save all presentation content, browse ancestry, compare a checkpoint to the working copy. There is no staging area in the editor.
- **Fork:** create another presentation from a checkpoint. Opening that deck is the equivalent of checkout; another branch's working files stay in its own folder.
- **Merge:** three-way merge, recording both parents. Separate object changes on a slide can merge automatically. Conflicting slides, order, settings, theme, or other files require a choice. The audience presentation keeps its name.
- **Cherry-pick / revert:** import or undo a single checkpoint's changes. Initial and merge commits are refused because they need an explicit parent choice.
- **Rebase:** replay linear commits onto another branch, with a preview at each step. The live branch changes only after the final step. Cancel leaves it unchanged. Ranges containing merge commits are refused; merge those branches instead.
- **Reset:** move this branch to a selected checkpoint and replace working content. **Restore** appends a new checkpoint containing the selected content, preserving ancestry. Both save the previous head and uncommitted files under Recovery points.
- **Stash / apply stash:** save uncommitted work and return to the current checkpoint, then merge that saved work back later. A conflicting stash is retained until it is successfully applied.
- **Tags:** immutable names for checkpoints. Recovery points and stashes also appear in the source selector.

This is a presentation workflow backed by Git. It does not expose arbitrary shell commands, GitHub push, remote configuration, interactive rebase, force push, or a full staging UI. The existing Mac/server synchronization continues to handle online and offline edits. Branch operations need a connection to the server. They are private to the presentation owner; sharing a deck does not share its private history.

## Agents and the command line

Use `scripts/presentation-git.mjs` against the same API. Set `DECKWERK_SERVER` and `DECKWERK_DECK`, or pass `--server` and `--deck`.

```sh
node scripts/presentation-git.mjs --server http://127.0.0.1:5800 --deck VPO-base commit -m 'Reviewed base'
node scripts/presentation-git.mjs --server http://127.0.0.1:5800 --deck VPO-base branch VPO-Jane-Street
node scripts/presentation-git.mjs --server http://127.0.0.1:5800 --deck VPO-Jane-Street merge VPO-base
# Inspect the preview. Apply its token explicitly; supply --choices for conflicts.
node scripts/presentation-git.mjs --server http://127.0.0.1:5800 --deck VPO-Jane-Street apply TOKEN
```

Agents should checkpoint before and after a named task, edit only the requested branch, and follow its inherited `AGENTS.md`. History provides recovery, not a visual quality judgment. Keep the slide validation and rendered review requirements in those instructions. Checkpointing does not mean a slide has passed review. Forking copies instructions but does not create a T3 thread or assign a new remote workspace automatically.

## Storage and recovery

`<presentation-root>/.deckwerk-git/repo.git` is the private bare object database. `branches.json` maps opaque Git branch IDs to presentation folders; `.deckwerk-branch.json` in each folder preserves identity when that folder is renamed. Back up the complete root, including these dotfiles. If the presentation root is also a Git repository, exclude `.deckwerk-git/` from that outer repository; a filesystem backup must still include it.

History includes slides, themes, media and ordinary project files. It excludes dotfiles, runtime edit logs, `edit/`, access permissions and agent chat logs. Recovery never changes access permissions. Do not run Git reset/checkout directly on the internal database or remove recovery refs: the live collaboration session must apply content through the history API. Ordinary read-only Git commands can inspect the database.
