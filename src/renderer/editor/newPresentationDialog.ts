import type { RemoteServerEntry } from '@shared/ipc.js';

export type NewPresentationChoice =
  | { kind: 'local' }
  | { kind: 'remote'; server: RemoteServerEntry; name: string };

/** Choose where a new deck lives before touching either filesystem. */
export function showNewPresentationDialog(
  servers: RemoteServerEntry[],
  currentServerId?: string | null,
): Promise<NewPresentationChoice | null> {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';
    const form = document.createElement('form');
    form.className = 'workflow-dialog new-presentation-dialog';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.setAttribute('aria-labelledby', 'new-presentation-title');
    const title = document.createElement('h2');
    title.id = 'new-presentation-title';
    title.textContent = 'New presentation';

    const locationField = document.createElement('label');
    locationField.className = 'field';
    const locationLabel = document.createElement('span');
    locationLabel.textContent = 'Create in';
    const location = document.createElement('select');
    location.name = 'location';
    location.add(new Option(navigator.platform.startsWith('Mac') ? 'This Mac' : 'This computer', ''));
    for (const server of servers) location.add(new Option(server.name, server.id));
    location.value = servers.some((server) => server.id === currentServerId) ? currentServerId! : '';
    locationField.append(locationLabel, location);

    const description = document.createElement('p');
    description.className = 'open-dialog-message';
    const nameField = document.createElement('label');
    nameField.className = 'field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = 'Presentation name';
    const name = document.createElement('input');
    name.type = 'text';
    name.name = 'name';
    name.placeholder = 'Untitled presentation';
    name.autocomplete = 'off';
    nameField.append(nameLabel, name);

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const create = document.createElement('button');
    create.type = 'submit';
    create.className = 'primary';
    actions.append(cancel, create);
    form.append(title, locationField, description, nameField, actions);
    overlay.append(form);
    document.body.append(overlay);

    let finished = false;
    const finish = (choice: NewPresentationChoice | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      returnFocus?.focus();
      resolve(choice);
    };
    const render = (): void => {
      const server = servers.find((server) => server.id === location.value);
      nameField.hidden = !server;
      name.disabled = !server;
      name.required = Boolean(server);
      description.textContent = server
        ? `Create on ${server.name} and download a copy for offline editing. The server must be reachable.`
        : 'Choose a folder on this computer in the next step.';
      create.textContent = server ? 'Create presentation' : 'Choose folder…';
      create.disabled = Boolean(server) && !name.value.trim();
    };
    location.addEventListener('change', () => {
      render();
      if (!name.disabled) name.focus();
    });
    name.addEventListener('input', render);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const server = servers.find((server) => server.id === location.value);
      if (!server) finish({ kind: 'local' });
      else if (name.value.trim()) finish({ kind: 'remote', server, name: name.value.trim() });
    });
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      } else if (event.key === 'Tab') {
        const fields = [...form.querySelectorAll<HTMLElement>('select, input:not(:disabled), button:not(:disabled)')];
        const first = fields[0];
        const last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
    render();
    if (name.disabled) location.focus();
    else name.focus();
  });
}
