const CAMPAIGN_ROUTE = /^\/campaigns\/([^/]+)\/?$/u;

export function currentRoute() {
    const match = CAMPAIGN_ROUTE.exec(window.location.pathname);
    if (!match) return { view: 'list', search: window.location.search };
    try {
        return { view: 'campaign', slug: decodeURIComponent(match[1]) };
    } catch {
        return { view: 'list', search: '' };
    }
}

export function navigate(url, state = {}) {
    window.history.pushState(state, '', url);
    window.dispatchEvent(new Event('routechange'));
}

export function followLink(event, url, state) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(url, state);
}

export function replaceSearch(search) {
    const url = `${window.location.pathname}${search ? `?${search}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, '', url);
}

export function onRouteChange(listener) {
    window.addEventListener('popstate', listener);
    window.addEventListener('routechange', listener);
}
