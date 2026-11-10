import type { GitAction, GitPreview, PresentationGitRequest, PresentationGitResponse, PresentationGraph } from '@shared/presentationGit.js';
import type { MergeChoices, MergeItem } from '@shared/deckMerge.js';
import { DelayedOperationProgress } from './operationProgress.js';
import './presentationHistory.css';

export interface PresentationHistoryHost {
  request(command: PresentationGitRequest): Promise<PresentationGitResponse>;
  openDeck(deckId: string): Promise<void> | void;
  openPdf(revision: string): Promise<void> | void;
}
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const labelInput = (label: string, input: HTMLElement): HTMLLabelElement => {
  const field = element('label', undefined, 'field'); field.append(element('span', label), input); return field;
};

/** Shared by the native editor and the server's history page. No filesystem access in the UI. */
export function showPresentationHistory(host: PresentationHistoryHost): void {
  const returnFocus = document.activeElement as HTMLElement | null;
  const overlay = element('div', undefined, 'workflow-overlay');
  const dialog = element('section', undefined, 'workflow-dialog presentation-history');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Presentation branches');
  const heading = element('h2', 'Branches and checkpoints');
  const status = element('p', '', 'open-dialog-message'); status.setAttribute('role', 'status');
  const content = element('div', undefined, 'presentation-history-content');
  const footer = element('div', undefined, 'workflow-actions');
  const close = element('button', 'Close'); close.type = 'button';
  footer.append(close); dialog.append(heading, status, content, footer); overlay.append(dialog); document.body.append(overlay);
  let graph: PresentationGraph;
  let selected = '';
  let activePreview: GitPreview | null = null;
  let busy = false;
  const progress = new DelayedOperationProgress(({ message, busy: waiting }) => { status.textContent = message; status.classList.toggle('busy', waiting); });
  async function run(message: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true; dialog.setAttribute('aria-busy', 'true');
    const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('button,input,select')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    status.textContent = '';
    const operation = progress.begin(message);
    try { await work(); operation.finish(); }
    catch (error) { operation.finish(); status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      busy = false; dialog.removeAttribute('aria-busy');
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      close.disabled = false;
    }
  }
  function button(text: string, action: () => Promise<void> | void, primary = false): HTMLButtonElement {
    const result = element('button', text, primary ? 'primary' : undefined); result.type = 'button';
    result.addEventListener('click', () => { void run(`${text}…`, async () => { await action(); }); }); return result;
  }
  async function refresh(): Promise<void> {
    const result = await host.request({ command: 'status' });
    if (!('graph' in result)) throw new Error('The server did not return presentation history');
    graph = result.graph;
    if (!graph.commits.some((commit) => commit.id === selected)) selected = graph.branch.head;
    activePreview = null; render();
  }
  async function finish(): Promise<void> {
    if (busy) return;
    if (activePreview) {
      try { await host.request({ command: 'abort', token: activePreview.token }); } catch { /* expires on the server */ }
    }
    overlay.remove(); returnFocus?.focus();
  }
  close.addEventListener('click', () => { void finish(); });
  overlay.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); void finish(); }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  function render(): void {
    heading.textContent = `${graph.branch.name}: branches and checkpoints`;
    content.replaceChildren();
    const lead = element('p', graph.dirty ? `${graph.changedFiles.length} changed files since the last checkpoint.` : 'All changes are checkpointed.');
    const checkpoint = element('input'); checkpoint.placeholder = 'What changed?'; checkpoint.setAttribute('aria-label', 'Checkpoint message'); checkpoint.maxLength = 200;
    const commit = button('Checkpoint', async () => {
      if (!checkpoint.value.trim()) throw new Error('Describe the checkpoint first');
      await host.request({ command: 'commit', message: checkpoint.value.trim() }); selected = ''; await refresh();
    }, true);
    const commitRow = element('div', undefined, 'history-control-row'); commitRow.append(labelInput('Checkpoint message', checkpoint), commit, button('Refresh', refresh));
    content.append(lead, commitRow);
    const branches = element('div', undefined, 'history-branches');
    for (const branch of graph.branches) {
      const row = element('div', undefined, 'history-branch');
      row.append(element('strong', branch.name), element('code', branch.head.slice(0, 8)));
      row.append(button(branch.id === graph.branch.id ? 'Current presentation' : 'Open presentation', async () => { await host.openDeck(branch.deckId); overlay.remove(); }));
      row.append(button('PDF', () => host.openPdf(branch.head)));
      branches.append(row);
    }
    content.append(branches);
    const columns = element('div', undefined, 'history-columns');
    const log = element('div', undefined, 'history-graph'); log.setAttribute('aria-label', 'Commit graph');
    const laneByCommit = new Map<string, number>();
    let nextLane = 0;
    const rows = new Map(graph.commits.map((commit, index) => [commit.id, index]));
    for (const branch of graph.branches) if (!laneByCommit.has(branch.head)) laneByCommit.set(branch.head, nextLane++);
    for (const commit of graph.commits) {
      if (!laneByCommit.has(commit.id)) laneByCommit.set(commit.id, nextLane++);
      commit.parents.forEach((parent, index) => { if (!laneByCommit.has(parent)) laneByCommit.set(parent, index === 0 ? laneByCommit.get(commit.id)! : nextLane++); });
    }
    const laneWidth = Math.max(40, nextLane * 18 + 16);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(laneWidth)); svg.setAttribute('height', String(graph.commits.length * 54)); svg.setAttribute('aria-hidden', 'true');
    for (const [index, commit] of graph.commits.entries()) {
      const x = 10 + laneByCommit.get(commit.id)! * 18, y = index * 54 + 27;
      for (const parent of commit.parents) {
        const row = rows.get(parent); if (row === undefined) continue;
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', `M ${x} ${y} C ${x} ${y + 27}, ${10 + laneByCommit.get(parent)! * 18} ${row * 54}, ${10 + laneByCommit.get(parent)! * 18} ${row * 54 + 27}`);
        path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); svg.append(path);
      }
      const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', commit.id === selected ? '5' : '3'); dot.setAttribute('fill', 'currentColor'); svg.append(dot);
    }
    const timeline = element('div', undefined, 'history-commits');
    for (const commit of graph.commits) {
      const names = graph.branches.filter((branch) => branch.head === commit.id).map((branch) => branch.name);
      const row = element('button', undefined, commit.id === selected ? 'selected' : ''); row.type = 'button';
      row.append(element('span', `${names.length ? names.join(', ') + ' · ' : ''}${commit.message}`), element('small', `${commit.id.slice(0, 8)} · ${new Date(commit.date).toLocaleString()}`));
      row.addEventListener('click', () => { selected = commit.id; render(); }); timeline.append(row);
    }
    log.append(svg, timeline);
    const actions = element('div', undefined, 'history-details');
    const selectedCommit = graph.commits.find((commit) => commit.id === selected)!;
    actions.append(element('h3', selectedCommit.message), element('code', selected.slice(0, 12)), element('p', `${selectedCommit.author} · ${new Date(selectedCommit.date).toLocaleString()}`));
    const selectedActions = element('div', undefined, 'history-control-row');
    selectedActions.append(button('Open PDF', () => host.openPdf(selected)), button('Compare with working copy', async () => {
      const response = await host.request({ command: 'diff', revision: selected });
      if ('preview' in response) renderPreview(response.preview, true);
    })); actions.append(selectedActions);
    const name = element('input'); name.placeholder = 'VPO-Jane-Street'; name.maxLength = 100;
    const forkRow = element('div', undefined, 'history-control-row');
    forkRow.append(labelInput('New branch name', name), button('Fork here', async () => {
      if (!name.value.trim()) throw new Error('Enter a name for the new presentation');
      const response = await host.request({ command: 'branch', name: name.value.trim(), revision: selected });
      if ('deckId' in response) { await host.openDeck(response.deckId); overlay.remove(); }
    })); actions.append(forkRow, element('small', 'Fork uses the selected checkpoint. Checkpoint current edits first if you want to include them.'));
    const tag = element('input'); tag.placeholder = 'ready-to-present'; tag.maxLength = 100;
    const tagRow = element('div', undefined, 'history-control-row'); tagRow.append(labelInput('Tag', tag), button('Tag checkpoint', async () => { await host.request({ command: 'tag', name: tag.value.trim(), revision: selected }); await refresh(); })); actions.append(tagRow);
    const operation = element('select');
    const operations: Array<[GitAction, string]> = [['merge', 'Merge into this presentation'], ['cherry-pick', 'Cherry-pick checkpoint'], ['revert', 'Revert checkpoint'], ['rebase', 'Rebase onto branch / checkpoint'], ['reset', 'Reset branch to checkpoint'], ['restore', 'Restore as a new checkpoint'], ['stash', 'Stash current edits'], ['stash-pop', 'Apply saved stash']];
    for (const [value, title] of operations) operation.add(new Option(title, value));
    const revision = element('input'); revision.value = selected; revision.setAttribute('list', 'history-revisions');
    const revisions = element('datalist'); revisions.id = 'history-revisions';
    for (const branch of graph.branches) revisions.append(new Option(branch.name, branch.name));
    for (const ref of [...graph.tags, ...graph.recovery, ...graph.stashes]) revisions.append(new Option(ref.name, ref.name));
    operation.addEventListener('change', () => { revision.disabled = operation.value === 'stash'; if (operation.value === 'stash-pop') revision.value = graph.stashes.at(-1)?.name ?? ''; });
    actions.append(labelInput('Git operation', operation), labelInput('Source branch, checkpoint, tag, or recovery point', revision), revisions,
      button('Preview operation', async () => {
        const response = await host.request({ command: 'preview', action: operation.value as GitAction, revision: revision.disabled ? undefined : revision.value.trim() || undefined });
        if ('preview' in response) renderPreview(response.preview);
      }), element('p', 'Merge and cherry-pick import committed changes. Rebase and reset rewrite this branch. Applying an operation first saves a recovery point.'));
    for (const [title, refs] of [['Tags', graph.tags], ['Recovery points', graph.recovery], ['Stashes', graph.stashes]] as const) {
      if (!refs.length) continue;
      const details = element('details'); details.append(element('summary', `${title} (${refs.length})`));
      for (const ref of [...refs].reverse()) details.append(button(ref.name, () => { revision.value = ref.name; operation.value = title === 'Stashes' ? 'stash-pop' : 'restore'; revision.disabled = false; }));
      actions.append(details);
    }
    columns.append(log, actions); content.append(columns);
  }
  function renderPreview(preview: GitPreview, readOnly = false): void {
    activePreview = preview; content.replaceChildren();
    content.append(element('h3', readOnly ? 'Compare working copy and checkpoint' : preview.message));
    content.append(element('p', readOnly ? 'Left: current working copy. Right: selected checkpoint.' : `Review changes before applying. ${preview.steps > 1 ? `${preview.steps} rebase steps remain. ` : ''}A recovery point preserves the current files and history.`));
    const pdfs = element('div', undefined, 'history-control-row');
    pdfs.append(button('Current checkpoint PDF', () => host.openPdf(preview.target)), button('Source checkpoint PDF', () => host.openPdf(preview.source))); content.append(pdfs);
    const choices: MergeChoices = {};
    const files: Record<string, 'local' | 'remote'> = {};
    const apply = button(preview.steps > 1 ? 'Apply this rebase step' : 'Apply with recovery point', async () => {
      const response = await host.request({ command: 'apply', token: preview.token, choices, files });
      if ('preview' in response) renderPreview(response.preview);
      else { selected = ''; await refresh(); }
    }, true);
    const updateApply = (): void => { apply.disabled = preview.plan.items.some((item) => item.conflict && !choices[item.key]) || preview.fileConflicts.some((item) => !files[item.path]); };
    function choose(key: string, target: MergeChoices | Record<string, 'local' | 'remote'>, conflict: boolean): HTMLElement {
      const select = element('select'); select.setAttribute('aria-label', `Resolution for ${key}`);
      select.add(new Option(conflict ? 'Choose a version…' : 'Automatic', ''));
      select.add(new Option('Keep current', 'local')); select.add(new Option('Take source', 'remote'));
      select.addEventListener('change', () => { if (select.value) target[key] = select.value as 'local' | 'remote'; else delete target[key]; updateApply(); });
      return select;
    }
    function value(item: MergeItem, side: 'local' | 'remote'): unknown {
      const deck = preview.plan.input[side];
      if (item.kind === 'slide') return deck.slides.find((slide) => slide.id === item.slideId) ?? 'Deleted';
      if (item.kind === 'theme') return preview.plan.input[`${side}Theme`];
      if (item.kind === 'order') return deck.slides.map((slide) => slide.id);
      return Object.fromEntries(item.fields.map((field) => [field, (deck as unknown as Record<string, unknown>)[field]]));
    }
    for (const item of preview.plan.items) {
      const row = element('section', undefined, 'history-change');
      row.append(element('strong', item.kind === 'slide' ? item.title : item.kind), element('p', `${item.conflict ? 'Conflict: ' : ''}${item.detail}`));
      if (!readOnly && preview.action !== 'reset' && preview.action !== 'stash') row.append(choose(item.key, choices, item.conflict));
      const details = element('details'); details.append(element('summary', 'Inspect exact changes'));
      const sides = element('div', undefined, 'history-diff');
      for (const side of ['local', 'remote'] as const) { const pane = element('div'); pane.append(element('strong', side === 'local' ? 'Current' : 'Source'), element('pre', JSON.stringify(value(item, side), null, 2))); sides.append(pane); }
      details.append(sides); row.append(details); content.append(row);
    }
    const changed = element('details'); changed.append(element('summary', `${preview.files.length} files compared`), element('pre', preview.files.join('\n'))); content.append(changed);
    for (const conflict of preview.fileConflicts) { const row = element('div', undefined, 'history-change'); row.append(element('strong', `File conflict: ${conflict.path}`)); if (!readOnly) row.append(choose(conflict.path, files, true)); content.append(row); }
    const controls = element('div', undefined, 'workflow-actions');
    controls.append(button(readOnly ? 'Back' : 'Cancel preview', async () => { await host.request({ command: 'abort', token: preview.token }); await refresh(); }));
    if (!readOnly) { updateApply(); controls.append(apply); }
    content.append(controls);
  }
  void run('Loading presentation history…', refresh).then(() => close.focus());
}
