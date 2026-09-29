// Copy button on the one-time API key reveal page (server-rendered admin
// template, no framework owns these nodes).
(function () {
  const button = document.getElementById('copy-api-key');
  const field = document.getElementById('new-api-key');
  if (!button || !field) return;

  const flash = (label) => {
    button.textContent = label;
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  };

  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      flash('Copied ✓');
    } catch {
      // The async Clipboard API can be refused (permissions policy, insecure
      // context); the legacy selection-based copy still works in those cases.
      field.select();
      flash(document.execCommand('copy') ? 'Copied ✓' : 'Press Ctrl/⌘+C');
    }
  });
})();
