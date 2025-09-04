const convert = require('xml-js');

/**
 * Reduces the size of the XML to avoid API request limits.
 * @param {string} xml - The raw XML page source from Appium.
 * @returns {string} A cleaned, smaller XML string.
 */
function cleanPageSource(xml) {
    try {
        const options = { compact: true, ignoreComment: true, spaces: 2 };
        const json = convert.xml2js(xml, options);

        // Recursive function to remove non-essential attributes from each node
        function cleanNode(node) {
            if (!node) return;
            // Retain both Android and iOS specific attributes so the AI
            // service has enough context to build reliable selectors.
            const attributesToKeep = [
                // --- Common / Android attributes ---
                'class',
                'resource-id',
                'content-desc',
                'text',
                'package',
                'checkable',
                'checked',
                'clickable',
                'enabled',
                'selected',
                // --- iOS attributes ---
                'name',
                'label',
                'value',
                'visible',
                'accessible',
                'type',
                'x',
                'y',
                'width',
                'height',
                'index',
            ];
            if (node._attributes) {
                const newAttributes = {};
                for (const key of attributesToKeep) {
                    if (node._attributes[key] !== undefined) {
                        newAttributes[key] = node._attributes[key];
                    }
                }
                node._attributes = newAttributes;
            }
            // Recurse through all children nodes
            for (const key in node) {
                if (key !== '_attributes' && key !== '_text') {
                    if (Array.isArray(node[key])) {
                        node[key].forEach(cleanNode);
                    } else if (typeof node[key] === 'object') {
                        cleanNode(node[key]);
                    }
                }
            }
        }
        cleanNode(json);
        return convert.js2xml(json, { compact: true, spaces: 2 });
    } catch (error) {
        console.error('Failed to clean XML page source, returning original.', error);
        return xml; // Fallback to the original XML if cleaning fails
    }
}

/**
 * Waits for any obvious loading indicators to disappear.  Many Android apps
 * display an indeterminate progress bar or spinner while fetching data.  If
 * these elements remain on the screen, capturing a page source too early can
 * return the loading overlay rather than the actual page.  This helper
 * attempts to locate a variety of common progress indicators and waits for
 * them to be removed from the UI.
 *
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {number} timeout - Maximum time to wait for indicators to disappear.
 */
async function waitForLoadingToDisappear(browser, platform = 'android', timeout = 15000) {
    /*
     * Waits for common loading spinners or progress indicators to disappear.
     * On Android, this looks for ProgressBar widgets and resource IDs containing
     * "progress" or "loading".  On iOS, it searches via the iOS class chain
     * for activity and progress indicators.  If the element exists, it
     * waits for it to disappear using the reverse option on waitForExist.
     */
    const start = Date.now();
    if ((platform || 'android').toLowerCase() === 'ios') {
        // iOS selectors via class chain
        const iosChains = [
            '**/XCUIElementTypeActivityIndicator',
            '**/XCUIElementTypeProgressIndicator',
        ];
        for (const chain of iosChains) {
            try {
                const element = await browser.$(`-ios class chain:${chain}`);
                if (await element.isExisting()) {
                    await element.waitForExist({
                        timeout: timeout - (Date.now() - start),
                        reverse: true,
                    });
                }
            } catch (err) {
                // If not found or invalid selector, ignore and continue
            }
        }
    } else {
        // Android selectors: widget class or resource/text contains progress/loading
        const selectors = [
            'android.widget.ProgressBar',
            '//*[contains(@resource-id, "progress")]',
            '//*[contains(@resource-id, "loading")]',
            '//*[contains(translate(@text, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "loading")]',
        ];
        for (const selector of selectors) {
            try {
                const element = await browser.$(selector);
                if (await element.isExisting()) {
                    await element.waitForExist({
                        timeout: timeout - (Date.now() - start),
                        reverse: true,
                    });
                }
            } catch (err) {
                // Ignore invalid selectors or not found errors
            }
        }
    }
}

/**
 * Waits for the UI to reach a steady state by polling the page source until it
 * stops changing.  Capturing a page source while the UI is still updating
 * (e.g. during animation or data binding) can lead to transient XML trees.
 * This function fetches the page source repeatedly and returns once two
 * consecutive snapshots are identical, or after a timeout.
 *
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {number} timeout - Maximum time to wait for stability.
 * @param {number} interval - Time in milliseconds between polls.
 * @returns {Promise<string>} The final page source.
 */
async function waitForPageStability(browser, timeout = 30000, interval = 1000) {
    //browser.pause(timeout); // Initial pause to allow any immediate changes
    let lastSource = null;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const currentSource = await browser.getPageSource();
        if (lastSource && currentSource === lastSource) {
            // The page source has not changed since the last poll; assume stable
            return currentSource;
        }
        lastSource = currentSource;
        await browser.pause(interval);
    }
    // Timeout reached; return the most recent source even if not stable
    return lastSource;
}

module.exports = {
    cleanPageSource,
    waitForLoadingToDisappear,
    waitForPageStability,
};

