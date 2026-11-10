import type { PresentationHistoryHost } from '../editor/presentationHistory.js';
import type { PresentationGitResponse } from '@shared/presentationGit.js';
export function webHistoryHost(deckId: string): PresentationHistoryHost {
  return {
    request: async (command) => {
      const response = await fetch(`/api/git?deck=${encodeURIComponent(deckId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
      });
      const body = await response.json() as PresentationGitResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `History request failed (${response.status})`);
      return body;
    },
    openDeck: (id) => { location.href = `/?deck=${encodeURIComponent(id)}`; },
    openPdf: (revision) => { window.open(`/api/git/pdf?deck=${encodeURIComponent(deckId)}&revision=${encodeURIComponent(revision)}`, '_blank', 'noopener'); },
  };
}
