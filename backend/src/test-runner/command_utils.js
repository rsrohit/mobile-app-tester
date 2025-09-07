const { cleanPageSource } = require('./page_utils');
const { findCorrectSelector } = require('../services/nlp_service');
const { saveCache } = require('./pom_cache');

/**
 * Extracts the core element name from a natural language step.
 * e.g., "Click on 'Login' button" -> "'Login' button"
 * @param {string} step - The natural language step.
 * @returns {string} The extracted element name or the original step.
 */
function extractElementName(step) {
    // First, look for text wrapped in asterisks, e.g. *element*.
    const asteriskMatch = step.match(/\*([^*]+)\*/);
    if (asteriskMatch && asteriskMatch[1]) {
        return asteriskMatch[1].trim();
    }

    // Finally, return the last word if no special delimiters are found.
    const words = step.trim().split(' ');
    return words[words.length - 1];
}

/**
 * Determines the locator strategy implied by a selector string.
 * @param {string} selector - The raw selector string.
 * @returns {string} The inferred strategy (e.g., 'accessibility-id').
 */
function determineLocatorStrategy(selector = '') {
    if (!selector) return 'unknown';
    if (selector.startsWith('~')) return 'accessibility-id';
    if (selector.includes(':id/') || selector.includes('resource-id')) return 'resource-id';
    if (selector.startsWith('//') || selector.startsWith('(')) return 'xpath';
    return 'unknown';
}

/**
 * Creates a robust element finder bound to a browser instance. Supports
 * multiple selector strategies and intelligently handles WebView contexts.
 * When a selector starts with "css=", the prefix is stripped and treated as a
 * CSS selector. In a WEBVIEW context, mobile-specific fallbacks are skipped
 * entirely and the raw selector is passed through to WebdriverIO allowing
 * native CSS/XPath queries.
 *
 * @param {object} browser - The WebdriverIO browser instance.
 * @returns {Function} findElement - Function that locates elements given a selector.
 */
function createFindElement(browser) {
    return async function findElement(selector) {
        if (!selector) throw new Error('Selector is null or undefined.');

        let context = '';
        try {
            context = await browser.getContext();
        } catch (e) {
            // getContext may not exist in non-mobile sessions; ignore.
        }
        const inWebView = context && context.startsWith('WEBVIEW');

        // Support explicit css= prefix regardless of context
        if (selector.toLowerCase().startsWith('css=')) {
            const cssSelector = selector.slice(4);
            const prefix = inWebView
                ? 'WEBVIEW context: using CSS selector'
                : 'Attempting to find by CSS selector';
            console.log(`${prefix}: ${cssSelector}`);
            return browser.$(cssSelector);
        }

        if (inWebView) {
            const strategy =
                selector.startsWith('//') || selector.startsWith('(')
                    ? 'XPath'
                    : 'CSS';
            console.log(
                `WEBVIEW context: using ${strategy} selector: ${selector}`,
            );
            return browser.$(selector);
        }

        if (selector.toLowerCase().startsWith('resource-id:')) {
            const resourceId = selector.substring(12);
            console.log(`Attempting to find by parsed Resource ID: ${resourceId}`);
            return await browser.$(`id:${resourceId}`);
        }
        if (selector.toLowerCase().startsWith('resource-id=')) {
            const resourceId = selector.substring(12);
            console.log(`Attempting to find by parsed Resource ID: ${resourceId}`);
            return await browser.$(`id:${resourceId}`);
        }
        if (selector.toLowerCase().startsWith('new uiselector')) {
            let sanitizedSelector = selector;
            const resourceIdMatch = selector.match(/resourceId\(([^)]+)\)/);
            if (resourceIdMatch && !resourceIdMatch[1].startsWith('"')) {
                sanitizedSelector = selector.replace(
                    resourceIdMatch[1],
                    `"${resourceIdMatch[1]}"`,
                );
            }
            console.log(`Attempting to find by UiSelector: ${sanitizedSelector}`);
            return await browser.$(`android=${sanitizedSelector}`);
        }
        if (selector.startsWith('~')) {
            console.log(`Attempting to find by Accessibility ID: ${selector}`);
            return await browser.$(selector);
        }
        if (selector.toLowerCase().startsWith('name=')) {
            const name = selector.substring(5);
            console.log(`Attempting to find by Name: ${name}`);
            return await browser.$(`~${name}`);
        }
        if (selector.toLowerCase().startsWith('label=')) {
            const label = selector.substring(6);
            console.log(`Attempting to find by Label: ${label}`);
            return await browser.$(`//*[@label="${label}"]`);
        }
        if (selector.includes(':id/')) {
            console.log(`Attempting to find by Resource ID: ${selector}`);
            return await browser.$(`id:${selector}`);
        }
        console.log(
            `Attempting to find by flexible XPath for text: "${selector}"`,
        );
        const lowered = selector.toLowerCase();
        const xpathSelector =
            `//*[contains(translate(@text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
            `or contains(translate(@content-desc, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
            `or contains(translate(@name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}") ` +
            `or contains(translate(@label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), "${lowered}")]`;
        return await browser.$(xpathSelector);
    };
}

/**
 * Helper function to execute a single command with robust selector strategies and self-healing.
 * @param {object} browser - The WebdriverIO browser instance.
 * @param {object} command - The command object to execute.
 * @param {string} aiService - The AI service to use for self-healing.
 * @param {object} appSelectorCache - The selector cache for the specific app being tested.
 * @param {string} currentPageName - The name of the current page for context-aware caching.
 * @param {string} originalStepText - The original raw text of the step.
 * @param {Function} findElement - The robust findElement helper function.
 */
async function executeCommand(
    browser,
    command,
    aiService,
    appSelectorCache,
    currentPageName,
    originalStepText,
    findElement,
) {
    // Normalize the command object in case the AI response is malformed
    const safeCommand = command || {};
    safeCommand.original_step = originalStepText;

    const performAction = async (element) => {
        if (safeCommand.command === 'click') {
            await element.click();
        } else if (safeCommand.command === 'setValue') {
            await element.setValue(safeCommand.value);
        }
    };

    // --- NEW, MORE ROBUST EXECUTION FLOW ---
    // Derive the locator strategy from the AI-provided selector. If the
    // AI omits a selector, fall back to "unknown" so the cache key is
    // consistently formed.
    const strategy = determineLocatorStrategy(safeCommand.selector || '');
    const elementName = extractElementName(safeCommand.original_step);
    const cacheKey = `${currentPageName} - ${elementName} - ${strategy}`;
    let element;
    let finalSelector;

    // 1. Try the cache first
    if (appSelectorCache[cacheKey]) {
        try {
            const cachedSelector = appSelectorCache[cacheKey];
            console.log(`Found cached selector for step "${cacheKey}": "${cachedSelector}"`);
            element = await findElement(cachedSelector);
            await element.waitForExist({ timeout: 5000 });
            console.log('Successfully found element using cached selector.');
            await performAction(element);
            return; // Success, end of function
        } catch (e) {
            console.log('Cached selector failed. Deleting it and trying AI.');
            delete appSelectorCache[cacheKey];
            saveCache();
        }
    }

    // 2. If cache fails or doesn't exist, try the AI's initial suggestion
    try {
        if (!safeCommand.selector) {
            // This will make it jump directly to the catch block for self-healing
            throw new Error('AI did not provide an initial selector.');
        }
        console.log(`Executing step with AI-provided selector: "${safeCommand.selector}"`);
        element = await findElement(safeCommand.selector);
        await element.waitForExist({ timeout: 10000 });
        console.log('Found element successfully with AI-provided selector.');
        finalSelector = safeCommand.selector;
    } catch (initialError) {
        // 3. If initial attempt fails, initiate self-healing
        console.log(`${initialError.message} Initiating self-healing protocol.`);
        try {
            const pageSource = await browser.getPageSource();
            const cleanedSourceForHealing = cleanPageSource(pageSource);
            let newSelector = await findCorrectSelector(
                safeCommand.original_step,
                cleanedSourceForHealing,
                aiService,
            );
            newSelector = newSelector.replace(/[`"']/g, '');

            console.log(
                `Self-healing: Retrying step with AI-suggested selector: "${newSelector}"`,
            );
            element = await findElement(newSelector);
            await element.waitForExist({ timeout: 10000 });

            console.log('Successfully found element with AI-healed selector.');
            finalSelector = newSelector;
        } catch (healingError) {
            console.error('Self-healing also failed.', healingError);
            throw new Error(
                `Could not find element for step: "${safeCommand.original_step}"`,
            );
        }
    }

    // 4. Perform action and save to cache
    await performAction(element);
    if (finalSelector) {
        const finalStrategy = determineLocatorStrategy(finalSelector);
        const finalCacheKey = `${currentPageName} - ${elementName} - ${finalStrategy}`;
        appSelectorCache[finalCacheKey] = finalSelector;
        saveCache();
    }
    await browser.pause(1000);
}

module.exports = {
    extractElementName,
    determineLocatorStrategy,
    executeCommand,
    createFindElement,
};
