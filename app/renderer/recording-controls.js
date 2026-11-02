'use strict';

(() => {
  const pause = document.getElementById('pause');
  const finish = document.getElementById('finish');
  window.recordingControls.onState((state) => {
    const language = StepForgeI18n.resolveLanguage(state.language, state.systemLocales);
    const { t, tn } = StepForgeI18n.createTranslator(language, window.StepForgeLocales);
    document.documentElement.lang = language;
    document.documentElement.classList.toggle('dark', state.dark);
    document.getElementById('state').textContent = state.paused ? t('Paused') : t('Recording');
    document.getElementById('count').textContent = tn(state.count, '{count} step', '{count} steps');
    pause.textContent = state.paused ? t('Resume') : t('Pause');
    finish.textContent = t('Finish');
  });
  for (const [button, action] of [[pause, 'pause'], [finish, 'finish']]) {
    button.addEventListener('pointerdown', () => window.recordingControls.action('gesture'));
    button.addEventListener('click', () => window.recordingControls.action(action));
  }
})();
