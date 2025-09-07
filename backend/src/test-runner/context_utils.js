const DEFAULT_TIMEOUT = 10000;

/**
 * Switch to the first available WebView context.
 *
 * @param {object} browser - WebdriverIO browser instance.
 * @param {number} [timeout=DEFAULT_TIMEOUT] - How long to wait for a WebView.
 */
async function switchToWebview(browser, timeout = DEFAULT_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const contexts = await browser.getContexts();
            const webviewContext = contexts.find((ctx) => ctx && ctx.startsWith('WEBVIEW'));
            if (webviewContext) {
                const currentContext = await browser.getContext();
                if (currentContext !== webviewContext) {
                    console.log(`Switching to WebView context: ${webviewContext}`);
                    await browser.switchContext(webviewContext);
                } else {
                    console.log(`Already in WebView context: ${webviewContext}`);
                }
                return;
            }
        } catch (err) {
            console.log(`Error getting contexts: ${err.message}`);
        }
        await browser.pause(500);
    }
    throw new Error('WEBVIEW context not found within timeout');
}

/**
 * Switch back to the native app context.
 *
 * @param {object} browser - WebdriverIO browser instance.
 */
async function switchToNative(browser) {
    const currentContext = await browser.getContext();
    if (currentContext !== 'NATIVE_APP') {
        console.log('Switching to native context: NATIVE_APP');
        await browser.switchContext('NATIVE_APP');
    } else {
        console.log('Already in native context: NATIVE_APP');
    }
}

module.exports = {
    switchToWebview,
    switchToNative,
};
