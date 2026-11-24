import { hydrateIcons } from '/shared/icons.mjs';

const POLL_MS = 15_000;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

hydrateIcons();
playAnimation(document.querySelector('[data-animation]'));
showRequestedPath();
document.querySelector('[data-action="retry"]')?.addEventListener('click', retry);
if (document.body.dataset.kind === 'maintenance') waitForReturn();

function playAnimation(container) {
    if (!container) return;
    const start = () => {
        if (!window.lottie) return;
        const art = container.closest('.status-art');
        const player = window.lottie.loadAnimation({
            container, renderer: 'svg', loop: !reducedMotion.matches, autoplay: !reducedMotion.matches, path: container.dataset.animation,
            rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true },
        });
        player.addEventListener('DOMLoaded', () => {
            art.classList.add('ready');
            if (reducedMotion.matches) player.goToAndStop(player.totalFrames * 0.75, true);
        });
    };
    if (window.lottie) start();
    else document.querySelector('script[src="/vendor/lottie.js"]')?.addEventListener('load', start);
}

function showRequestedPath() {
    const target = document.getElementById('requested-path');
    if (target && !window.location.pathname.startsWith('/errors/')) target.textContent = window.location.pathname;
}

function waitForReturn() {
    if (window.location.pathname.startsWith('/errors/')) return;
    window.setInterval(async () => {
        const response = await fetch('/api/campaigns', { cache: 'no-store' }).catch(() => null);
        if (response?.ok) window.location.replace('/');
    }, POLL_MS);
}

function retry(event) {
    event.currentTarget.disabled = true;
    if (window.location.pathname.startsWith('/errors/')) window.location.assign('/');
    else window.location.reload();
}
