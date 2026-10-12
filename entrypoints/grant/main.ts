import { browser } from 'wxt/browser';

const ORIGINS = ['<all_urls>'];
const button = document.getElementById('grant') as HTMLButtonElement;
const status = document.getElementById('status')!;

function showGranted() {
  button.disabled = true;
  status.textContent = 'Access granted. Go back to the page and click “Download” again.';
}

void browser.permissions.contains({ origins: ORIGINS }).then((has) => has && showGranted());

button.addEventListener('click', async () => {
  // Must be called directly from the click handler (user gesture).
  const granted = await browser.permissions.request({ origins: ORIGINS });
  if (granted) showGranted();
  else status.textContent = 'Permission was not granted.';
});
