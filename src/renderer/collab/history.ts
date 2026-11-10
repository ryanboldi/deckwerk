import '../appChrome.css';
import '../editor/editor.css';
import './collab.css';
import '../lightTheme.css';
import { applyUiTheme } from '../uiTheme.js';
import { showPresentationHistory } from '../editor/presentationHistory.js';
import { webHistoryHost } from './presentationHistoryApi.js';
applyUiTheme();
const deckId = new URLSearchParams(location.search).get('deck');
const button = document.getElementById('history')!;
if (deckId) {
  (document.getElementById('back') as HTMLAnchorElement).href = `/?deck=${encodeURIComponent(deckId)}`;
  button.addEventListener('click', () => showPresentationHistory(webHistoryHost(deckId)));
  button.click();
} else button.textContent = 'Choose a presentation first';
