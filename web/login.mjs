const button = document.querySelector('#google-sign-in');
const error = document.querySelector('#login-error');
const alertBox = document.querySelector('#login-alert');
const toastEl = document.querySelector('#toast');
let toastTimer;

function showToast(message) {
    if (!toastEl) return;
    window.clearTimeout(toastTimer);
    toastEl.innerHTML = `<svg class="icon icon-circle-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span>${message}</span>`;
    toastEl.hidden = false;
    toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 4000);
}

function setErrorMessage(msg) {
    if (error) error.textContent = msg || '';
    if (alertBox) alertBox.hidden = !msg;
    if (msg) showToast(msg);
}

button.addEventListener('click', async () => {
    button.disabled = true;
    setErrorMessage('');
    const originalText = button.querySelector('.btn-text')?.textContent;
    if (button.querySelector('.btn-text')) button.querySelector('.btn-text').textContent = 'Connecting to Google…';

    try {
        const response = await fetch('/auth/google', { method: 'POST' });
        if (!response.ok) {
            throw new Error(response.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Could not start sign-in. Try again.');
        }
        const { url } = await response.json();
        window.location.assign(url);
    } catch (failure) {
        setErrorMessage(failure.message);
        button.disabled = false;
        if (button.querySelector('.btn-text')) button.querySelector('.btn-text').textContent = originalText || 'Continue with Google';
    }
});
