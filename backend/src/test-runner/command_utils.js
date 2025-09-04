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
};
