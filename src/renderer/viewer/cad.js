import { t } from '../../i18n/index.js';
import { showError } from '../shared/warn.js';

export async function pickCadDesign() {
  try {
    const file = await window.api.pickCadFile();
    if (file) {
      const { openFromTree } = await import('./center.js');
      await openFromTree(file);
    }
  } catch (err) {
    showError(err.message, t('cad.openFailed'), { mono: false });
  }
}

export async function launchCadEditor(file) {
  try {
    const result = await window.api.openCadFile(file);
    if (!result.ok) showError(result.error, t('cad.openFailed'), { mono: false });
  } catch (err) {
    showError(err.message, t('cad.openFailed'), { mono: false });
  }
}
